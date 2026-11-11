// AI-concept: Claude beoordeelt een Kamervraag. Het resultaat is alleen een
// voorstel; een admin controleert en publiceert.
import Anthropic from "npm:@anthropic-ai/sdk@1.2.0";

export interface AiConcept {
  googlebaar: boolean | null;
  googlebaar_uitleg: string;
  bronnen: { titel: string; url: string }[];
  vragen_samenvatting: string;
  antwoord_samenvatting: string | null;
  score: number | null;
  score_uitleg: string;
  model: string;
  beoordeeld_op: string;
}

export interface Invoer {
  titel: string;
  nummer: string | null;
  datum: string | null;
  indieners: string[];
  aan: string | null;
  vraagTekst: string | null;
  antwoordTekst: string | null;
}

const SYSTEEM = `Je beoordeelt schriftelijke Kamervragen van de Nederlandse Tweede Kamer voor een publieksquiz.
Je werk is een concept: een redacteur controleert alles voordat het gepubliceerd wordt. Wees dus feitelijk, kort en eerlijk over onzekerheid.

Je levert:
1. "googlebaar": was het antwoord op de kern van de vragen al openbaar online te vinden VÓÓR de datum waarop de vragen gesteld werden? Denk aan eerdere Kamervragen met antwoord, Kamerbrieven, rijksoverheid.nl, CBS, wetteksten, nieuwsberichten. Zoek dit na met de zoektool. Kun je het niet aantonen, kies dan false en zeg dat in de uitleg. Alleen true als je concrete bronnen vindt; geef die dan in "bronnen" (alleen URL's die je echt gevonden hebt, nooit verzonnen).
2. "vragen_samenvatting": 1 tot 3 zinnen, neutraal, wat de Kamerleden vragen.
3. "antwoord_samenvatting": alleen als de antwoordtekst is meegegeven: 1 tot 3 zinnen, neutraal, wat het kabinet antwoordt. Anders null.
4. "score" 1 tot 10: hoe sterk is de vraag als controle-instrument? Hoger als het kabinet erover gaat, de vraag beleid controleert en iets nieuws boven tafel haalt. Lager als hetzelfde al eerder gevraagd en beantwoord is, of als het antwoord gewoon online stond.
5. "score_uitleg": 1 tot 3 zinnen.

Wees strikt partijneutraal: beoordeel het soort vraag, nooit de politieke kleur, de indiener of het standpunt.
Schrijf in het Nederlands.

Antwoord als laatste met ALLEEN één JSON-object, zonder tekst eromheen, in deze vorm:
{"googlebaar": true|false, "googlebaar_uitleg": "...", "bronnen": [{"titel": "...", "url": "https://..."}], "vragen_samenvatting": "...", "antwoord_samenvatting": "..."|null, "score": 1-10, "score_uitleg": "..."}`;

function invoerTekst(i: Invoer): string {
  return [
    `Titel: ${i.titel}`,
    `Kamernummer: ${i.nummer ?? "onbekend"}`,
    `Datum gesteld: ${i.datum ?? "onbekend"}`,
    `Indieners: ${i.indieners.join(", ") || "onbekend"}`,
    `Gericht aan: ${i.aan ?? "onbekend"}`,
    "",
    "<vragen>",
    i.vraagTekst?.trim() || "(De volledige tekst van de vragen kon niet opgehaald worden; baseer je op de titel en zeg dat in de uitleg.)",
    "</vragen>",
    "",
    i.antwoordTekst ? `<antwoord>\n${i.antwoordTekst.trim()}\n</antwoord>` : "(Er is nog geen antwoord van het kabinet.)",
  ].join("\n");
}

function haalJson(tekst: string): Record<string, unknown> {
  const begin = tekst.indexOf("{");
  const eind = tekst.lastIndexOf("}");
  if (begin < 0 || eind <= begin) throw new Error("AI gaf geen JSON terug");
  return JSON.parse(tekst.slice(begin, eind + 1));
}

function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function beoordeel(i: Invoer): Promise<AiConcept> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY ontbreekt (zet hem als Supabase secret)");
  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  const client = new Anthropic({ apiKey });

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: invoerTekst(i) }];
  let laatste: Anthropic.Beta.BetaMessage | null = null;

  // pause_turn: de server pauzeert soms lange zoekbeurten; dan gaan we verder.
  for (let poging = 0; poging < 4; poging++) {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 16000,
      system: SYSTEEM,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6, user_location: { type: "approximate", country: "NL" } }],
      messages,
    });
    laatste = await stream.finalMessage();
    if (laatste.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: laatste.content as Anthropic.Beta.BetaContentBlockParam[] });
  }
  if (!laatste) throw new Error("Geen antwoord van AI");
  if (laatste.stop_reason === "refusal") throw new Error("AI weigerde deze vraag te beoordelen");
  if (laatste.stop_reason === "max_tokens") throw new Error("AI-antwoord was te lang en is afgebroken");

  // Laatste tekstblok(ken) bevatten de JSON
  const teksten = laatste.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  const j = haalJson(teksten.slice(-3).join("\n"));

  const bronnen = Array.isArray(j.bronnen) ? j.bronnen : [];
  const schoneBronnen: { titel: string; url: string }[] = [];
  for (const b of bronnen.slice(0, 8)) {
    const url = str((b as Record<string, unknown>)?.url, 500);
    try {
      const u = new URL(url);
      if (u.protocol === "https:" || u.protocol === "http:") {
        schoneBronnen.push({ titel: str((b as Record<string, unknown>)?.titel, 200) || u.hostname, url: u.href });
      }
    } catch { /* ongeldige URL overslaan */ }
  }
  const score = Number(j.score);

  return {
    googlebaar: typeof j.googlebaar === "boolean" ? j.googlebaar : null,
    googlebaar_uitleg: str(j.googlebaar_uitleg),
    bronnen: schoneBronnen,
    vragen_samenvatting: str(j.vragen_samenvatting),
    antwoord_samenvatting: i.antwoordTekst ? (str(j.antwoord_samenvatting) || null) : null,
    score: Number.isInteger(score) && score >= 1 && score <= 10 ? score : null,
    score_uitleg: str(j.score_uitleg),
    model: laatste.model ?? model,
    beoordeeld_op: new Date().toISOString(),
  };
}
