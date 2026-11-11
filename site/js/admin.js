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
    if (!a) { if (!v.ai_fout) regel("Status", "Nog geen AI-voorstel"); return; }
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
