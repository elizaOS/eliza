#!/usr/bin/env python3
"""Drop memoryEntries with empty content.

Audit shows 588,952 entries (11.83%) have empty content — mostly placeholder
assistant turns where the assistant took an action with no text reply.
These entries serialize as ~50 tokens of metadata each (role, speaker,
channel, empty content) but add zero signal.

Drop them entirely. Keeps the rest of the entry list intact.

Operates in-place on data/final/train_final.jsonl.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"


def transform_record(rec: dict, stats: dict) -> dict:
    me = rec.get("memoryEntries")
    if not isinstance(me, list):
        return rec
    new_me = []
    dropped_here = 0
    for entry in me:
        if not isinstance(entry, dict):
            new_me.append(entry)
            continue
        content = entry.get("content", "")
        if isinstance(content, str) and not content.strip():
            dropped_here += 1
            continue
        new_me.append(entry)
    if dropped_here:
        rec["memoryEntries"] = new_me
        stats["entries_dropped"] = stats.get("entries_dropped", 0) + dropped_here
        stats["records_changed"] = stats.get("records_changed", 0) + 1
    return rec


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    tmp = SRC.with_suffix(".jsonl.tmp")
    stats: dict = {"total": 0, "decode_errors": 0, "records_changed": 0, "entries_dropped": 0}
    with SRC.open() as fin, tmp.open("w") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                stats["decode_errors"] += 1
                fout.write(line)
                continue
            rec = transform_record(rec, stats)
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 200000 == 0:
                print(f"[{stats['total']}] dropped={stats['entries_dropped']}", file=sys.stderr)
    os.replace(tmp, SRC)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
