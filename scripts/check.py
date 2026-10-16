#!/usr/bin/env python3
"""Validate the extension before signing: manifest shape, JSON, JS syntax.

Usage:  python3 scripts/check.py
Exits non-zero on any problem so it can gate a build/sign pipeline.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
problems = []


def fail(msg):
    problems.append(msg)
    print(f"FAIL  {msg}")


def ok(msg):
    print(f"ok    {msg}")


# ------------------------------------------------------------------ manifest
manifest_path = SRC / "manifest.json"
if not manifest_path.is_file():
    print(f"FAIL  {manifest_path} missing")
    sys.exit(1)

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
cfg = json.loads((SRC / "config.json").read_text(encoding="utf-8"))

if manifest["manifest_version"] != 2:
    fail("expected manifest_version 2 (MV2 keeps this extension tiny and permission-stable)")
else:
    ok("manifest_version 2")

bss = manifest.get("browser_specific_settings", {}).get("gecko", {})
ext_id = bss.get("id")
if not ext_id or not re.match(r"^[^@\s]+@[^@\s]+$|^\{.*\}$", ext_id):
    fail("browser_specific_settings.gecko.id is required for signing/persistence")
else:
    ok(f"gecko id: {ext_id}")
if not bss.get("strict_min_version"):
    fail("strict_min_version should be pinned")
else:
    ok(f"strict_min_version: {bss['strict_min_version']}")

# ------------------------------------------------------- single-site scoping
host = cfg["HOST"]
portal_match = f"https://{host}:{cfg['PORTAL_PORT']}{cfg['PORTAL_PATH']}*"
cs = manifest["content_scripts"]
if len(cs) != 1:
    fail("exactly one content script entry expected")
elif cs[0]["matches"] != [portal_match]:
    fail(f"content script must match only {portal_match}, got {cs[0]['matches']}")
else:
    ok(f"content script scoped to one site: {portal_match}")

perms = manifest["permissions"]
allowed = {
    "webRequest", "tabs", "storage", "alarms",
    f"*://{host}:{cfg['PORTAL_PORT']}/*",
    *[f"*://{c}/*" for c in cfg["CANARY_HOSTS"]],
}
extra = set(perms) - allowed
missing = allowed - set(perms)
if "<all_urls>" in perms or "mozillaAddons" in perms:
    fail("over-broad permission present")
elif extra:
    fail(f"unexpected permissions: {sorted(extra)}")
elif missing:
    fail(f"missing permissions: {sorted(missing)}")
else:
    ok(f"permissions minimal and host-scoped ({len(perms)} entries)")

optional = set(manifest.get("optional_permissions", []))
if optional and not all(host in o for o in optional):
    fail(f"optional_permissions must stay on {host}: {sorted(optional)}")
else:
    ok("optional_permissions stay on the portal host")

# ------------------------------------------------------------ file integrity
bg = manifest["background"]["scripts"]
if bg != ["background/background.js"]:
    fail(f"background scripts unexpected: {bg}")
for rel in bg + cs[0]["js"]:
    if not (SRC / rel).is_file():
        fail(f"declared file missing: extension/{rel}")
popup = manifest["browser_action"]["default_popup"]
for rel in (popup, popup.replace(".html", ".css"), popup.replace(".html", ".js")):
    if not (SRC / rel).is_file():
        fail(f"popup asset missing: extension/{rel}")
for size, icon in manifest["icons"].items():
    if not (SRC / icon).is_file():
        fail(f"icon missing: extension/{icon}")
ok("all referenced files exist")

if not (SRC / "config.json").is_file():
    fail("config.json missing")
else:
    ok(f"config.json: {host}:{cfg['PORTAL_PORT']}{cfg['PORTAL_PATH']} ssid={cfg['SSID']}")

# ---------------------------------------------------------------- js syntax
node = shutil.which("node")
if node:
    for js in sorted(SRC.rglob("*.js")):
        r = subprocess.run([node, "--check", str(js)], capture_output=True, text=True)
        if r.returncode != 0:
            fail(f"syntax error in {js.relative_to(ROOT)}:\n{r.stderr.strip()}")
        else:
            ok(f"node --check {js.relative_to(ROOT)}")
else:
    print("note  node not found — skipped JS syntax check")

# -------------------------------------------------------------- hard-coded host
for js in list(SRC.rglob("*.js")) + [SRC / "popup" / "popup.html"]:
    body = js.read_text(encoding="utf-8")
    urls = set(re.findall(r"https?://[A-Za-z0-9.\-]+(?::\d+)?", body))
    # Comments are stripped first: prose about the portal URL is not a request.
    code_only = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    code_urls = set(re.findall(r"https?://[A-Za-z0-9.\-]+(?::\d+)?", code_only))
    foreign = {u for u in code_urls if host not in u and not any(c in u for c in cfg["CANARY_HOSTS"])}
    if foreign:
        fail(f"{js.relative_to(ROOT)} references other hosts: {sorted(foreign)}")
ok("no third-party hosts referenced")

total = sum(p.stat().st_size for p in SRC.rglob("*") if p.is_file())
print(f"\nsource size: {total} bytes across {len(list(SRC.rglob('*')))} entries")
if problems:
    print(f"\n{len(problems)} problem(s) found")
    sys.exit(1)
print("\nAll checks passed.")
