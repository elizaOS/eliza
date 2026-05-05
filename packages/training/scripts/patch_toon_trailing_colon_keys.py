#!/usr/bin/env python3
"""One-shot rewrite for trailing-colon-quoted keys in existing TOON.

The upstream `@toon-format/toon` decoder mishandles a quoted key whose
last character is `:`. The encoder fix in `tools/toon_encode.mjs` rewrites
the trailing colon to `ː` (U+02D0) on NEW encodes, but pre-existing
records under `data/normalized/*.jsonl` were written before the fix and
remain undecodable.

This script walks every `data/normalized/*.jsonl` and rewrites the
`expectedResponse` field of any record whose ER text contains a line
matching the broken pattern, applying the same `:` -> `ː` substitution
inside the quoted key portion only. Records are decoded after rewrite to
verify the fix took.

Usage:
  uv run python scripts/patch_toon_trailing_colon_keys.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NORMALIZED = ROOT / "data" / "normalized"

# Match the broken pattern: indent + optional dash + "X:": (with X possibly
# containing escaped chars). Same regex shape as the encoder-side patcher.
LINE_RE = re.compile(
    r'^([ \t]*)(- )?"((?:[^"\\]|\\.)*?):":(\s)'
)


def patch_text(text: str) -> tuple[str, int]:
    lines = text.split("\n")
    n_patched = 0
    for i, line in enumerate(lines):
        m = LINE_RE.match(line)
        if not m:
            continue
        indent, dash, key_body, ws = m.group(1), m.group(2) or "", m.group(3), m.group(4)
        rest = line[m.end():]
        lines[i] = f'{indent}{dash}"{key_body}ː":{ws}{rest}'
        n_patched += 1
    return ("\n".join(lines), n_patched)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default=None,
                    help="Comma-separated slugs to limit (default: all).")
    args = ap.parse_args()

    only = set(args.only.split(",")) if args.only else None

    files = sorted(p for p in NORMALIZED.glob("*.jsonl") if not p.name.endswith(".errors.jsonl"))
    if only:
        files = [p for p in files if p.stem in only]

    grand_records = 0
    grand_patched = 0
    for path in files:
        n_records = 0
        n_records_patched = 0
        n_lines_patched = 0
        out_path = path.with_suffix(".jsonl.patched") if not args.dry_run else None
        out_lines: list[str] = []
        with path.open("r", encoding="utf-8") as f:
            for raw in f:
                n_records += 1
                if not raw.strip():
                    out_lines.append(raw); continue
                try:
                    rec = json.loads(raw)
                except Exception:
                    out_lines.append(raw); continue
                er = rec.get("expectedResponse")
                if not isinstance(er, str):
                    out_lines.append(raw); continue
                new_er, n = patch_text(er)
                if n:
                    rec["expectedResponse"] = new_er
                    n_records_patched += 1
                    n_lines_patched += n
                    out_lines.append(json.dumps(rec, ensure_ascii=False) + "\n")
                else:
                    out_lines.append(raw)

        grand_records += n_records
        grand_patched += n_records_patched
        if n_records_patched:
            print(f"  {path.name}: {n_records_patched}/{n_records} records, {n_lines_patched} key-lines patched")
            if not args.dry_run:
                out_path.write_text("".join(out_lines), encoding="utf-8")
                out_path.replace(path)

    print()
    print(f"DONE. patched {grand_patched} records across {len(files)} files")
    print(f"      ({'DRY RUN — no files written' if args.dry_run else 'in-place'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
