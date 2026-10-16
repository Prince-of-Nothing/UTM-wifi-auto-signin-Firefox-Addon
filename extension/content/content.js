/* UTMSDN Guest Auto-Connect — portal page driver.
 *
 * Runs ONLY on https://sb.sdn.utm.md:19008/portalpage/*.  It reproduces the
 * two clicks a human makes on the anonymous-auth page:
 *    1. tick "Confirm Acceptarea Termenilor și Condițiilor"  (#agreeCheck)
 *    2. press "Conectare"                                    (#annoyBtn)
 *
 * Idempotent: at most one submit per document, guarded by `submitted`.
 */

(() => {
  const CFG = {
    BTN: "#annoyBtn",
    CHECK_IMG: "#agreeCheck",
    TERMS_LINK: "#readmeLink",
    // Markers from the portal's own auth.js / check.js result messages.
    SUCCESS_TOKENS: ["autentificare reusita", "login success", "conectat cu succes", "connected successfully"],
    ERROR_TOKENS: ["esuat", "a fost refuzat", "invalid", "expired"],
    ONLINE_TOKENS: ["deconectare", "logout", "delog"],
    DEADLINE_MS: 20000,
    TICK_MS: 300
  };

  let PORTAL_PREFIX = "";   // filled in from config.json at boot
  let submitted = false;
  let finished = false;
  let observer = null;

  const $ = (sel) => document.querySelector(sel);
  const text = () => (document.body && document.body.innerText) || "";
  const send = (m) => { try { browser.runtime.sendMessage(m).catch(() => {}); } catch (e) {} };

  /* --------------------------------------------------------- checkbox */

  const isChecked = (img) => !!img && !/uncheck/i.test(img.getAttribute("src") || "");

  function acceptTerms() {
    const link = $(CFG.TERMS_LINK);
    if (link) link.click();                        // portal toggles via turnReadmePage()
    const img = $(CFG.CHECK_IMG);
    if (img && !isChecked(img)) img.click();        // fallback: toggle directly
    return isChecked($(CFG.CHECK_IMG));
  }

  /* ----------------------------------------------------------- button */

  function findButton() {
    const b = $(CFG.BTN);
    if (b) return b;
    return Array.from(document.querySelectorAll("input[type=button],input[type=submit],button"))
      .find((el) => /^(conectare|connect|log ?in|autentificare)$/i.test((el.value || el.textContent || "").trim())) || null;
  }

  function trySubmit() {
    if (submitted || finished) return;
    const btn = findButton();
    if (!btn) return;
    submitted = true;
    acceptTerms();                                  // no-op when already accepted
    send({ type: "clicked" });
    btn.click();
    watchOutcome();
  }

  /* ---------------------------------------------------------- outcome */

  function scan(s) {
    for (const tok of CFG.ERROR_TOKENS) if (s.includes(tok)) return { ok: false, why: tok };
    for (const tok of CFG.SUCCESS_TOKENS) if (s.includes(tok)) return { ok: true, via: tok };
    return null;
  }

  function watchOutcome() {
    const started = Date.now();
    const poll = setInterval(() => {
      if (finished) { clearInterval(poll); return; }

      if (!location.href.startsWith(PORTAL_PREFIX)) { finish(true, "left portal page"); return; }

      const body = text().toLowerCase();
      const r = scan(body);
      if (r) { finish(r.ok, r.via || r.why); return; }
      if (CFG.ONLINE_TOKENS.some((t) => body.includes(t))) { finish(true, "already connected"); return; }

      // Portal replaced its form after our click -> it accepted the login.
      if (submitted && !findButton() && Date.now() - started > 4000) {
        finish(true, "portal form disappeared");
        return;
      }
      if (Date.now() - started > CFG.DEADLINE_MS) finish(false, "no confirmation from the portal");
    }, CFG.TICK_MS);
  }

  function finish(ok, why) {
    if (finished) return;
    finished = true;
    if (observer) { observer.disconnect(); observer = null; }
    send({ type: "done", ok, via: ok ? why : undefined, error: ok ? undefined : why });
  }

  /* --------------------------------------------------------------- boot */

  async function boot() {
    try {
      const r = await fetch(browser.runtime.getURL("config.json"));
      const j = JSON.parse(await r.text());
      PORTAL_PREFIX = `https://${j.HOST}:${j.PORTAL_PORT}${j.PORTAL_PATH}`;
    } catch (e) { /* fall back to whatever URL we are on */ }
    if (!PORTAL_PREFIX) PORTAL_PREFIX = location.origin + "/portalpage/";
    send({ type: "ready" });

    const body = text().toLowerCase();
    if (!findButton()) {
      if (CFG.ONLINE_TOKENS.some((t) => body.includes(t))) finish(true, "already connected");
      else send({ type: "done", ok: false, error: "connect button not found" });
      return;
    }

    trySubmit();

    // The portal renders parts of the form with jQuery after load.
    observer = new MutationObserver(() => { if (!submitted) trySubmit(); });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setTimeout(trySubmit, 500);                     // belt & braces
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
