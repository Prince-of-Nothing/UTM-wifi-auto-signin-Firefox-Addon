/* UTMSDN Guest Auto-Connect — background worker (MV2, event driven).
 *
 * How it works
 *   1. Firefox probes captive-portal-detection (CPD) canaries while it thinks
 *      the network is closed off. On this network every probe is redirected to
 *      a fresh portal page under https://sb.sdn.utm.md:19008/portalpage/.
 *   2. We watch those redirects and "pin" the newest live portal URL. The path
 *      carries a per-session blob plus the client IP/MAC, so an old URL is
 *      worthless — we always use the most recent one.
 *   3. We open that URL in a tab; content.js ticks the terms checkbox and
 *      presses "Conectare".
 *   4. Success is confirmed by polling the CPD canaries until they answer 204
 *      (or by watching the portal navigate its own tab away from itself).
 *   5. When the 2-hour session drops, or the AP roams us onto a new portal
 *      page, steps 1-4 run again automatically.
 *
 * Outbound traffic is limited to the two Firefox canary hosts and the portal
 * host declared in config.json. No other site is ever contacted.
 */

"use strict";

const CONFIG_URL = browser.runtime.getURL("config.json");

/* Defaults mirror config.json; they only matter if that fetch ever fails. */
let CONFIG = {
  HOST: "sb.sdn.utm.md",
  PORTAL_PORT: 19008,
  PORTAL_PATH: "/portalpage/",
  SSID: "UTM-WiNetUni_GUEST",
  CPD_BASES: ["http://detectportal.firefox.com/", "http://captive.apple.com/"],
  CANARY_HOSTS: ["detectportal.firefox.com", "captive.apple.com"],
  REDIRECT_STRIKE_LIMIT: 2,
  STALE_MS: 15000,
  POLL_MS: 3000,
  MAX_POLL_MS: 30000,
  CONNECT_TIMEOUT_MS: 15000,
  COOLDOWN_MS: 20000,
  MAX_ATTEMPTS: 5,
  TAB_TTL_MS: 15000,
  KEEP_TABS: false,
  DEBUG: false
};

let PORTAL_PREFIX = "";   // built from config: scheme + HOST + PORT + PATH
let PORTAL_MATCH = "";    // same, with a trailing "*" for webRequest filters
let STATE_KEY = "autoconnect/state";

const now = () => Date.now();
const log = (...a) => { if (CONFIG.DEBUG) console.log("[autoconnect]", ...a); };
const warn = (...a) => console.warn("[autoconnect]", ...a);

const isPortalUrl = (u) => typeof u === "string" && !!PORTAL_PREFIX && u.startsWith(PORTAL_PREFIX);
const isCanaryUrl = (u) => {
  try { return CONFIG.CANARY_HOSTS.includes(new URL(u).hostname); } catch (e) { return false; }
};

/* ------------------------------------------------------------------ state */

const st = {
  ready: false,
  portalUrl: null,     // freshest live portal URL seen on this network
  portalSeenAt: 0,
  strikes: 0,          // consecutive CPD redirects -> confidence we are captive
  connected: true,     // last verdict of the canary probe
  probing: false,
  attemptTabId: null,
  attemptStartedAt: 0,
  attempts: 0,
  nextTryAt: 0,
  pollTimer: null,
  pollDelay: 3000,
  status: "starting",
  enabled: true,
  stats: { checks: 0, connects: 0, failures: 0 }
};

async function persist() {
  try {
    await browser.storage.local.set({
      [STATE_KEY]: {
        portalUrl: st.portalUrl, connected: st.connected, status: st.status,
        enabled: st.enabled, stats: st.stats, savedAt: now()
      }
    });
  } catch (e) { /* best effort only */ }
}

async function restore() {
  try {
    const o = await browser.storage.local.get(STATE_KEY);
    const s = o && o[STATE_KEY];
    if (!s) return;
    if (typeof s.enabled === "boolean") st.enabled = s.enabled;
    if (s.stats) Object.assign(st.stats, s.stats);
    // Only trust a pinned URL that is still fresh — they expire within seconds.
    if (isPortalUrl(s.portalUrl) && now() - (s.savedAt || 0) < CONFIG.STALE_MS) {
      st.portalUrl = s.portalUrl;
      st.portalSeenAt = s.savedAt;
    }
    if (typeof s.connected === "boolean") st.connected = s.connected;
    st.status = s.status || st.status;
  } catch (e) { warn("restore failed", e); }
}

