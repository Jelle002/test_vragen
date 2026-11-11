// Kamervragen-quiz (publieke pagina).
// Privacy: geen login, geen cookies, geen localStorage/sessionStorage.
// De Supabase-client krijgt persistSession:false, zodat ook hij niets opslaat.
(function () {
  "use strict";

  const cfg = window.KVQ_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const quiz = $("#quiz");
  const status = $("#status");

  let sb = null;
  let ronde = [];
  let pos = 0;
  let goed = 0;
  let gestemd = 0;

  function toon(tekst) { status.textContent = tekst; }

  function leeg(tekst, knop) {
    quiz.textContent = "";
    const d = document.createElement("div");
    d.className = "leeg";
    d.textContent = tekst;
    if (knop) {
      const b = document.createElement("button");
      b.className = "knop";
      b.type = "button";
      b.textContent = knop.tekst;
      b.style.marginTop = "14px";
      b.onclick = knop.klik;
      d.append(document.createElement("br"), b);
    }
    quiz.append(d);
  }

  function fmt(d) {
    if (!d) return "";
    try {
      return new Date(d + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
    } catch (e) { return d; }
  }

  function oordeel(n) {
    return n >= 8 ? ["Scherp", "var(--slim)"] : n >= 6 ? ["Redelijk", "var(--accent)"] : n >= 4 ? ["Matig", "var(--meh)"] : ["Zwak", "var(--dom)"];
  }

  function veiligeUrl(u) {
    try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch (e) { return null; }
  }

  function zetSplit(el, a, b) {
    const n = a + b;
    const [sa, sb2] = el.querySelectorAll("span");
    sa.style.width = n ? (a / n) * 100 + "%" : "0";
    sb2.style.width = n ? (b / n) * 100 + "%" : "0";
  }

  async function rpcStem(id, soort) {
    try {
      const { data, error } = await sb.rpc("stem", { p_vraag: id, p_soort: soort });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    } catch (e) {
      return null; // stem niet geteld; quiz gaat gewoon door
    }
  }

  function render() {
    const q = ronde[pos];
    const c = $("#t-vraag").content.firstElementChild.cloneNode(true);

    // Voortgang
    const vg = $(".voortgang", c);
    vg.style.setProperty("--n", ronde.length);
    for (let i = 0; i < ronde.length; i++) {
      const t = document.createElement("i");
      if (i < pos) t.className = "klaar"; else if (i === pos) t.className = "nu";
      vg.append(t);
    }
    $(".pos", c).textContent = `Vraag ${pos + 1} van ${ronde.length}`;
    $(".nr", c).textContent = q.nummer || "Kamervraag";
    $(".dt", c).textContent = fmt(q.datum);
    const a = $("h2 a", c);
    a.textContent = q.titel || "";
    a.href = veiligeUrl(q.link) || "https://www.tweedekamer.nl/kamerstukken/kamervragen";
    const who = $(".who", c);
    const ind = document.createElement("strong");
    ind.textContent = (q.indieners || []).join(", ") || "Onbekend";
    who.append(ind, document.createTextNode(q.aan ? " aan " + q.aan : ""));
    $(".samenvatting", c).textContent = q.vragen_samenvatting || "";

    // Stap 1: googlebaar?
    const gKnoppen = c.querySelectorAll(".stap1 .keuze button");
    gKnoppen.forEach((b) => {
      b.onclick = async () => {
        const keuze = b.dataset.g === "ja";
        gKnoppen.forEach((x) => { x.disabled = true; x.setAttribute("aria-pressed", String(x === b)); });
        const juist = keuze === !!q.googlebaar;
        if (juist) goed++;

        const tot = await rpcStem(q.id, keuze ? "google_ja" : "google_nee");
        const gj = tot ? tot.google_ja : q.google_ja + (keuze ? 1 : 0);
        const gn = tot ? tot.google_nee : q.google_nee + (keuze ? 0 : 1);
        const n = gj + gn;
        const goedAantal = q.googlebaar ? gj : gn;

        const u = $(".onthul1 .uitslag", c);
        u.className = "uitslag " + (juist ? "goed" : "fout");
        u.textContent = (juist ? "Goed geraden! " : "Helaas. ") +
          (q.googlebaar ? "Het antwoord was al online te vinden." : "Dit was niet zomaar te googelen.");
        $(".g-uitleg", c).textContent = q.googlebaar_uitleg || "";
        const ul = $(".bronnen", c);
        for (const br of Array.isArray(q.bronnen) ? q.bronnen : []) {
          const url = veiligeUrl(br && br.url);
          if (!url) continue;
          const li = document.createElement("li");
          const l = document.createElement("a");
          l.href = url; l.target = "_blank"; l.rel = "noopener noreferrer";
          l.textContent = (br.titel || url);
          li.append(l); ul.append(li);
        }
        if (!ul.children.length) ul.remove();
        zetSplit($(".g-split", c), goedAantal, n - goedAantal);
        $(".g-tally", c).textContent = n
          ? `${Math.round((goedAantal / n) * 100)}% van ${n} ${n === 1 ? "speler" : "spelers"} gokte goed`
          : "Je bent de eerste speler bij deze vraag";
        if (!tot) $(".g-tally", c).textContent += " (je antwoord kon niet meegeteld worden)";
        $(".onthul1", c).hidden = false;

        if (q.beantwoord) {
          $(".stap2", c).hidden = false;
          $(".antwoord", c).textContent = q.antwoord_samenvatting || "";
        } else {
          toonOordeel(c, q, true);
        }
        toon(`Vraag ${pos + 1} van ${ronde.length} · ${goed} goed`);
      };
    });

    // Stap 2: slim of dom?
    const mKnoppen = c.querySelectorAll(".stap2 .keuze button");
    mKnoppen.forEach((b) => {
      b.onclick = async () => {
        const keuze = b.dataset.m;
        mKnoppen.forEach((x) => { x.disabled = true; x.setAttribute("aria-pressed", String(x === b)); });
        gestemd++;
        const tot = await rpcStem(q.id, keuze);
        const s = tot ? tot.slim : q.slim + (keuze === "slim" ? 1 : 0);
        const d = tot ? tot.dom : q.dom + (keuze === "dom" ? 1 : 0);
        const n = s + d;
        zetSplit($(".m-split", c), s, d);
        $(".m-tally", c).textContent =
          `${Math.round((s / n) * 100)}% slim · ${Math.round((d / n) * 100)}% dom · ${n} ${n === 1 ? "stem" : "stemmen"}` +
          (tot ? "" : " (je stem kon niet meegeteld worden)");
        $(".onthul2", c).hidden = false;
        toonOordeel(c, q, false);
      };
    });

    quiz.textContent = "";
    quiz.append(c);
    $("h2 a", c).focus({ preventScroll: true });
    window.scrollTo({ top: quiz.offsetTop - 12, behavior: "smooth" });
  }

  function toonOordeel(c, q, nogNiet) {
    const [woord, kleur] = oordeel(q.score || 0);
    const o = $(".oordeel", c);
    $(".score .n", o).textContent = q.score || "–";
    $(".score .n", o).style.color = kleur;
    $(".score .v", o).textContent = woord;
    $(".score .v", o).style.color = kleur;
    const ticks = $(".ticks", o);
    for (let i = 0; i < 10; i++) {
      const t = document.createElement("i");
      if (i < (q.score || 0)) t.style.background = kleur;
      ticks.append(t);
    }
    $(".s-uitleg", o).textContent = q.score_uitleg || "";
    $(".nog", o).hidden = !nogNiet;
    o.hidden = false;

    const v = $(".volgende", c);
    const knop = $("button", v);
    const laatste = pos === ronde.length - 1;
    knop.textContent = laatste ? "Bekijk je score" : "Volgende vraag";
    knop.onclick = () => { if (laatste) einde(); else { pos++; render(); } };
    v.hidden = false;
    knop.focus({ preventScroll: true });
  }

  function einde() {
    quiz.textContent = "";
    const c = document.createElement("article");
    c.className = "card";
    const e = document.createElement("div");
    e.className = "eind";
    const k = document.createElement("div"); k.className = "k"; k.textContent = "Jouw score";
    const g = document.createElement("div"); g.className = "groot"; g.textContent = `${goed}/${ronde.length}`;
    const p = document.createElement("p"); p.className = "lede";
    const pct = goed / ronde.length;
    p.textContent = (pct >= 0.8 ? "Jij kent de Kamer beter dan de Kamer zichzelf." :
      pct >= 0.5 ? "Niet slecht! Je hebt een goede neus voor googlebare vragen." :
      "Lastig hè? Sommige vragen lijken simpeler dan ze zijn.") +
      (gestemd ? ` Je gaf bij ${gestemd} ${gestemd === 1 ? "vraag" : "vragen"} je mening.` : "");
    const b = document.createElement("button"); b.className = "knop"; b.type = "button"; b.textContent = "Nog een ronde";
    b.onclick = start;
    e.append(k, g, p, b);
    c.append(e);
    quiz.append(c);
    toon(`Ronde klaar · ${goed} van ${ronde.length} goed`);
    b.focus({ preventScroll: true });
  }

  async function start() {
    leeg("Vragen worden geladen…");
    toon("Laden…");
    try {
      const { data, error } = await sb.rpc("quiz_ronde", { aantal: cfg.vragenPerRonde || 10 });
      if (error) throw error;
      ronde = Array.isArray(data) ? data : [];
    } catch (e) {
      toon("Laden mislukt");
      leeg("De vragen konden niet geladen worden. Controleer je verbinding en probeer het opnieuw.", { tekst: "Opnieuw proberen", klik: start });
      return;
    }
    if (!ronde.length) {
      toon("Nog geen vragen");
      leeg("Er zijn nog geen gecontroleerde vragen gepubliceerd. Kom binnenkort terug!");
      return;
    }
    pos = 0; goed = 0; gestemd = 0;
    toon(`Vraag 1 van ${ronde.length}`);
    render();
  }

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
    toon("Niet ingesteld");
    leeg("Deze quiz is nog niet gekoppeld aan Supabase. Vul SUPABASE_URL en SUPABASE_ANON_KEY in (zie README).");
    return;
  }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  start();
})();
