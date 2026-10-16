# UTM Guest Auto-Connect

A tiny, **signed** Firefox extension that works with **exactly one website**: the
UTM-WiNetUni_GUEST campus portal at `https://sb.sdn.utm.md:19008/portalpage/`.

When the network is closed off, Firefox probes its captive-portal-detection
canaries and gets redirected to a fresh portal page. This extension notices that
redirect, loads the page **in a background tab**, performs the two clicks every
user has to make — tick *"Confirm Acceptarea Termenilor și Condițiilor"*, press
*"Conectare"* — and closes the tab again. When the 2-hour session drops it does
the same thing once more. Nothing else, on no other site.

**Clicking the toolbar icon switches the automatic behaviour off; clicking it
again switches it back on and immediately retries.** The icon colour *is* the
status display, so there is no popup and nothing to read.

---

## How it works

| Step | What happens |
|---|---|
| 1. Detect | `webRequest.onBeforeRedirect` watches requests to `detectportal.firefox.com` / `captive.apple.com`. Two consecutive redirects into `/portalpage/` ⇒ we are captive. |
| 2. Pin the URL | The newest redirect target is remembered. Its query string carries our own `uaddress` (IP) and `umac` (MAC), so an old or foreign URL is discarded after `STALE_MS`. |
| 3. Connect | The pinned URL opens as `tabs.create({ active: false })` — never focused, never brought forward. `content/content.js` ticks the checkbox (`#agreeCheck`, only if still unchecked) and clicks `#annoyBtn` exactly once per document. |
| 4. Confirm | The canaries are re-fetched: `204` ⇒ open network ⇒ success. Any failure path (timeout, expired page, dead form) closes the tab, counts the attempt and backs off. |
| 5. Repeat | Polling backs off exponentially while online (3 s → 30 s) and snaps back to 3 s when the session drops. |

### Icon states (and the on/off switch)

| Icon | Meaning |
|---|---|
| 🟢 green `icon-on.svg` | automatic connect on, currently online |
| 🔴 red `icon-wait.svg` | automatic connect on, offline and waiting for a live portal page |
| 🔵 blue `icon-busy.svg` + `…` badge | an attempt is running in a background tab |
| ⚪ grey `icon-off.svg` | **switched off** by clicking the icon — no tabs are opened until you click again |

Hovering the icon shows the exact status text (`browserAction.setTitle`).

---

## Repository layout

```
extension/                 # everything that goes into the XPI
  manifest.json            # MV2, gecko.id (required for signing/persistence)
  config.json              # host, port, timings — edit here, not in code
  background/background.js # detection, scheduler, icon switch
  content/content.js       # the two clicks, scoped to /portalpage/* only
  icons/icon-{on,off,busy,wait}.svg   # 350 B each, no PNGs
scripts/check.py           # pre-sign gate: manifest shape, syntax, banned constructs
scripts/build.py           # deterministic ZIP -> dist/*.xpi
dist/                      # build output (gitignored)
```

Total packaged source: ~23 KB across 8 files. No frameworks, no third-party
libraries, no minification, no build transpilation — what you read is what runs.

## Build, sign, install

```bash
python3 scripts/check.py && python3 scripts/build.py
# -> dist/utm-guest-autoconnect-2.0.0.xpi  (+ printed sha256)
```

Signing is what makes the extension persistent (Firefox refuses to keep loading
unsigned extensions outside developer profiles):

```bash
npm i -g web-ext                       # or use ./node_modules/.bin/web-ext
export AMO_API_KEY=... AMO_API_SECRET=...   # from addons.mozilla.org > Developer Keys
web-ext sign --source-dir extension --artifacts-dir dist --channel unlisted
```

Then install the resulting signed `.xpi`: **about:addons → ⚙ → Install Add-on From File…**
(For permanent installs in a managed/locked-down profile, deploy it via the
Firefox Enterprise policy `ExtensionSettings` with the ID
`utm-guest-autoconnect@localhost`.)

