// Ophalen van schriftelijke vragen uit de open data van de Tweede Kamer
// (Gegevensmagazijn OData API, https://opendata.tweedekamer.nl).
import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";
import { extractText, getDocumentProxy } from "npm:unpdf@1.9.1";

const BASIS = "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0";
const MAX_TEKST = 120_000; // tekens; Kamervragen zijn bijna altijd veel korter

export interface TkActor {
  ActorNaam?: string;
  ActorFractie?: string | null;
  Functie?: string | null;
  Relatie?: string;
  Verwijderd?: boolean;
}
export interface TkDocument {
  Id: string;
  Soort?: string;
  DocumentNummer?: string;
  Titel?: string;
  Onderwerp?: string;
  Datum?: string;
  ContentType?: string;
  Verwijderd?: boolean;
}
export interface TkZaak {
  Id: string;
  Nummer?: string;
  Soort?: string;
  Titel?: string;
  Onderwerp?: string;
  GestartOp?: string;
  Verwijderd?: boolean;
  ZaakActor?: TkActor[];
  Document?: TkDocument[];
}

export interface Kamervraag {
  bron_id: string;
  nummer: string | null;
  titel: string;
  indieners: string[];
  aan: string | null;
  datum: string | null;
  link: string;
  vraagDoc: TkDocument | null;
  antwoordDoc: TkDocument | null;
  antwoordDatum: string | null;
}

async function haal(url: string): Promise<Response> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Tweede Kamer API gaf ${r.status} voor ${url}`);
  return r;
}

/** Recentste schriftelijke vragen (zaken), inclusief actoren en documenten. */
export async function recenteZaken(aantal: number, sindsDagen: number): Promise<TkZaak[]> {
  const sinds = new Date(Date.now() - sindsDagen * 86_400_000).toISOString();
  const params = new URLSearchParams({
    $filter: `Soort eq 'Schriftelijke vragen' and Verwijderd eq false and GestartOp ge ${sinds}`,
    $orderby: "GestartOp desc",
    $top: String(aantal),
    $expand: "ZaakActor,Document",
  });
  const r = await haal(`${BASIS}/Zaak?${params}`);
  const j = await r.json();
  return (j.value ?? []) as TkZaak[];
}

export async function zaakOpId(id: string): Promise<TkZaak | null> {
  const params = new URLSearchParams({ $expand: "ZaakActor,Document" });
  const r = await fetch(`${BASIS}/Zaak(${encodeURIComponent(id)})?${params}`, { headers: { Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Tweede Kamer API gaf ${r.status}`);
  return (await r.json()) as TkZaak;
}

function persoon(a: TkActor): string {
  const naam = (a.ActorNaam ?? "").trim();
  return a.ActorFractie ? `${naam} (${a.ActorFractie})` : naam;
}

export function naarKamervraag(z: TkZaak): Kamervraag {
  const actoren = (z.ZaakActor ?? []).filter((a) => !a.Verwijderd);
  const docs = (z.Document ?? []).filter((d) => !d.Verwijderd);
  const rel = (a: TkActor) => (a.Relatie ?? "").toLowerCase();

  const indieners = [
    ...actoren.filter((a) => rel(a) === "indiener"),
    ...actoren.filter((a) => rel(a) === "medeindiener"),
  ].map(persoon).filter(Boolean);
  const aan = actoren.filter((a) => rel(a).includes("gericht aan"))
    .map((a) => a.Functie || a.ActorNaam).filter(Boolean).join(", ") || null;

  const soort = (d: TkDocument) => (d.Soort ?? "").toLowerCase();
  const vraagDoc = docs.find((d) => soort(d) === "schriftelijke vragen") ?? null;
  const antwoordDoc = docs.find((d) => soort(d).startsWith("antwoord schriftelijke vragen")) ?? null;

  const nummer = z.Nummer ?? null;
  const link = nummer
    ? `https://www.tweedekamer.nl/kamerstukken/kamervragen/detail?id=${encodeURIComponent(nummer)}` +
      (vraagDoc?.DocumentNummer ? `&did=${encodeURIComponent(vraagDoc.DocumentNummer)}` : "")
    : "https://www.tweedekamer.nl/kamerstukken/kamervragen";

  return {
    bron_id: z.Id,
    nummer,
    titel: (z.Onderwerp || z.Titel || vraagDoc?.Onderwerp || "Schriftelijke vragen").trim(),
    indieners,
    aan,
    datum: (z.GestartOp ?? vraagDoc?.Datum ?? "").slice(0, 10) || null,
    link,
    vraagDoc,
    antwoordDoc,
    antwoordDatum: antwoordDoc?.Datum?.slice(0, 10) ?? null,
  };
}

/** Haalt de tekst van een document op (PDF, Word of platte tekst). */
export async function documentTekst(doc: TkDocument): Promise<string> {
  const r = await haal(`${BASIS}/Document(${encodeURIComponent(doc.Id)})/resource`);
  const type = (r.headers.get("content-type") ?? doc.ContentType ?? "").toLowerCase();
  const bytes = new Uint8Array(await r.arrayBuffer());
  let tekst: string;

  if (type.includes("pdf") || (bytes[0] === 0x25 && bytes[1] === 0x50)) { // %P(DF)
    const pdf = await getDocumentProxy(bytes);
    const res = await extractText(pdf, { mergePages: true });
    tekst = Array.isArray(res.text) ? res.text.join("\n") : res.text;
  } else if (type.includes("officedocument") || type.includes("msword") || (bytes[0] === 0x50 && bytes[1] === 0x4b)) { // PK (zip)
    const bestanden = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
    const xml = bestanden["word/document.xml"] ? strFromU8(bestanden["word/document.xml"]) : "";
    tekst = xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  } else {
    tekst = new TextDecoder().decode(bytes).replace(/<[^>]+>/g, " ");
  }

  tekst = tekst.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (tekst.length > MAX_TEKST) {
    tekst = tekst.slice(0, MAX_TEKST) + "\n\n[Tekst ingekort: het document was langer dan " + MAX_TEKST + " tekens.]";
  }
  return tekst;
}
