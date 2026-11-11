// Supabase Edge Function: import-kamervragen
//
// - Haalt nieuwe schriftelijke vragen (en later binnengekomen antwoorden) op uit
//   de open data van de Tweede Kamer.
// - Laat Claude een concept-beoordeling maken.
// - Slaat alles op als CONCEPT. Publiceren doet alleen een admin.
//
// Aanroepen:
//   * door een ingelogde admin vanaf admin.html (Authorization: Bearer <jwt>)
//   * door de dagelijkse cron-taak (header x-import-secret: <IMPORT_SECRET>)
//
// Body (JSON, optioneel): { "id": "<uuid>" }  -> alleen deze vraag opnieuw laten beoordelen
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import { documentTekst, naarKamervraag, recenteZaken, zaakOpId, type Kamervraag } from "./tweedekamer.ts";
import { beoordeel, type AiConcept } from "./beoordeel.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IMPORT_SECRET = Deno.env.get("IMPORT_SECRET") ?? "";
const MAX_AI = Number(Deno.env.get("MAX_AI_PER_RUN") ?? "3");     // max. AI-beoordelingen per run
const ZAKEN = Number(Deno.env.get("ZAKEN_PER_RUN") ?? "50");      // hoeveel recente zaken bekijken
const DAGEN = Number(Deno.env.get("IMPORT_DAGEN") ?? "30");       // hoe ver terug

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-import-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function gelijk(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function magImporteren(req: Request): Promise<boolean> {
  const geheim = req.headers.get("x-import-secret") ?? "";
  if (IMPORT_SECRET && gelijk(geheim, IMPORT_SECRET)) return true;
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const gebruiker = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await gebruiker.rpc("is_admin");
  return !error && data === true;
}

type Rij = Record<string, unknown> & { id: string; status: string };

/** Vul lege, door de admin te controleren velden met het AI-voorstel (alleen bij concepten). */
function voorinvullen(rij: Partial<Rij>, ai: AiConcept): Record<string, unknown> {
  const leeg = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  const uit: Record<string, unknown> = {};
  if (rij.status && rij.status !== "concept") return uit;
  if (leeg(rij.googlebaar) && ai.googlebaar !== null) uit.googlebaar = ai.googlebaar;
  if (leeg(rij.googlebaar_uitleg) && ai.googlebaar_uitleg) uit.googlebaar_uitleg = ai.googlebaar_uitleg;
  if (leeg(rij.bronnen) && ai.bronnen.length) uit.bronnen = ai.bronnen;
  if (leeg(rij.vragen_samenvatting) && ai.vragen_samenvatting) uit.vragen_samenvatting = ai.vragen_samenvatting;
  if (leeg(rij.antwoord_samenvatting) && ai.antwoord_samenvatting) uit.antwoord_samenvatting = ai.antwoord_samenvatting;
  if (leeg(rij.score) && ai.score !== null) uit.score = ai.score;
  if (leeg(rij.score_uitleg) && ai.score_uitleg) uit.score_uitleg = ai.score_uitleg;
  return uit;
}

async function tekstVan(doc: Kamervraag["vraagDoc"]): Promise<string | null> {
  if (!doc) return null;
  try { return await documentTekst(doc); } catch (e) { console.warn("tekst ophalen mislukt", doc.Id, e); return null; }
}

async function aiVoor(kv: { titel: string; nummer: string | null; datum: string | null; indieners: string[]; aan: string | null },
  vraagTekst: string | null, antwoordTekst: string | null): Promise<{ ai: AiConcept | null; fout: string | null }> {
  try {
    return { ai: await beoordeel({ ...kv, vraagTekst, antwoordTekst }), fout: null };
  } catch (e) {
    return { ai: null, fout: e instanceof Error ? e.message : String(e) };
  }
}

async function nieuweVraag(db: SupabaseClient, kv: Kamervraag) {
  const [vraagTekst, antwoordTekst] = await Promise.all([tekstVan(kv.vraagDoc), tekstVan(kv.antwoordDoc)]);
  const { ai, fout } = await aiVoor(kv, vraagTekst, antwoordTekst);
  const rij: Record<string, unknown> = {
    bron_id: kv.bron_id, nummer: kv.nummer, titel: kv.titel, indieners: kv.indieners, aan: kv.aan,
    datum: kv.datum, link: kv.link, vraag_tekst: vraagTekst, antwoord_tekst: antwoordTekst,
    antwoord_datum: antwoordTekst ? kv.antwoordDatum : null,
    status: "concept", ai_concept: ai, ai_fout: fout,
    ...(ai ? voorinvullen({ status: "concept" }, ai) : {}),
  };
  const { error } = await db.from("vragen").insert(rij);
  if (error) throw new Error(`${kv.nummer ?? kv.bron_id}: ${error.message}`);
}

async function antwoordBinnen(db: SupabaseClient, rij: Rij, kv: Kamervraag) {
  const antwoordTekst = await tekstVan(kv.antwoordDoc);
  if (!antwoordTekst) return false;
  const vraagTekst = (rij.vraag_tekst as string | null) ?? await tekstVan(kv.vraagDoc);
  const { ai, fout } = await aiVoor(kv, vraagTekst, antwoordTekst);
  const update: Record<string, unknown> = {
    antwoord_tekst: antwoordTekst, antwoord_datum: kv.antwoordDatum, vraag_tekst: vraagTekst,
    ai_concept: ai ?? rij.ai_concept, ai_fout: fout,
    herzien_nodig: rij.status === "gepubliceerd",
    ...(ai ? voorinvullen(rij, ai) : {}),
  };
  const { error } = await db.from("vragen").update(update).eq("id", rij.id);
  if (error) throw new Error(`${kv.nummer ?? kv.bron_id}: ${error.message}`);
  return true;
}

async function importeer(db: SupabaseClient) {
  const resultaat = { nieuw: 0, bijgewerkt: 0, overgeslagen: 0, fouten: [] as string[] };
  const kvs = (await recenteZaken(ZAKEN, DAGEN)).map(naarKamervraag);
  const ids = kvs.map((k) => k.bron_id);

  const { data: bestaand, error } = await db.from("vragen")
    .select("id,bron_id,status,vraag_tekst,antwoord_tekst,ai_concept,googlebaar,googlebaar_uitleg,bronnen,vragen_samenvatting,antwoord_samenvatting,score,score_uitleg")
    .in("bron_id", ids.length ? ids : ["-"]);
  if (error) throw error;
  const perBron = new Map((bestaand ?? []).map((r) => [r.bron_id as string, r as Rij]));

  // Ook oudere, nog onbeantwoorde vragen nalopen (antwoord komt vaak pas na weken).
  const { data: open } = await db.from("vragen")
    .select("id,bron_id,status,vraag_tekst,antwoord_tekst,ai_concept,googlebaar,googlebaar_uitleg,bronnen,vragen_samenvatting,antwoord_samenvatting,score,score_uitleg")
    .is("antwoord_tekst", null).neq("status", "afgewezen").not("bron_id", "is", null)
    .gte("datum", new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10))
    .order("datum", { ascending: true }).limit(20);
  for (const r of open ?? []) {
    if (perBron.has(r.bron_id as string)) continue;
    try {
      const z = await zaakOpId(r.bron_id as string);
      if (z) { kvs.push(naarKamervraag(z)); perBron.set(r.bron_id as string, r as Rij); }
    } catch (e) { console.warn("zaak ophalen mislukt", r.bron_id, e); }
  }

  const taken: Array<() => Promise<"nieuw" | "bijgewerkt" | null>> = [];
  for (const kv of kvs) {
    const rij = perBron.get(kv.bron_id);
    if (!rij) taken.push(async () => { await nieuweVraag(db, kv); return "nieuw"; });
    else if (!rij.antwoord_tekst && kv.antwoordDoc && rij.status !== "afgewezen") {
      taken.push(async () => (await antwoordBinnen(db, rij, kv)) ? "bijgewerkt" : null);
    }
  }
  resultaat.overgeslagen = Math.max(0, taken.length - MAX_AI);

  // Parallel, zodat de functie binnen de tijdslimiet van Supabase blijft.
  const uitkomsten = await Promise.allSettled(taken.slice(0, MAX_AI).map((t) => t()));
  for (const u of uitkomsten) {
    if (u.status === "rejected") resultaat.fouten.push(u.reason instanceof Error ? u.reason.message : String(u.reason));
    else if (u.value === "nieuw") resultaat.nieuw++;
    else if (u.value === "bijgewerkt") resultaat.bijgewerkt++;
  }
  return resultaat;
}

