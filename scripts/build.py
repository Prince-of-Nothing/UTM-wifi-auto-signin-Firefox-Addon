#!/usr/bin/env python3
"""Package the extension into a signature-ready XPI (deterministic ZIP).

Usage:  python3 scripts/build.py [--out dist]
Output: dist/utm-guest-autoconnect-<version>.xpi

The archive carries the complete, unminified source (Mozilla policy: a signed
add-on must be self-contained and reviewable as shipped) plus a copy of this
repo's README.md. Entries are sorted and timestamps fixed, so two runs produce
byte-identical files — handy for reproducibility checks after signing.
Standard library only.
"""

import argparse
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
DEFAULT_DATE = (2026, 1, 1, 0, 0, 0)


def gather(base: Path):
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            full = Path(dirpath) / name
            out.append((full.relative_to(base).as_posix(), full))
    return sorted(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a signable XPI")
    ap.add_argument("--out", default="dist", help="output directory (default: dist)")
    ap.add_argument("--name", default="utm-guest-autoconnect", help="archive basename")
    args = ap.parse_args()

    if not SRC.is_dir():
        print(f"error: {SRC} not found", file=sys.stderr)
        return 1

    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version", "0.0.0")
    files = gather(SRC)
    if not files:
        print("error: nothing to package", file=sys.stderr)
        return 1

    readme = ROOT / "README.md"
    extra = [("README.md", readme)] if readme.is_file() else []

    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    xpi = out_dir / f"{args.name}-{version}.xpi"

    with zipfile.ZipFile(xpi, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for rel, full in files + extra:
            info = zipfile.ZipInfo(rel, date_time=DEFAULT_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o644 & 0xFFFF) << 16
            info.create_system = 3          # unix, avoids DOS-mapping surprises
            z.writestr(info, full.read_bytes())

    digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
    total_in = sum(p.stat().st_size for _, p in files + extra)
    print(f"packed {len(files) + len(extra)} files ({total_in} B source -> {xpi.stat().st_size} B xpi)")
    try:
        shown = xpi.relative_to(ROOT)
    except ValueError:
        shown = xpi
    print(f"wrote  {shown}")
    print(f"sha256 {digest}")
    print("\nNext step — sign it:\n  npm i -g web-ext\n  export AMO_API_KEY=... AMO_API_SECRET=...\n  web-ext sign --source-dir extension --artifacts-dir dist")
    return 0


if __name__ == "__main__":
    sys.exit(main())
