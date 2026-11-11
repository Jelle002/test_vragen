// Beheerpagina: inloggen (met optionele 2FA), concepten controleren en publiceren.
// De database controleert zelf of je admin bent (tabel admins + RLS); deze pagina
// is alleen de bediening.
(function () {
  "use strict";

  const cfg = window.KVQ_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const views = ["#v-login", "#v-mfa", "#v-lijst", "#v-edit"];
  const FUNCTIE = "import-kamervragen";

  let sb = null;
  let tab = "concept";
  let huidig = null; // de vraag die bewerkt wordt

  function view(id) { views.forEach((v) => ($(v).hidden = v !== id)); }
  function melding(tekst, soort) {
    const m = $("#melding");
    if (!tekst) { m.hidden = true; return; }
    m.className = "melding" + (soort ? " " + soort : "");
    m.textContent = tekst;
    m.hidden = false;
  }
  function foutTekst(e) { return (e && (e.message || e.error_description || e.msg)) || String(e); }

  // ---------------------------------------------------------------- inloggen
  async function naInloggen() {
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
      view("#v-mfa");
      $("#m-code").value = "";
      $("#m-code").focus();
      return;
    }
    const { data: isAdmin, error } = await sb.rpc("is_admin");
    if (error || !isAdmin) {
      await sb.auth.signOut();
      view("#v-login");
      melding("Dit account heeft geen beheerrechten. Voeg het toe aan de tabel admins (zie README).", "fout");
      return;
    }
    melding("");
    view("#v-lijst");
    laadLijst();
  }

  $("#f-login").onsubmit = async (e) => {
    e.preventDefault();
    melding("Inloggen…");
    const { error } = await sb.auth.signInWithPassword({ email: $("#l-email").value.trim(), password: $("#l-ww").value });
    $("#l-ww").value = "";
    if (error) { melding("Inloggen mislukt: " + foutTekst(error), "fout"); return; }
    naInloggen();
  };

  $("#f-mfa").onsubmit = async (e) => {
    e.preventDefault();
    const { data: f } = await sb.auth.mfa.listFactors();
    const factor = f && f.totp && f.totp[0];
    if (!factor) { melding("Geen 2FA-factor gevonden.", "fout"); return; }
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: $("#m-code").value.trim() });
    if (error) { melding("Code onjuist: " + foutTekst(error), "fout"); return; }
    naInloggen();
  };

  document.querySelectorAll("[data-uitloggen]").forEach((b) => (b.onclick = async () => {
    await sb.auth.signOut();
    huidig = null;
    view("#v-login");
    melding("Je bent uitgelogd.", "ok");
  }));

  // ---------------------------------------------------------------- 2FA instellen
  $("#b-2fa").onclick = async () => {
    const p = $("#v-2fa");
    if (!p.hidden) { p.hidden = true; return; }
    const { data: lijst } = await sb.auth.mfa.listFactors();
    if (lijst && lijst.totp && lijst.totp.length) { melding("2FA is al ingesteld voor dit account.", "ok"); return; }
    // Eerder begonnen maar niet afgeronde koppelingen opruimen
    for (const f of (lijst && lijst.all) || []) {
      if (f.status !== "verified") await sb.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Kamervragen-quiz" });
    if (error) { melding("2FA instellen mislukt: " + foutTekst(error), "fout"); return; }
    p.dataset.factor = data.id;
    $("#q-qr").src = data.totp.qr_code;
    $("#q-geheim").textContent = data.totp.secret;
    p.hidden = false;
  };
  $("#f-2fa").onsubmit = async (e) => {
    e.preventDefault();
    const factorId = $("#v-2fa").dataset.factor;
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: $("#q-code").value.trim() });
    if (error) { melding("Code onjuist: " + foutTekst(error), "fout"); return; }
    $("#v-2fa").hidden = true;
    melding("2FA is ingeschakeld. Vanaf nu is bij het inloggen een code nodig.", "ok");
  };

  // ---------------------------------------------------------------- overzicht
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll("#tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    laadLijst();
  }));

  async function laadLijst() {
    const lijst = $("#lijst");
    lijst.textContent = "Laden…";
    let q = sb.from("vragen")
      .select("id,nummer,titel,datum,status,herzien_nodig,beantwoord,score,ai_fout,indieners")
      .order("datum", { ascending: false, nullsFirst: false })
      .limit(200);
    q = tab === "herzien" ? q.eq("herzien_nodig", true) : q.eq("status", tab);
    const { data, error } = await q;
    lijst.textContent = "";
    if (error) { melding("Laden mislukt: " + foutTekst(error), "fout"); return; }
    if (!data.length) {
      const d = document.createElement("div");
      d.className = "leeg";
      d.textContent = tab === "concept" ? "Geen concepten. Klik op \"Nieuwe vragen ophalen\"." : "Niets in deze lijst.";
      lijst.append(d);
      return;
    }
    for (const v of data) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "item";
      const t = document.createElement("span"); t.className = "t"; t.textContent = v.titel;
      const m = document.createElement("span"); m.className = "meta";
      m.textContent = [v.nummer, v.datum, (v.indieners || []).join(", "),
        v.beantwoord ? "beantwoord" : "nog niet beantwoord",
        v.score ? "score " + v.score : null,
        v.herzien_nodig ? "⚠ herzien nodig" : null,
        v.ai_fout ? "⚠ AI-fout" : null].filter(Boolean).join(" · ");
      b.append(t, m);
      b.onclick = () => open(v.id);
      lijst.append(b);
    }
  }

  $("#b-ophalen").onclick = async () => {
    const b = $("#b-ophalen");
    b.disabled = true;
    melding("Nieuwe Kamervragen ophalen en laten beoordelen… Dit kan een paar minuten duren.");
    try {
      const { data, error } = await sb.functions.invoke(FUNCTIE, { body: {} });
      if (error) throw error;
      melding(`Klaar: ${data.nieuw || 0} nieuw, ${data.bijgewerkt || 0} bijgewerkt, ${data.overgeslagen || 0} overgeslagen.` +
        (data.fouten && data.fouten.length ? ` Fouten: ${data.fouten.join("; ")}` : ""), data.fouten && data.fouten.length ? "fout" : "ok");
    } catch (e) {
      melding("Ophalen mislukt: " + foutTekst(e), "fout");
    } finally {
      b.disabled = false;
      laadLijst();
    }
  };

  // ---------------------------------------------------------------- via Claude.ai (handmatig kopiëren/plakken)
  const PROMPT_KOP = `Je beoordeelt schriftelijke Kamervragen van de Nederlandse Tweede Kamer voor een publieksquiz.
Je werk is een concept: een redacteur controleert alles voordat het gepubliceerd wordt. Wees feitelijk, kort en eerlijk over onzekerheid.

Gebruik de zoekfunctie (web search). Beoordeel per vraag:
1. "googlebaar": was het antwoord op de kern van de vragen al openbaar online te vinden VÓÓR de datum waarop de vragen gesteld werden? Denk aan eerdere Kamervragen met antwoord, Kamerbrieven, rijksoverheid.nl, CBS, wetteksten, nieuwsberichten. Kun je het niet aantonen, kies dan false en zeg dat in de uitleg. Alleen true als je concrete bronnen vindt; geef die in "bronnen" (alleen URL's die je echt gevonden hebt, nooit verzonnen).
2. "vragen_samenvatting": 1 tot 3 zinnen, neutraal, wat de Kamerleden vragen.
3. "antwoord_samenvatting": alleen als er een <antwoord> is meegegeven: 1 tot 3 zinnen, neutraal, wat het kabinet antwoordt. Anders null.
4. "score" 1 tot 10: hoe sterk is de vraag als controle-instrument? Hoger als het kabinet erover gaat, de vraag beleid controleert en iets nieuws boven tafel haalt. Lager als hetzelfde al eerder gevraagd en beantwoord is, of als het antwoord gewoon online stond.
5. "score_uitleg": 1 tot 3 zinnen.

Wees strikt partijneutraal: beoordeel het soort vraag, nooit de politieke kleur, de indiener of het standpunt. Schrijf in het Nederlands.

Geef als antwoord ALLEEN één JSON-codeblok met een lijst, één object per vraag, met precies het "id" dat hieronder bij de vraag staat:
\`\`\`json
[{"id": "...", "googlebaar": true, "googlebaar_uitleg": "...", "bronnen": [{"titel": "...", "url": "https://..."}], "vragen_samenvatting": "...", "antwoord_samenvatting": null, "score": 5, "score_uitleg": "..."}]
\`\`\`
Sla geen vragen over. De vragen:`;

  let claudeBatch = []; // rijen in de huidige prompt

  $("#b-claude").onclick = () => {
    const p = $("#v-claude");
    p.hidden = !p.hidden;
    if (!p.hidden) p.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  $("#b-prompt").onclick = async () => {
    const max = Math.max(1, Math.min(30, Number($("#c-max").value) || 10));
    let q = sb.from("vragen")
      .select("id,nummer,titel,datum,indieners,aan,status,vraag_tekst,antwoord_tekst,ai_concept,googlebaar,googlebaar_uitleg,bronnen,vragen_samenvatting,antwoord_samenvatting,score,score_uitleg")
      .neq("status", "afgewezen")
      .or("status.eq.concept,herzien_nodig.eq.true")
      .order("datum", { ascending: false, nullsFirst: false })
      .limit(max);
    if ($("#c-zonder").checked) q = q.is("ai_concept", null);
    const { data, error } = await q;
    if (error) { melding("Vragen laden mislukt: " + foutTekst(error), "fout"); return; }
    if (!data.length) { melding("Er zijn geen vragen die nog beoordeeld moeten worden.", "ok"); $("#c-stap2").hidden = true; return; }

    claudeBatch = data;
    const blokken = data.map((v, i) => [
      `\n=== Vraag ${i + 1} ===`,
      `id: ${v.id}`,
      `Titel: ${v.titel}`,
      `Kamernummer: ${v.nummer || "onbekend"}`,
      `Datum gesteld: ${v.datum || "onbekend"}`,
      `Indieners: ${(v.indieners || []).join(", ") || "onbekend"}`,
      `Gericht aan: ${v.aan || "onbekend"}`,
      `<vragen>\n${(v.vraag_tekst || "(De volledige tekst kon niet opgehaald worden; baseer je op de titel en zeg dat in de uitleg.)").trim()}\n</vragen>`,
      v.antwoord_tekst ? `<antwoord>\n${v.antwoord_tekst.trim()}\n</antwoord>` : "(Er is nog geen antwoord van het kabinet.)",
    ].join("\n"));
    const prompt = PROMPT_KOP + "\n" + blokken.join("\n");
    $("#c-prompt").value = prompt;
    $("#c-antwoord").value = "";
    const k = Math.round(prompt.length / 1000);
    $("#c-info").textContent = `${data.length} ${data.length === 1 ? "vraag" : "vragen"} in de prompt (${k}k tekens).` +
      (prompt.length > 300000 ? " Dit is erg lang; kies een kleiner aantal als Claude het niet in één keer aankan." : "");
    $("#c-stap2").hidden = false;
    melding("");
  };

  $("#b-kopieer").onclick = async () => {
    const t = $("#c-prompt");
    try { await navigator.clipboard.writeText(t.value); }
    catch (e) { t.focus(); t.select(); document.execCommand("copy"); }
    melding("Prompt gekopieerd. Plak hem in een nieuw gesprek op claude.ai.", "ok");
  };

  function leesClaudeAntwoord(tekst) {
    const begin = tekst.indexOf("[");
    const eind = tekst.lastIndexOf("]");
    if (begin < 0 || eind <= begin) throw new Error("Geen lijst ([ … ]) gevonden in het geplakte antwoord. Kopieer het volledige antwoord van Claude.");
    let lijst;
    try { lijst = JSON.parse(tekst.slice(begin, eind + 1)); }
    catch (e) { throw new Error("Het antwoord is geen geldige JSON. Vraag Claude: \"Geef alleen het JSON-codeblok opnieuw.\""); }
    if (!Array.isArray(lijst)) throw new Error("Het antwoord is geen lijst.");
    return lijst;
  }

  function schoonConcept(o) {
    const str = (v, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const bronnen = [];
    for (const b of Array.isArray(o.bronnen) ? o.bronnen.slice(0, 8) : []) {
      try {
        const u = new URL(str(b && b.url, 500));
        if (u.protocol === "https:" || u.protocol === "http:") bronnen.push({ titel: str(b.titel, 200) || u.hostname, url: u.href });
      } catch (e) { /* ongeldige URL overslaan */ }
    }
    const score = Number(o.score);
    return {
      googlebaar: typeof o.googlebaar === "boolean" ? o.googlebaar : null,
      googlebaar_uitleg: str(o.googlebaar_uitleg),
      bronnen,
      vragen_samenvatting: str(o.vragen_samenvatting),
      antwoord_samenvatting: str(o.antwoord_samenvatting) || null,
      score: Number.isInteger(score) && score >= 1 && score <= 10 ? score : null,
      score_uitleg: str(o.score_uitleg),
      model: "claude.ai (handmatig geplakt)",
      beoordeeld_op: new Date().toISOString(),
    };
  }

  // Vul lege velden van een concept met het voorstel (zelfde regels als de import-functie).
  function voorinvullen(rij, ai) {
    const leeg = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
    const uit = {};
    if (rij.status !== "concept") return uit;
    if (leeg(rij.googlebaar) && ai.googlebaar !== null) uit.googlebaar = ai.googlebaar;
    if (leeg(rij.googlebaar_uitleg) && ai.googlebaar_uitleg) uit.googlebaar_uitleg = ai.googlebaar_uitleg;
    if (leeg(rij.bronnen) && ai.bronnen.length) uit.bronnen = ai.bronnen;
    if (leeg(rij.vragen_samenvatting) && ai.vragen_samenvatting) uit.vragen_samenvatting = ai.vragen_samenvatting;
    if (leeg(rij.antwoord_samenvatting) && ai.antwoord_samenvatting && rij.antwoord_tekst) uit.antwoord_samenvatting = ai.antwoord_samenvatting;
    if (leeg(rij.score) && ai.score !== null) uit.score = ai.score;
    if (leeg(rij.score_uitleg) && ai.score_uitleg) uit.score_uitleg = ai.score_uitleg;
    return uit;
  }

  $("#b-verwerk").onclick = async () => {
    let lijst;
    try { lijst = leesClaudeAntwoord($("#c-antwoord").value); } catch (e) { melding(e.message, "fout"); return; }
    const perId = new Map(claudeBatch.map((r) => [r.id, r]));
    const b = $("#b-verwerk");
    b.disabled = true;
    let ok = 0;
    const fouten = [];
    const gezien = new Set();
    for (const item of lijst) {
      const rij = item && perId.get(String(item.id || "").trim());
      if (!rij) { fouten.push(`onbekend id "${item && item.id}"`); continue; }
      if (gezien.has(rij.id)) continue;
      gezien.add(rij.id);
      const ai = schoonConcept(item);
      if (!rij.antwoord_tekst) ai.antwoord_samenvatting = null;
      const { error } = await sb.from("vragen").update({ ai_concept: ai, ai_fout: null, ...voorinvullen(rij, ai) }).eq("id", rij.id);
      if (error) fouten.push(`${rij.nummer || rij.titel}: ${foutTekst(error)}`); else ok++;
    }
    const ontbreekt = claudeBatch.filter((r) => !gezien.has(r.id)).length;
    b.disabled = false;
    melding(`${ok} ${ok === 1 ? "vraag" : "vragen"} bijgewerkt met het voorstel van Claude.` +
      (ontbreekt ? ` ${ontbreekt} ontbraken in het antwoord (maak een nieuwe prompt om die alsnog te doen).` : "") +
      (fouten.length ? ` Problemen: ${fouten.join("; ")}` : "") +
      " Open de concepten om alles te controleren en te publiceren.", fouten.length ? "fout" : "ok");
    if (ok) { $("#c-antwoord").value = ""; $("#c-stap2").hidden = true; claudeBatch = []; }
    laadLijst();
  };

  // ---------------------------------------------------------------- bewerken
  function radioG() { const r = document.querySelector('input[name="g"]:checked'); return r ? r.value : ""; }
  function zetRadioG(v) { document.querySelectorAll('input[name="g"]').forEach((r) => (r.checked = r.value === v)); }

  function bronnenNaarTekst(b) {
    return (Array.isArray(b) ? b : []).map((x) => (x.titel ? x.titel + " | " : "") + x.url).join("\n");
  }
  function tekstNaarBronnen(t) {
    const uit = [];
    for (const regel of t.split("\n").map((r) => r.trim()).filter(Boolean)) {
      const i = regel.lastIndexOf("|");
      const titel = i >= 0 ? regel.slice(0, i).trim() : "";
      const url = (i >= 0 ? regel.slice(i + 1) : regel).trim();
      try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
        uit.push({ titel: titel || u.hostname, url: u.href });
      } catch (e) {
        throw new Error(`Ongeldige bron-URL: "${url}"`);
      }
    }
    return uit;
  }

  async function open(id) {
    melding("");
    const { data: v, error } = await sb.from("vragen").select("*").eq("id", id).single();
    if (error) { melding("Openen mislukt: " + foutTekst(error), "fout"); return; }
    huidig = v;
    $("#e-nr").textContent = v.nummer || "zonder nummer";
    $("#e-status").textContent = v.status;
    $("#e-herzien").hidden = !v.herzien_nodig;
    $("#e-kop").textContent = v.titel;
    $("#e-titel").value = v.titel || "";
    $("#e-nummer").value = v.nummer || "";
    $("#e-datum").value = v.datum || "";
    $("#e-indieners").value = (v.indieners || []).join("\n");
    $("#e-aan").value = v.aan || "";
    $("#e-link").value = v.link || "";
    $("#e-vraagtekst").textContent = v.vraag_tekst || "(geen tekst opgehaald)";
    $("#e-antwoordtekst").textContent = v.antwoord_tekst || "(nog geen antwoord)";
    $("#e-vsam").value = v.vragen_samenvatting || "";
    zetRadioG(v.googlebaar === true ? "ja" : v.googlebaar === false ? "nee" : "");
    $("#e-guitleg").value = v.googlebaar_uitleg || "";
    $("#e-bronnen").value = bronnenNaarTekst(v.bronnen);
    $("#e-beantwoord").checked = !!v.beantwoord;
    $("#e-asam").value = v.antwoord_samenvatting || "";
    $("#e-score").value = v.score || "";
    $("#e-suitleg").value = v.score_uitleg || "";
    $("#e-gecontroleerd").checked = false;
    $("#b-publiceren").disabled = true;
    $("#b-publiceren").textContent = v.status === "gepubliceerd" ? "Wijzigingen publiceren" : "Publiceren";
    $("#b-afwijzen").textContent = v.status === "gepubliceerd" ? "Offline halen (afwijzen)" : "Afwijzen";
    toonAi(v);
    view("#v-edit");
    window.scrollTo(0, 0);
  }

  function toonAi(v) {
    const el = $("#e-ai");
    el.textContent = "";
    const regel = (k, w) => {
      if (w === undefined || w === null || w === "") return;
      const p = document.createElement("div");
      const b = document.createElement("b"); b.textContent = k + ": ";
      p.append(b, document.createTextNode(String(w)));
      el.append(p);
    };
    if (v.ai_fout) regel("Fout bij AI-beoordeling", v.ai_fout);
    const a = v.ai_concept;
    if (!a) { if (!v.ai_fout) regel("Status", "Nog geen AI-voorstel. Gebruik \"Beoordelen via Claude.ai\" in het overzicht."); return; }
    regel("Googlebaar", a.googlebaar === true ? "ja" : a.googlebaar === false ? "nee" : "onbekend");
    regel("Uitleg googlebaar", a.googlebaar_uitleg);
    regel("Bronnen", (a.bronnen || []).map((b) => b.url).join("  ·  "));
    regel("Samenvatting vragen", a.vragen_samenvatting);
    regel("Samenvatting antwoord", a.antwoord_samenvatting);
    regel("Score", a.score);
    regel("Uitleg score", a.score_uitleg);
    regel("Model", a.model);
  }

  $("#b-overnemen").onclick = () => {
    const a = huidig && huidig.ai_concept;
    if (!a) return;
    const vul = (sel, w) => { if (!$(sel).value.trim() && w) $(sel).value = w; };
    vul("#e-vsam", a.vragen_samenvatting);
    vul("#e-guitleg", a.googlebaar_uitleg);
    vul("#e-asam", a.antwoord_samenvatting);
    vul("#e-suitleg", a.score_uitleg);
    vul("#e-score", a.score);
    if (!$("#e-bronnen").value.trim()) $("#e-bronnen").value = bronnenNaarTekst(a.bronnen);
    if (radioG() === "" && typeof a.googlebaar === "boolean") zetRadioG(a.googlebaar ? "ja" : "nee");
    if (a.antwoord_samenvatting && huidig.antwoord_tekst) $("#e-beantwoord").checked = true;
    melding("AI-voorstel overgenomen in de lege velden. Controleer alles voordat je publiceert.");
  };

  $("#e-gecontroleerd").onchange = () => { $("#b-publiceren").disabled = !$("#e-gecontroleerd").checked; };

  function formulier() {
    const g = radioG();
    const score = $("#e-score").value.trim();
    const n = score ? Number(score) : null;
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 10)) throw new Error("De score moet een heel getal van 1 tot en met 10 zijn.");
    const link = $("#e-link").value.trim();
    if (link) { try { const u = new URL(link); if (!/^https?:$/.test(u.protocol)) throw 0; } catch (e) { throw new Error("De link is geen geldige URL."); } }
    const leegNull = (s) => { const t = $(s).value.trim(); return t || null; };
    return {
      titel: $("#e-titel").value.trim(),
      nummer: leegNull("#e-nummer"),
      datum: leegNull("#e-datum"),
      indieners: $("#e-indieners").value.split("\n").map((s) => s.trim()).filter(Boolean),
      aan: leegNull("#e-aan"),
      link: link || null,
      vragen_samenvatting: leegNull("#e-vsam"),
      googlebaar: g === "ja" ? true : g === "nee" ? false : null,
      googlebaar_uitleg: leegNull("#e-guitleg"),
      bronnen: tekstNaarBronnen($("#e-bronnen").value),
      beantwoord: $("#e-beantwoord").checked,
      antwoord_samenvatting: leegNull("#e-asam"),
      score: n,
      score_uitleg: leegNull("#e-suitleg"),
    };
  }

  async function bewaar(status) {
    let velden;
    try { velden = formulier(); } catch (e) { melding(e.message, "fout"); return; }
    if (!velden.titel) { melding("De titel is verplicht.", "fout"); return; }
    if (status === "gepubliceerd" && !$("#e-gecontroleerd").checked) { melding("Vink eerst aan dat je alles gecontroleerd hebt.", "fout"); return; }
    const { error } = await sb.from("vragen").update({ ...velden, status, herzien_nodig: false }).eq("id", huidig.id);
    if (error) { melding(foutTekst(error), "fout"); return; }
    melding(status === "gepubliceerd" ? "Gepubliceerd! De vraag staat nu in de quiz." :
      status === "afgewezen" ? "Afgewezen. De vraag verschijnt niet in de quiz." : "Opgeslagen als concept.", "ok");
    view("#v-lijst");
    laadLijst();
  }

  $("#b-opslaan").onclick = () => bewaar("concept");
  $("#b-publiceren").onclick = () => bewaar("gepubliceerd");
  $("#b-afwijzen").onclick = () => { if (confirm("Deze vraag afwijzen? Hij verschijnt dan niet (meer) in de quiz.")) bewaar("afgewezen"); };
  $("#b-terug").onclick = () => { view("#v-lijst"); laadLijst(); };

  $("#b-ai").onclick = async () => {
    const b = $("#b-ai");
    b.disabled = true;
    melding("AI beoordeelt de vraag opnieuw… (kan een minuut duren)");
    try {
      const { data, error } = await sb.functions.invoke(FUNCTIE, { body: { id: huidig.id } });
      if (error) throw error;
      if (data.fouten && data.fouten.length) throw new Error(data.fouten.join("; "));
      const id = huidig.id;
      await open(id);
      melding("Nieuw AI-voorstel staat klaar. Gebruik \"AI-voorstel overnemen\" of pas zelf aan.", "ok");
    } catch (e) {
      melding("AI-beoordeling mislukt: " + foutTekst(e), "fout");
    } finally {
      b.disabled = false;
    }
  };

  // ---------------------------------------------------------------- start
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
    melding("Niet ingesteld: vul SUPABASE_URL en SUPABASE_ANON_KEY in (zie README).", "fout");
    return;
  }
  // Admin-sessie alleen in sessionStorage: weg zodra het tabblad sluit.
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true },
  });
  sb.auth.getSession().then(({ data }) => {
    if (data && data.session) naInloggen(); else view("#v-login");
  });
})();
