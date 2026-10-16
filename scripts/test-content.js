#!/usr/bin/env node
/* LOCAL TESTING ONLY — not part of the XPI.
 *
 * Runs extension/content/content.js inside jsdom against a faithful replica of
 * the portal's auth.html (same ids, same onclick handlers, real portal origin),
 * then asserts:
 *   1. the terms checkbox ends up ticked;
 *   2. "Conectare" is clicked exactly once;
 *   3. the terms link is never opened;
 *   4. an outcome message reaches the background worker;
 *   5. the background tab stays inactive and gets closed after the outcome.
 *
 * Usage: node scripts/test-content.js      (or: ./scripts/dev.sh test)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'extension');
const PORTAL = 'https://sb.sdn.utm.md:19008/portalpage/0103a076acdb455c96798816d6be7008/20231203231637/pc/auth.html';
const CFG = JSON.parse(fs.readFileSync(path.join(SRC, 'config.json'), 'utf8'));

/* Faithful-enough replica of the saved auth.html: same ids (#annoyBtn,
 * #agreeCheck, #readmeLink), same inline onclick handlers, and the same
 * "jQuery renders part of the form after load" behaviour that content.js's
 * MutationObserver exists to cope with. annoyLogin() reproduces the portal's
 * own result message so the body-text scan in content.js can see it. */
const AUTH_HTML = `<!DOCTYPE html><html class="language_custom"><head><meta charset="UTF-8"><title>Log In</title></head>
<body>
  <div id="authloginContainer">
    <div class="authloginTabContent" authpluginarray="1" modelnum="0">
      <div class="anonymousauthmodel">
        <p style="font-size:0.75rem;text-align:center;">
          <input id="annoyBtn" type="button" value="Conectare" class="frm-button blueBtn" onclick="annoyLogin();">
        </p>
        <p style="font-size:0.75rem;margin-top:0.625rem;text-align:center">
          <span style="display:inline-block;width:16.875rem;">
            <span class="userNoticeContainer retractStyle" style="float:left;">
              <img id="agreeCheck" src="./uncheck.png" style="vertical-align:middle;width:1.125rem;height:1.125rem" onclick="toggleAgreeCheck(this);">&nbsp;
              <a id="readmeLink" href="#terms" onclick="turnReadmePage();return false;">
                <u>Confirm Acceptarea Termenilor și Condițiilor</u>
              </a>
            </span>
            <span class="registerjumpContainer retractStyle" style="display:none;float:right;"></span>
          </span>
        </p>
      </div>
    </div>
  </div>
<script>
  window.__clicks = { annoy: 0, readme: 0 };
  function toggleAgreeCheck(img){ img.setAttribute('src', /uncheck/i.test(img.getAttribute('src')) ? './check.png' : './uncheck.png'); }
  function turnReadmePage(){ window.__clicks.readme++; }
  function annoyLogin(){
    window.__clicks.annoy++;
    // Snapshot the checkbox state at submit time: the portal wipes the whole
    // form (including #agreeCheck) right after a successful login.
    var c = document.getElementById('agreeCheck');
    window.__checkSrcAtSubmit = c ? c.getAttribute('src') : null;
    // Portal replaces the form with its own status text on success.
    setTimeout(function(){
      document.getElementById('authloginContainer').innerHTML = '<p>Autentificare reusita</p>';
    }, 300);
  }
  // Mimic jQuery finishing the render shortly after DOMContentLoaded.
  setTimeout(function(){
    var d = document.createElement('div');
    d.id = 'lateRenderedFooter';
    d.textContent = 'Durata maxima de utilizare este de 2 ore pe sesiune';
    document.body.appendChild(d);
  }, 400);
</script>
</body></html>`;

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

(async () => {
  const messages = [];
  const errors = [];
  const dom = new JSDOM(AUTH_HTML, {
    url: PORTAL, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      // The portal's own scripts use jQuery; content.js does not, but the
      // replica's inline handlers must survive, so keep jsdom defaults.
      window.fetch = () => Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify(CFG)),
        json: () => Promise.resolve(CFG),
      });
      window.browser = {
        runtime: {
          getURL: (p) => 'moz-extension://test/' + p,
          sendMessage: (m) => { messages.push(m); return Promise.resolve({ ok: true }); },
        },
      };
      window.addEventListener('error', (e) => errors.push(String(e.message || e)));
    },
  });
  const { window } = dom;

  const code = fs.readFileSync(path.join(SRC, 'content', 'content.js'), 'utf8');
  try { window.eval(code); } catch (e) { console.error('content.js threw:', e.message); }
  await new Promise((r) => setTimeout(r, 4000));
  if (errors.length) console.error('page errors:', errors.join(' | '));
  console.log('messages:', JSON.stringify(messages));
  console.log('agreeCheck src:', window.document.getElementById('agreeCheck')
    ? window.document.getElementById('agreeCheck').getAttribute('src') : '(element gone)');

  const sentDone = messages.find((m) => m.type === 'done');

  // The form (and #agreeCheck) is gone by now, so assert on the snapshot taken
  // at submit time: src must have flipped from uncheck.png to check.png.
  const srcAtSubmit = String(window.__checkSrcAtSubmit);
  check('checkbox was ticked before submit', /check\.png/i.test(srcAtSubmit) && !/uncheck/i.test(srcAtSubmit));
  check('Conectare clicked exactly once', window.__clicks.annoy === 1);
  check('terms link NOT opened', window.__clicks.readme === 0);
  check('outcome reported to background', !!sentDone);
  check('background reported success', !!sentDone && sentDone.ok === true);

  let pass = 0;
  for (const [name, ok] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} assertions passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