function setStatus(s) { st.status = s; log(s); broadcast(); persist(); }

/* ------------------------------------------------------------- CPD probe */

async function probeOnce() {
  const bust = `${now()}${Math.random().toString(36).slice(2, 8)}`;
  for (const base of CONFIG.CPD_BASES) {
    try {
      const res = await fetch(`${base}example.org?_=${bust}`, {
        method: "GET", credentials: "omit", cache: "no-store", redirect: "manual"
      });
      // 204 / opaqueredirect => the network is open.
      // 200 with a body      => still captive (Firefox serves the portal HTML).
      if (res.status === 204 || res.type === "opaqueredirect") return true;
      if (res.ok) return false;
    } catch (e) { /* try the next canary */ }
  }
  return null;                        // inconclusive right now
}

async function checkConnection(force) {
  if (st.probing) return;
  st.probing = true;
  let open = null;
  try { open = await probeOnce(); } finally { st.probing = false; }
  st.stats.checks++;

  if (open === null) return;
  if (open === st.connected) {                     // no transition
    if (open) st.pollDelay = Math.min(st.pollDelay * 2, CONFIG.MAX_POLL_MS);
    return;
  }
  st.connected = open;
  st.pollDelay = CONFIG.POLL_MS;
  if (open) setStatus(`connected (${new Date().toLocaleTimeString()})`);
  else {
    setStatus("captive portal detected");
    if (force || st.enabled) scheduleConnect("portal detected");
  }
  persist();
}

/* ------------------------------------------------------------ scheduler */

function armPolling() {
  if (st.pollTimer) clearTimeout(st.pollTimer);
  const delay = st.connected ? st.pollDelay : CONFIG.POLL_MS;
  st.pollTimer = setTimeout(() => {
    st.pollTimer = null;
    checkConnection().then(armPolling).catch(armPolling);
  }, delay);
}

function pruneStaleUrl() {
  if (st.portalUrl && now() - st.portalSeenAt > CONFIG.STALE_MS) {
    st.portalUrl = null;
    st.strikes = 0;
    log("dropped stale portal URL");
    persist();
  }
}

function scheduleConnect(reason) {
  if (!st.ready) return;
  if (!st.enabled) { setStatus("disabled — not connecting"); return; }
  if (st.attemptTabId !== null) { log("attempt already running:", reason); return; }
  if (now() < st.nextTryAt) { log("cooldown:", reason); return; }
  pruneStaleUrl();
  if (!st.portalUrl) { setStatus(`offline (${reason}) — waiting for a portal URL`); return; }
  openPortalTab(reason);
}

/* ------------------------------------------------------- portal tab flow */

async function openPortalTab(reason) {
  const url = st.portalUrl;
  if (!url) return;
  try {
    const tab = await browser.tabs.create({ url, active: true });
    st.attemptTabId = tab.id;
    st.attemptStartedAt = now();
    st.attempts++;
    setAlarm("attempt-timeout", CONFIG.CONNECT_TIMEOUT_MS);
    setStatus(`connecting… (attempt ${st.attempts}, ${reason})`);
  } catch (e) {
    warn("tabs.create failed", e);
    registerFailure(e.message || String(e));
  }
}

function closeAttemptTab() {
  const id = st.attemptTabId;
  st.attemptTabId = null;
  st.attemptStartedAt = 0;
  if (id !== null) browser.tabs.remove(id).catch(() => {});
}

function registerFailure(msg) {
  st.stats.failures++;
  st.nextTryAt = now() + CONFIG.COOLDOWN_MS;
  clearAlarm("attempt-timeout");
  clearAlarm("tab-ttl");
  closeAttemptTab();
  setStatus(`failed: ${msg} — retrying shortly`);
  if (st.attempts >= CONFIG.MAX_ATTEMPTS) {
    st.attempts = 0;
    st.nextTryAt = now() + CONFIG.COOLDOWN_MS * 3;
    setStatus(`gave up after ${CONFIG.MAX_ATTEMPTS} attempts — will retry when the portal reappears`);
  }
  persist();
}

