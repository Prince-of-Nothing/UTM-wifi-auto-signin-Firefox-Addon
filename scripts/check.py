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

desc = manifest.get("description", "")
if len(desc) < 40:
    fail("description must clearly explain what the add-on does (No Surprises policy)")
else:
    ok(f"description present ({len(desc)} chars)")

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

if manifest.get("optional_permissions"):
    fail("optional_permissions not needed — drop them to keep the grant story simple")
else:
    ok("no optional_permissions")

# ------------------------------------------------------------ file integrity
bg = manifest["background"]["scripts"]
if bg != ["background/background.js"]:
    fail(f"background scripts unexpected: {bg}")
for rel in bg + cs[0]["js"]:
    if not (SRC / rel).is_file():
        fail(f"declared file missing: extension/{rel}")
ba = manifest["browser_action"]
if ba.get("default_popup"):
    fail("no popup expected — the toolbar icon is the on/off switch")
elif "onClicked" not in (SRC / "background" / "background.js").read_text():
    fail("background must handle browserAction.onClicked (the icon toggle)")
else:
    ok("icon click handler present, no popup to maintain")
for size, icon in manifest["icons"].items():
    if not (SRC / icon).is_file():
        fail(f"icon missing: extension/{icon}")
for state in ("on", "off", "busy", "wait"):
    if not (SRC / "icons" / f"icon-{state}.svg").is_file():
        fail(f"state icon missing: extension/icons/icon-{state}.svg")
ok("all referenced files exist")

if not (SRC / "config.json").is_file():
    fail("config.json missing")
else:
    ok(f"config.json: {host}:{cfg['PORTAL_PORT']}{cfg['PORTAL_PATH']}")

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

# ----------------------------------------------------- remote code / eval / hosts
BANNED = [
    (r"\beval\s*\(", "eval()"),
    (r"new\s+Function\s*\(", "new Function()"),
    (r"\bdocument\.write\s*\(", "document.write()"),
    (r"\binnerHTML\s*=", "innerHTML assignment"),
    (r"createElement\s*\(\s*['\"]script", "injected <script>"),
    (r"https?://[\w.-]+\.(?:js|wasm)\b", "remote script reference"),
]
for js in sorted(SRC.rglob("*.js")):
    body = js.read_text(encoding="utf-8")
    code = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    code = re.sub(r"//[^\n]*", "", code)
    for pat, name in BANNED:
        if re.search(pat, code):
            fail(f"{js.relative_to(ROOT)} uses banned construct: {name}")
ok("no eval/remote-code constructs")

for js in list(SRC.rglob("*.js")):
    body = js.read_text(encoding="utf-8")
    code_only = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    code_only = re.sub(r"(?m)^\s*(//).*$", "", code_only)
    code_urls = set(re.findall(r"https?://[A-Za-z0-9.\-]+(?::\d+)?", code_only))
    foreign = {u for u in code_urls if host not in u and not any(c in u for c in cfg["CANARY_HOSTS"])}
    if foreign:
        fail(f"{js.relative_to(ROOT)} references other hosts: {sorted(foreign)}")
ok("no third-party hosts referenced")

total = sum(p.stat().st_size for p in SRC.rglob("*") if p.is_file())
print(f"\nsource size: {total} bytes across {len([p for p in SRC.rglob('*') if p.is_file()])} files")
if problems:
    print(f"\n{len(problems)} problem(s) found")
    sys.exit(1)
print("\nAll checks passed.")
