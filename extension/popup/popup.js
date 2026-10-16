/* UTMSDN Guest Auto-Connect — popup logic (no dependencies). */

"use strict";

const $ = (id) => document.getElementById(id);

function classify(s) {
  if (!s) return "warn";
  const t = s.toLowerCase();
  if (t.startsWith("connected")) return "ok";
  if (t.startsWith("connecting") || t === "starting" || t.includes("waiting") || t.includes("submitted")) return "busy";
  if (t.includes("fail") || t.includes("gave up") || t.includes("declined")) return "err";
  if (t === "disabled") return "off";
  return "warn";
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

let lastConnectedAt = null;

function render(state) {
  if (!state) return;
  const cls = classify(state.status);
  const el = $("status");
  el.textContent = state.status;
  el.className = `state ${cls}`;

  $("net").textContent = state.ssid || "—";
  $("host").textContent = state.host || "—";
  $("enabled").checked = !!state.enabled;

  if (state.connected && !lastConnectedAt) lastConnectedAt = Date.now();
  if (!state.connected) lastConnectedAt = null;
  $("session").textContent = state.connected ? `online · uptime ${fmtUptime(Date.now() - lastConnectedAt)} · max 2h` : "offline — reconnecting";

  const st = state.stats || {};
  $("totals").textContent = `${st.connects || 0} connects · ${st.failures || 0} failures · ${st.checks || 0} checks`;
  $("url").textContent = state.portalUrl ? `${state.portalUrl}\n\nattempt: ${state.attempting ? "yes" : "no"}\nattempts: ${state.attempts}` : "no live portal URL captured yet";
  $("ver").textContent = state.version || "";
}

$("enabled").addEventListener("change", async (e) => {
  const s = await browser.runtime.sendMessage({ type: "toggle", enabled: e.target.checked });
  render(s);
});

$("reconnect").addEventListener("click", async () => {
  render(await browser.runtime.sendMessage({ type: "reconnect" }));
});

browser.runtime.onMessage.addListener((m) => { if (m && m.type === "state") render(m.state); });

(async () => {
  try { render(await browser.runtime.sendMessage({ type: "state" })); }
  catch (e) { $("status").textContent = "background worker is asleep — reopen in a second"; }
})();

setInterval(() => {
  if (lastConnectedAt) $("session").textContent = `online · uptime ${fmtUptime(Date.now() - lastConnectedAt)} · max 2h`;
}, 1000);
