/* UTM Guest Auto-Connect — background worker (Manifest V2, event driven).
 *
 * What it does
 *   1. While Firefox thinks a network is closed off, it probes small
 *      captive-portal-detection (CPD) canaries. On this network every probe is
 *      redirected to a fresh portal page under https://sb.sdn.utm.md:19008/
 *      portalpage/. We watch those redirects and remember the newest live URL
 *      (the query string carries our own client IP/MAC, so an old or foreign
 *      URL is worthless).
 *   2. We load that URL in a BACKGROUND tab (never focused, never brought to
 *      the front), content.js ticks the terms checkbox and presses "Conectare",
 *      and we close the tab as soon as the attempt ends.
 *   3. Success is confirmed by re-probing the CPD canaries: they answer 204
 *      once the network is open. When the 2-hour session drops, steps 1-3 run
 *      again automatically.
 *   4. Toggling the toolbar icon switches the automatic behaviour on/off; the
 *      icon itself reflects the current state.
 *
 * Outbound traffic goes only to the two Firefox canary hosts and the portal
 * host named in config.json. Nothing else is contacted, nothing is stored
 * beyond one small state record in browser.storage.local. No credentials are
 * involved: this portal logs in anonymously.
 */

'use strict';

const CONFIG_URL = browser.runtime.getURL('config.json');

/* Defaults mirror config.json; they only matter if that read ever fails. */
let CONFIG = {
  HOST: 'sb.sdn.utm.md',
  PORTAL_PORT: 19008,
  PORTAL_PATH: '/portalpage/',
  CANARY_HOSTS: ['detectportal.firefox.com', 'captive.apple.com'],
  REDIRECT_STRIKE_LIMIT: 2,
  STALE_MS: 15000,
  POLL_MS: 3000,
  MAX_POLL_MS: 30000,
  CONNECT_TIMEOUT_MS: 15000,
  COOLDOWN_MS: 20000,
  MAX_ATTEMPTS: 5,
  DEBUG: false,
  // LOCAL TESTING ONLY (see _comment_local_testing_only in config.json):
  // a portal URL to fall back on when no live captive-portal redirect has
  // been observed yet, i.e. when you are NOT actually on the UTM network.
  portalUrl: null,
};

let PORTAL_PREFIX = '';            // scheme + host + port + path
let STATE_KEY = 'autoconnect/state';

const now = () => Date.now();
const log = (...a) => { if (CONFIG.DEBUG) console.log('[autoconnect]', ...a); };
const warn = (...a) => console.warn('[autoconnect]', ...a);
const isPortalUrl = (u) => typeof u === 'string' && !!PORTAL_PREFIX && u.startsWith(PORTAL_PREFIX);
const isCanaryUrl = (u) => { try { return CONFIG.CANARY_HOSTS.includes(new URL(u).hostname); } catch (e) { return false; } };

const st = {
  ready: false,
  enabled: true,       // master switch, flipped by tapping the toolbar icon
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
  status: 'starting',
  stats: { checks: 0, connects: 0, failures: 0 },
};

async function persist() {
  try {
    await browser.storage.local.set({
      [STATE_KEY]: {
        enabled: st.enabled, portalUrl: st.portalUrl, connected: st.connected,
        status: st.status, stats: st.stats, savedAt: now(),
      },
    });
  } catch (e) { /* best effort only */ }
}

async function restore() {
  try {
    const o = await browser.storage.local.get(STATE_KEY);
    const s = o && o[STATE_KEY];
    if (!s) return;
    if (typeof s.enabled === 'boolean') st.enabled = s.enabled;
    if (s.stats) Object.assign(st.stats, s.stats);
    if (typeof s.connected === 'boolean') st.connected = s.connected;
    st.status = s.status || st.status;
    // Portal URLs expire within seconds — only reuse a fresh one.
    if (isPortalUrl(s.portalUrl) && now() - (s.savedAt || 0) < CONFIG.STALE_MS) {
      st.portalUrl = s.portalUrl;
      st.portalSeenAt = s.savedAt;
    }
  } catch (e) { warn('restore failed', e); }
}

function setStatus(s) { st.status = s; log(s); refreshIcon(); persist(); }

/* -------------------------------------------------------------- icon state */

function badge(text, colour) {
  try { browser.browserAction.setBadgeText({ text: text || '' }); } catch (e) {}
  if (colour) { try { browser.browserAction.setBadgeBackgroundColor({ color: colour }); } catch (e) {} }
}

function refreshTitle() {
  const t = `UTM Guest Auto-Connect — ${st.enabled ? 'automatic connect ON' : 'automatic connect OFF (click to resume)'}\n${st.status}`;
  try { browser.browserAction.setTitle({ title: t }); } catch (e) {}
}