Before relying on auto-connect, open the portal once manually and accept the TLS
exception if your campus controller uses a non-public certificate — Firefox will
not silently bypass certificate errors for a background tab.

## Tuning (`extension/config.json`)

| Key | Default | Purpose |
|---|---|---|
| `HOST` / `PORTAL_PORT` / `PORTAL_PATH` | `sb.sdn.utm.md` / `19008` / `/portalpage/` | the single site this add-on knows about |
| `REDIRECT_STRIKE_LIMIT` | `2` | redirects needed before acting (avoids false positives) |
| `STALE_MS` | `15000` | how long a captured portal URL stays usable |
| `POLL_MS` / `MAX_POLL_MS` | `3000` / `30000` | online-state polling, exponential back-off |
| `CONNECT_TIMEOUT_MS` | `15000` | per-attempt timeout |
| `COOLDOWN_MS` / `MAX_ATTEMPTS` | `20000` / `5` | retry pacing; after N failures it waits for a brand-new portal page |
| `DEBUG` | `false` | verbose console logging in the browser console (`about:debugging`) |

## Compliance with Mozilla's Add-on Policies

Written against the current *Add-on Policies* (last updated Apr 30 2026):

- **§1 No surprises** — the name, description and listing state exactly what it
  does and which site it touches. There are no hidden features and no changes to
  the homepage, new-tab page or search engine.
- **§3 Submission guidelines** — it functions only as described; the full,
  readable source ships inside the XPI and in this repo, and `scripts/build.py`
  documents how to reproduce the archive byte-for-byte. No obfuscation, no
  minification. Testing note for reviewers: it needs the campus guest network,
  no account or credentials exist (anonymous "Conectare").
- **§4 Development practices** — permissions are limited to what is necessary
  (`webRequest`, `tabs`, `storage`, `alarms` + three explicit host origins, no
  `<all_urls>`); the add-on is fully self-contained and never loads remote code
  (checked automatically: no `eval`, `new Function`, `innerHTML`, injected
  `<script>`); CSP is fixed to `script-src 'self'`; nothing is transported over
  the network except plain HTTP GETs to Firefox's own captive-portal check hosts
  and the HTTPS portal itself; no redundant files (four 350-byte SVGs, no PNGs).
- **§5 User scripts** — the `userScripts` API is not used.
- **§6 Data collection** — **no data is collected, stored or transmitted about
  the user.** The manifest declares empty `data_collection_permissions`, so the
  built-in consent experience resolves to implicit consent (§6.2.1). The only
  local persistence is one small record in `browser.storage.local` holding the
  enable/disable switch, a status string and counters; portal URLs (which embed
  the device IP/MAC assigned by the network) are kept only while fresh and are
  never sent anywhere but back to the portal that issued them. Private-browsing
  sessions are untouched.
- **§7 Monetization** — no ads, no miners, no affiliate redirects.
- **§8 Security** — the automation is bounded to one origin and reproduces the
  user's own two clicks; failures back off instead of hammering the controller.

### Reviewer notes / known limitations

- The portal regenerates its login URL per session and per client; the extension
  therefore never hardcodes a URL — it captures the live redirect target. If no
  redirect has been seen yet it idles quietly (red icon) instead of guessing.
- If the campus network stops intercepting the canary hosts, detection falls
  back to the manual route: click the icon twice (off/on) to force a fresh probe.
- The `tabs` permission is used solely to create/close its own background tab;
  no tab contents of other sites are ever read.

## Local testing without the campus network

`extension/content/content.js` can be exercised against a saved copy of the
portal page in Node/jsdom: load the archived `auth.html` under the real portal
origin, stub `browser.runtime.sendMessage`, then assert that `#agreeCheck` ends
up checked, `#annoyBtn` was clicked exactly once, and `#readmeLink` was *not*
clicked (the terms page must not be opened programmatically).