function succeed(where) {
  st.attempts = 0;
  st.strikes = 0;
  st.connected = true;
  st.pollDelay = CONFIG.POLL_MS;
  st.nextTryAt = 0;
  st.stats.connects++;
  clearAlarm("attempt-timeout");
  clearAlarm("tab-ttl");
  if (!CONFIG.KEEP_TABS) closeAttemptTab();
  setStatus(`connected via ${where}`);
}

/* ---------------------------------------------------------------- alarms */

function setAlarm(name, ms) {
  try { browser.alarms.create(name, { delayInMinutes: Math.max(ms / 60000, 0.01) }); }
  catch (e) { warn("alarm create failed", e); }
}
function clearAlarm(name) { try { browser.alarms.clear(name); } catch (e) {} }

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "attempt-timeout") {
    if (st.attemptTabId !== null && !st.connected) registerFailure("timed out waiting for the network to open");
  } else if (a.name === "tab-ttl") {
    if (st.attemptTabId !== null && !st.connected) registerFailure("portal page did not respond");
  } else if (a.name === "stale-check") {
    pruneStaleUrl();
  }
});

/* --------------------------------------------------- webRequest observer */

// CPD requests get redirected to the portal while the network is captive.
browser.webRequest.onBeforeRedirect.addListener(
  (d) => {
    if (!isPortalUrl(d.redirectUrl)) return;
    st.strikes++;
    st.portalSeenAt = now();
    // Only keep a URL that carries this client's own session parameters:
    // uaddress = our IP, umac = our MAC. A URL belonging to another client
    // would show someone else's session page and can never log us in.
    const q = new d.URL(d.redirectUrl).searchParams;
    const mine = !q.get("uaddress") || isOwnAddress(q.get("uaddress"));
    if (!mine) { log("ignoring portal redirect for a foreign client address"); return; }
    st.portalUrl = d.redirectUrl;
    log(`portal URL captured (strike ${st.strikes}/${CONFIG.REDIRECT_STRIKE_LIMIT})`);
    persist();
    if (st.strikes >= CONFIG.REDIRECT_STRIKE_LIMIT) {
      st.connected = false;
      scheduleConnect("captive redirects");
    }
  },
  { urls: CONFIG.CPD_BASES.map((b) => `${b}*`) }
);

/* Best-effort check of the client IP baked into the portal URL. We cannot read
 * our own interface addresses from an extension, so we only reject obviously
 * wrong values (loopback / link-local) and otherwise accept the URL — a stale
 * one is discarded by the bounce handler above anyway. */
function isOwnAddress(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(String(ip));
  if (!m) return true;                       // not IPv4 dotted — let it through
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 127 || a === 0) return false;    // loopback / unspecified
  if (a === 169 && b === 254) return false;  // APIPA
  return true;
}

// Our tab bounced back to a canary -> the pinned portal page had expired.
browser.webRequest.onBeforeRedirect.addListener(
  (d) => {
    if (st.attemptTabId === null || d.tabId !== st.attemptTabId) return;
    if (!isCanaryUrl(d.redirectUrl)) return;
    log("portal bounced back to the canary — dropping the pinned URL");
    st.portalUrl = null;
    st.strikes = 0;
    clearAlarm("attempt-timeout");
    clearAlarm("tab-ttl");
    closeAttemptTab();
    setStatus("pinned portal page expired — waiting for a fresh one");
    persist();
  },
  { urls: [PORTAL_MATCH] }
);

// The portal sent our tab somewhere else -> almost certainly logged in.
browser.webRequest.onBeforeNavigate.addListener(
  (d) => {
    if (st.attemptTabId === null || d.tabId !== st.attemptTabId) return;
    if (isPortalUrl(d.url) || isCanaryUrl(d.url)) return;
    if (/^(about:|chrome:|moz-extension:|data:|view-source:)/.test(d.url)) return;
    log("navigated away from the portal");
    succeed("redirect");
  },
  { urls: ["<all_urls>"] }
);

