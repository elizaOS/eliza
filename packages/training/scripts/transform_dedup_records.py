#!/usr/bin/env python3
"""Drop exact-duplicate (currentMessage, expectedResponse) records.

Dedup analysis on the post-pipeline corpus shows:
  - 1,073,838 records total
  - 1,036,618 unique (cm,er) tuples
  - 37,220 excess copies (3.46%)
  - largest dup group: 988 copies of empty/null records

Strategy: keep the first occurrence of each tuple. Empty/null records
(no task_type AND empty cm AND empty er) are dropped entirely.

Operates in-place on data/final/train_final.jsonl.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"


def is_empty(rec: dict) -> bool:
    cm = rec.get("currentMessage", {})
    er = rec.get("expectedResponse", "")
    md = rec.get("metadata", {})
    if not md.get("task_type") and not (cm and (cm.get("content") if isinstance(cm, dict) else cm)) and not er:
        return True
    return False


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    tmp = SRC.with_suffix(".jsonl.tmp")
    seen: set[str] = set()
    stats = {"total": 0, "kept": 0, "dropped_empty": 0, "dropped_dup": 0}
    with SRC.open() as fin, tmp.open("w") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                fout.write(line)
                stats["kept"] += 1
                continue
            if is_empty(rec):
                stats["dropped_empty"] += 1
                continue
            cm = json.dumps(rec.get("currentMessage", {}), sort_keys=True, ensure_ascii=False)
            er = rec.get("expectedResponse", "") or ""
            h = hashlib.md5((cm + "|" + er).encode("utf-8")).hexdigest()
            if h in seen:
                stats["dropped_dup"] += 1
                continue
            seen.add(h)
            fout.write(line)
            stats["kept"] += 1
    os.replace(tmp, SRC)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