async function herbeoordeel(db: SupabaseClient, id: string) {
  const { data: rij, error } = await db.from("vragen").select("*").eq("id", id).single();
  if (error || !rij) throw new Error("Vraag niet gevonden");
  let vraagTekst = rij.vraag_tekst as string | null;
  let antwoordTekst = rij.antwoord_tekst as string | null;
  if ((!vraagTekst || !antwoordTekst) && rij.bron_id) {
    const z = await zaakOpId(rij.bron_id).catch(() => null);
    if (z) {
      const kv = naarKamervraag(z);
      vraagTekst ??= await tekstVan(kv.vraagDoc);
      antwoordTekst ??= await tekstVan(kv.antwoordDoc);
    }
  }
  const { ai, fout } = await aiVoor({
    titel: rij.titel, nummer: rij.nummer, datum: rij.datum, indieners: rij.indieners ?? [], aan: rij.aan,
  }, vraagTekst, antwoordTekst);
  const { error: e2 } = await db.from("vragen").update({
    vraag_tekst: vraagTekst, antwoord_tekst: antwoordTekst,
    ai_concept: ai ?? rij.ai_concept, ai_fout: fout,
  }).eq("id", id);
  if (e2) throw e2;
  return { nieuw: 0, bijgewerkt: ai ? 1 : 0, overgeslagen: 0, fouten: fout ? [fout] : [] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Alleen POST" }, 405);
  if (!(await magImporteren(req))) return json({ error: "Geen toegang" }, 401);

  const body = await req.json().catch(() => ({})) as { id?: string };
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  try {
    if (body.id) {
      if (!/^[0-9a-f-]{36}$/i.test(body.id)) return json({ error: "Ongeldig id" }, 400);
      return json(await herbeoordeel(db, body.id));
    }
    return json(await importeer(db));
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