function refreshIcon() {
  refreshTitle();
  const file = !st.enabled ? 'off' : st.connected ? 'on' : st.attemptTabId !== null ? 'busy' : 'wait';
  try { browser.browserAction.setIcon({ path: `icons/icon-${file}.svg` }); } catch (e) {}
  if (!st.enabled) badge('', null);
  else if (st.attemptTabId !== null) badge('…', '#0a84ff');
  else if (!st.connected) badge('!', '#d70022');
  else badge('', null);
}

/* ------------------------------------------------------------- CPD probe */

async function probeOnce() {
  const bust = `${now()}${Math.random().toString(36).slice(2, 8)}`;
  for (const base of CONFIG.CANARY_HOSTS.map((h) => `http://${h}/`)) {
    try {
      const res = await fetch(`${base}example.org?_=${bust}`, {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'manual',
      });
      // 204 / opaqueredirect => the network is open.
      // 200 with a body      => still behind the portal.
      if (res.status === 204 || res.type === 'opaqueredirect') return true;
      if (res.ok) return false;
    } catch (e) { /* try the next canary */ }
  }
  return null;                     // inconclusive right now
}

async function checkConnection(force) {
  if (st.probing) return;
  st.probing = true;
  let open = null;
  try { open = await probeOnce(); } finally { st.probing = false; }
  st.stats.checks++;
  if (open === null) return;

  if (open === st.connected) {                    // no transition
    if (open) st.pollDelay = Math.min(st.pollDelay * 2, CONFIG.MAX_POLL_MS);
    return;
  }
  st.connected = open;
  st.pollDelay = CONFIG.POLL_MS;
  if (open) setStatus(`connected (${new Date().toLocaleTimeString()})`);
  else {
    setStatus('captive portal detected');
    if (force || st.enabled) scheduleConnect('portal detected');
  }
  refreshIcon();
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
    log('dropped stale portal URL');
    persist();
  }
}

function scheduleConnect(reason) {
  if (!st.ready) return;
  if (!st.enabled) { setStatus('automatic connect is off'); return; }
  if (st.attemptTabId !== null) { log('attempt already running:', reason); return; }
  if (now() < st.nextTryAt) { log('cooldown:', reason); return; }
  pruneStaleUrl();
  if (!st.portalUrl) { setStatus(`waiting for a fresh portal page (${reason})`); return; }
  openPortalTab(reason);
}

/* ------------------------------------------------------- portal tab flow */

async function openPortalTab(reason) {
  const url = st.portalUrl;
  if (!url) return;
  try {
    // Background tab: inactive, created at the end of the last window, and we
    // never call tabs.update({}, active:true) — the user's view is untouched.
    const tab = await browser.tabs.create({ url, active: false });
    st.attemptTabId = tab.id;
    st.attemptStartedAt = now();
    st.attempts++;
    setAlarm('attempt-timeout', CONFIG.CONNECT_TIMEOUT_MS);
    setStatus(`connecting in the background (attempt ${st.attempts}, ${reason})`);
  } catch (e) {
    warn('tabs.create failed', e);
    registerFailure(e.message || String(e));
  }
}

function closeAttemptTab() {
  const id = st.attemptTabId;
  st.attemptTabId = null;
  st.attemptStartedAt = 0;
  if (id !== null) browser.tabs.remove(id).catch(() => {});
  refreshIcon();
}

function registerFailure(msg) {
  st.stats.failures++;
  st.nextTryAt = now() + CONFIG.COOLDOWN_MS;
  clearAlarm('attempt-timeout');
  closeAttemptTab();
  setStatus(`failed: ${msg} — retrying shortly`);
  if (st.attempts >= CONFIG.MAX_ATTEMPTS) {
    st.attempts = 0;
    st.nextTryAt = now() + CONFIG.COOLDOWN_MS * 3;
    setStatus(`paused after ${CONFIG.MAX_ATTEMPTS} attempts — resumes when a new portal page appears`);
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
  clearAlarm('attempt-timeout');
  closeAttemptTab();
  setStatus(`connected via ${where}`);
}

/* ---------------------------------------------------------------- alarms */

function setAlarm(name, ms) {
  try { browser.alarms.create(name, { delayInMinutes: Math.max(ms / 60000, 0.01) }); }
  catch (e) { warn('alarm create failed', e); }
}
function clearAlarm(name) { try { browser.alarms.clear(name); } catch (e) {} }

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === 'attempt-timeout') {
    if (st.attemptTabId !== null && !st.connected) registerFailure('timed out waiting for the network to open');
  } else if (a.name === 'stale-check') {
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
    // Keep only a URL that carries this client's own session parameters:
    // uaddress = our IP, umac = our MAC. Someone else's URL can never log us in.
    try {
      const q = new URL(d.redirectUrl).searchParams;
      const ip = q.get('uaddress');
      if (ip && /^(127\.|0\.|169\.254\.)/.test(ip)) { log('ignoring portal redirect with an unusable client address'); return; }
    } catch (e) { /* malformed query — skip the check */ }
    st.portalUrl = d.redirectUrl;
    log(`portal URL captured (strike ${st.strikes}/${CONFIG.REDIRECT_STRIKE_LIMIT})`);
    persist();
    if (st.strikes >= CONFIG.REDIRECT_STRIKE_LIMIT) {
      st.connected = false;
      refreshIcon();
      scheduleConnect('captive redirects');
    }
  },
  { urls: CONFIG.CANARY_HOSTS.map((h) => `http://${h}/*`) }
);

