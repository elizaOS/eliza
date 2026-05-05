"""Repair markdown-bullet style values in synthesized TOON records.

gpt-oss-120b and similar instruction-tuned teachers sometimes emit:

    strengths:
    - Clear tone.
    - Prompt response.

That is not valid TOON — `strengths:` has no value and the bullets look
like new keys to the parser. This transform walks a synthesized JSONL,
detects this pattern, and rewrites it as TOON array form:

    strengths[2]:
      - Clear tone.
      - Prompt response.

Idempotent on already-valid TOON. Records whose `expectedResponse`
parses cleanly are left untouched.

Usage::

    python scripts/transform_repair_toon_bullets.py \
        --input  data/synthesized/evaluators/reflection.jsonl \
        --output data/synthesized/evaluators/reflection.jsonl

(In-place edits are supported because the script writes to a temp file
and atomically renames.)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.toon import ToonDecoder  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("repair-toon")


_INDEXED_RE = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]\s*:\s*(.+)$")


def repair(s: str) -> str:
    """Two repair passes.

    1. Markdown-bullet repair:
            strengths:
            - Foo
            - Bar
       → strengths[2]:
           - Foo
           - Bar

    2. Per-item indexed-assign repair (model emitted each item as its own
       indexed line — common with gpt-oss for `topics[N]:`/`keyPoints[N]:`):
            topics[0]: Career promotion
            topics[1]: Team composition
            topics[2]: Personal details
       → topics[3]:
           - Career promotion
           - Team composition
           - Personal details

    Idempotent. Conservative — only collapses runs of consecutive lines
    sharing the same key, indices 0..n-1, with non-empty values."""
    lines = s.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]

        # Repair pass 2 first — it's a stricter pattern. Look for a run of
        # `key[idx]: value` lines starting at index 0, 1, 2, ... .
        m_idx = _INDEXED_RE.match(line)
        if m_idx and m_idx.group(2) == "0":
            key = m_idx.group(1)
            items = [m_idx.group(3).strip()]
            k = i + 1
            expected = 1
            while k < len(lines):
                m2 = _INDEXED_RE.match(lines[k])
                if not m2 or m2.group(1) != key or m2.group(2) != str(expected):
                    break
                items.append(m2.group(3).strip())
                expected += 1
                k += 1
            if len(items) >= 2:
                out.append(f"{key}[{len(items)}]:")
                for v in items:
                    out.append(f"  - {v}")
                i = k
                continue

        # Repair pass 1 — markdown bullet body for a bare `key:` line.
        m_bare = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*$", line)
        if m_bare:
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            bullets: list[str] = []
            k = j
            while k < len(lines) and lines[k].lstrip().startswith("- "):
                bullets.append(lines[k].lstrip()[2:].strip())
                k += 1
            if bullets:
                key = m_bare.group(1)
                out.append(f"{key}[{len(bullets)}]:")
                for b in bullets:
                    out.append(f"  - {b}")
                i = k
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--keep-unparseable", action="store_true",
                   help="keep records whose expectedResponse still doesn't "
                   "parse after the repair pass (default: drop them)")
    args = p.parse_args()

    decoder = ToonDecoder()

    in_path = args.input
    out_path = args.output
    if not in_path.exists():
        log.error("input not found: %s", in_path)
        return 2

    in_place = (in_path.resolve() == out_path.resolve())
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp") if in_place else out_path

    n_total = n_already_ok = n_repaired = n_dropped = 0

    with in_path.open("r", encoding="utf-8") as fin, \
         tmp_path.open("w", encoding="utf-8") as fout:
        for line in fin:
            line = line.rstrip("\n")
            if not line:
                continue
            n_total += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                n_dropped += 1
                continue

            er = rec.get("expectedResponse") or ""
            try:
                decoder.decode(er)
                # Already parses; keep verbatim.
                fout.write(line + "\n")
                n_already_ok += 1
                continue
            except (ValueError, RuntimeError):
                pass

            repaired = repair(er)
            try:
                decoder.decode(repaired)
            except (ValueError, RuntimeError):
                if args.keep_unparseable:
                    rec["expectedResponse"] = repaired
                    rec.setdefault("metadata", {})["toon_repair"] = "unparseable"
                    fout.write(json.dumps(rec) + "\n")
                else:
                    n_dropped += 1
                continue

            rec["expectedResponse"] = repaired
            rec.setdefault("metadata", {})["toon_repair"] = "bullets_to_array"
            fout.write(json.dumps(rec) + "\n")
            n_repaired += 1

    if in_place:
        os.replace(tmp_path, out_path)

    log.info(
        "in=%s out=%s total=%d ok=%d repaired=%d dropped=%d",
        in_path, out_path, n_total, n_already_ok, n_repaired, n_dropped,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