/* ---------------------------------------------------------- tab lifecycle */

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (st.attemptTabId !== tabId) return;
  if (info.status === "complete" && isPortalUrl(tab.url)) {
    setAlarm("tab-ttl", CONFIG.TAB_TTL_MS);       // safety net for a dead form
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== st.attemptTabId) return;
  clearAlarm("tab-ttl");
  clearAlarm("attempt-timeout");
  const lasted = now() - st.attemptStartedAt;
  st.attemptTabId = null;
  st.attemptStartedAt = 0;
  if (st.connected) return;                       // we closed it ourselves
  if (lasted > 2500) {
    st.portalUrl = null;
    st.strikes = 0;
    setStatus("portal page closed — waiting for a fresh one");
    persist();
  } else {
    registerFailure("portal tab closed too early");
  }
});

/* -------------------------------------------------------------- messages */

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case "ready":
      if (sender.tab && sender.tab.id === st.attemptTabId && isPortalUrl(sender.tab.url)) {
        st.portalUrl = sender.tab.url;
        st.portalSeenAt = now();
      }
      return Promise.resolve({ ok: true });

    case "clicked":
      clearAlarm("tab-ttl");
      setAlarm("attempt-timeout", CONFIG.CONNECT_TIMEOUT_MS);
      setStatus("login submitted — waiting for the network to open");
      checkConnection();
      return Promise.resolve({ ok: true });

    case "done":
      clearAlarm("tab-ttl");
      if (msg.ok) succeed(msg.via || "portal page");
      else registerFailure(msg.error || "portal reported failure");
      return Promise.resolve({ ok: true });

    case "state":
      return Promise.resolve(snapshot());

    case "toggle":
      st.enabled = !!msg.enabled;
      setStatus(st.enabled ? "enabled" : "disabled");
      if (st.enabled) checkConnection(true);
      return Promise.resolve(snapshot());

    case "reconnect":
      st.strikes = CONFIG.REDIRECT_STRIKE_LIMIT;
      st.nextTryAt = 0;
      st.attempts = 0;
      pruneStaleUrl();
      if (!st.portalUrl) checkConnection(true);
      scheduleConnect("manual");
      return Promise.resolve(snapshot());

    default:
      return undefined;
  }
});

function snapshot() {
  return {
    status: st.status,
    connected: st.connected,
    enabled: st.enabled,
    portalUrl: st.portalUrl,
    ssid: CONFIG.SSID,
    host: `${CONFIG.HOST}:${CONFIG.PORTAL_PORT}`,
    attempting: st.attemptTabId !== null,
    attempts: st.attempts,
    stats: st.stats,
    keepTabs: CONFIG.KEEP_TABS,
    ready: st.ready,
    version: browser.runtime.getManifest().version
  };
}

function broadcast() {
  try { browser.runtime.sendMessage({ type: "state", state: snapshot() }).catch(() => {}); } catch (e) {}
}

/* ------------------------------------------------------------- bootstrap */

async function loadConfig() {
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-store" });
    CONFIG = Object.assign({}, CONFIG, JSON.parse(await res.text()));
  } catch (e) { warn("config.json unavailable — using built-in defaults", e); }
  PORTAL_PREFIX = `https://${CONFIG.HOST}:${Number(CONFIG.PORTAL_PORT)}${CONFIG.PORTAL_PATH}`;
  PORTAL_MATCH = `${PORTAL_PREFIX}*`;
  STATE_KEY = `autoconnect/${CONFIG.HOST}/state`;
  st.pollDelay = CONFIG.POLL_MS;
}

async function ensureHostPermission() {
  const origin = `*://${CONFIG.HOST}:${CONFIG.PORTAL_PORT}/`;
  try {
    if (await browser.permissions.contains({ origins: [origin] })) return true;
    const granted = await browser.permissions.request({ origins: [origin] });
    if (!granted) setStatus("host permission declined — auto-connect cannot work");
    return granted;
  } catch (e) { warn("permission request failed", e); return false; }
}

async function boot() {
  await loadConfig();
  await restore();
  await ensureHostPermission();
  st.ready = true;
  armPolling();
  setAlarm("stale-check", CONFIG.STALE_MS);
  checkConnection(true);
  broadcast();
}

browser.runtime.onInstalled.addListener(() => { boot(); });
boot();