// Our background tab bounced back to a canary -> the pinned page had expired.
browser.webRequest.onBeforeRedirect.addListener(
  (d) => {
    if (st.attemptTabId === null || d.tabId !== st.attemptTabId) return;
    if (!isCanaryUrl(d.redirectUrl)) return;
    log('portal bounced back to the canary — dropping the pinned URL');
    st.portalUrl = null;
    st.strikes = 0;
    clearAlarm('attempt-timeout');
    closeAttemptTab();
    setStatus('portal page expired — waiting for a fresh one');
    persist();
  },
  { urls: [`https://${CONFIG.HOST}:${Number(CONFIG.PORTAL_PORT)}/*`] }
);

/* ---------------------------------------------------------- tab lifecycle */

browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== st.attemptTabId) return;
  clearAlarm('attempt-timeout');
  st.attemptTabId = null;
  const lasted = now() - st.attemptStartedAt;
  st.attemptStartedAt = 0;
  refreshIcon();
  if (st.connected) return;                       // we closed it ourselves
  if (lasted > 2500) {
    st.portalUrl = null;
    st.strikes = 0;
    setStatus('portal page closed — waiting for a fresh one');
    persist();
  } else {
    registerFailure('portal tab closed too early');
  }
});

/* -------------------------------------------------------------- messages */

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case 'clicked':
      log('content.js submitted the form from tab', sender.tab && sender.tab.id);
      clearAlarm('attempt-timeout');
      setAlarm('attempt-timeout', CONFIG.CONNECT_TIMEOUT_MS);
      setStatus('login submitted — waiting for the network to open');
      checkConnection();
      return Promise.resolve({ ok: true });

    case 'done':
      clearAlarm('attempt-timeout');
      if (msg.ok) succeed(msg.via || 'portal page');
      else registerFailure(msg.error || 'portal reported failure');
      return Promise.resolve({ ok: true });

    default:
      return undefined;
  }
});

/* --------------------------------------------------------- icon activation */

// The toolbar icon IS the switch: one click stops automatic connecting, the
// next click resumes it and immediately retries. No popup, no dialog.
browser.browserAction.onClicked.addListener(() => {
  st.enabled = !st.enabled;
  if (!st.enabled) {
    clearAlarm('attempt-timeout');
    closeAttemptTab();
    setStatus('automatic connect is off — click the icon to resume');
  } else {
    setStatus('automatic connect is on');
    st.attempts = 0;
    st.nextTryAt = 0;
    checkConnection(true);
    scheduleConnect('switched on');
  }
  refreshIcon();
  persist();
});

/* ------------------------------------------------------------- bootstrap */

async function loadConfig() {
  try {
    CONFIG = Object.assign({}, CONFIG, JSON.parse(await (await fetch(CONFIG_URL, { cache: 'no-store' })).text()));
  } catch (e) { warn('config.json unavailable — using built-in defaults', e); }
  PORTAL_PREFIX = `https://${CONFIG.HOST}:${Number(CONFIG.PORTAL_PORT)}${CONFIG.PORTAL_PATH}`;
  STATE_KEY = `autoconnect/${CONFIG.HOST}/state`;
  st.pollDelay = CONFIG.POLL_MS;
}

async function boot() {
  await loadConfig();
  await restore();
  if (st.portalUrl === null && CONFIG.portalUrl && isPortalUrl(CONFIG.portalUrl)) {
    st.portalUrl = CONFIG.portalUrl;
    st.portalSeenAt = now();
    warn('TEST MODE: using the hardcoded portalUrl from config.json instead of a live captive-portal redirect.');
  }
  st.ready = true;
  refreshIcon();
  armPolling();
  setAlarm('stale-check', CONFIG.STALE_MS);
  checkConnection(true);
}

browser.runtime.onInstalled.addListener(() => { boot(); });
boot();
