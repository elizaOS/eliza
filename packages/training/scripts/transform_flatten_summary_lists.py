"""Flatten dict-shaped `keyPoints[N]` / `topics[N]` items in synthesized
summarization records.

The teacher (gpt-oss-120b) emits items like:

    keyPoints[3]:
      - Started 1:1 meetings with the new team.
      - ...

But the literal `1:1` inside the bullet body parses as a sub-key/value
pair under the bullet, so the decoder reads:

    {"Started 1": "1 meetings with the new team."}

instead of a flat string. ~40 % of summarization records are affected.

This transform walks each record. If `topics`/`keyPoints` is a list of
items where any element is a `{"k": "v"}` single-pair dict, it joins the
pair with a colon to recover the original sentence:

    {"Started 1": "1 meetings with the new team."}
        → "Started 1:1 meetings with the new team."

Idempotent on already-flat lists.

Usage::

    python scripts/transform_flatten_summary_lists.py \
        --input  data/synthesized/evaluators/summarization.jsonl \
        --output data/synthesized/evaluators/summarization.jsonl
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.toon import ToonDecoder, ToonEncoder  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("flatten-summary")


def _flatten(item):
    """If `item` is a single-key dict whose value is a string, recover
    `f"{key}:{value}"`. Recursively walk nested dicts that wrap a single
    pair (rare). Otherwise return the item untouched."""
    if isinstance(item, dict) and len(item) == 1:
        k, v = next(iter(item.items()))
        if isinstance(v, str):
            return f"{k}:{v}"
        if isinstance(v, dict) and len(v) == 1:
            kk, vv = next(iter(v.items()))
            if isinstance(vv, str):
                return f"{k}:{kk}:{vv}"
    return item


def fix_record(rec: dict) -> tuple[dict, bool]:
    er = rec.get("expectedResponse")
    if not isinstance(er, str):
        return rec, False
    try:
        decoded = ToonDecoder().decode(er)
    except (ValueError, RuntimeError):
        return rec, False
    if not isinstance(decoded, dict):
        return rec, False

    changed = False
    for key in ("topics", "keyPoints"):
        items = decoded.get(key)
        if not isinstance(items, list):
            continue
        new_items = []
        for it in items:
            flat = _flatten(it)
            if flat is not it:
                changed = True
            new_items.append(flat)
        decoded[key] = new_items

    if changed:
        rec["expectedResponse"] = ToonEncoder().encode(decoded)
        rec.setdefault("metadata", {})["summary_lists_flattened"] = True
    return rec, changed


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 2

    in_place = args.input.resolve() == args.output.resolve()
    tmp = args.output.with_suffix(args.output.suffix + ".tmp") if in_place else args.output

    n_total = n_flat = n_unchanged = n_dropped = 0
    with args.input.open("r", encoding="utf-8") as fin, \
         tmp.open("w", encoding="utf-8") as fout:
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
            rec, changed = fix_record(rec)
            if changed:
                n_flat += 1
            else:
                n_unchanged += 1
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")

    if in_place:
        os.replace(tmp, args.output)

    log.info(
        "in=%s out=%s total=%d flattened=%d unchanged=%d dropped=%d",
        args.input, args.output, n_total, n_flat, n_unchanged, n_dropped,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
