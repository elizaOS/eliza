#!/usr/bin/env python3
"""Final deslop pass for reply records with unquoted TOON `text:` values.

Earlier deslop transforms used a regex that only matched
    text: "quoted value"
This missed ~80,433 reply records where the text value is unquoted:
    text: And what did this ghost look like?

This pass walks all reply records, finds unquoted text values, and applies
the same casual + task deslop rules to them.

Operates in-place on data/final/train_final.jsonl.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"

sys.path.insert(0, str(ROOT / "scripts"))
from transform_casual_reply_shorten import (  # noqa: E402
    shorten_casual,
    is_casual,
)
from transform_task_reply_deslop import deslop_task_text  # noqa: E402

# Unquoted TOON text: value extends to end of line (or next \n).
UNQUOTED_TEXT_RE = re.compile(
    r'(^|\n)(text:\s*)([^"\n][^\n]*)(?=\n|$)',
)


def update_text_field(toon: str, *, idx: int, casual: bool, stats: dict) -> str:
    def _replace(match: re.Match) -> str:
        prefix, key, value = match.groups()
        original_value = value
        # apply casual or task deslop
        if casual:
            new_value = shorten_casual(value, idx=idx, stats=stats)
        else:
            new_value = deslop_task_text(value, stats=stats)
        if new_value == original_value:
            return match.group(0)
        # if new value contains characters that need quoting, quote it
        if any(c in new_value for c in '"\n\\'):
            return f'{prefix}{key}{json.dumps(new_value, ensure_ascii=False)}'
        return f"{prefix}{key}{new_value}"

    return UNQUOTED_TEXT_RE.sub(_replace, toon)


def transform_record(rec: dict, idx: int, stats: dict) -> dict:
    tt = rec.get("metadata", {}).get("task_type", "")
    if tt != "reply":
        return rec
    er = rec.get("expectedResponse")
    if not isinstance(er, str) or not er:
        return rec
    casual = is_casual(rec)
    new_er = update_text_field(er, idx=idx, casual=casual, stats=stats)
    if new_er != er:
        rec["expectedResponse"] = new_er
        stats["records_changed"] = stats.get("records_changed", 0) + 1
    return rec


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    tmp = SRC.with_suffix(".jsonl.tmp")
    stats: dict = {"total": 0, "decode_errors": 0, "records_changed": 0}
    with SRC.open() as fin, tmp.open("w") as fout:
        for idx, line in enumerate(fin):
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = transform_record(rec, idx, stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 200000 == 0:
                print(f"[{stats['total']}] changed={stats['records_changed']}", file=sys.stderr)
    os.replace(tmp, SRC)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
