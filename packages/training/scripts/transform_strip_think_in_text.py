#!/usr/bin/env python3
"""Strip `<think>` and `</think>` tokens from inside `text:` and content
fields. Mostly affects agent-trove records where the source model emitted
think-wrapper slop inside native JSON text fields.

Reads/writes data/final/train_final.jsonl in place via temp swap.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"

THINK_TAG = re.compile(r"</?think>")


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    tmp = SRC.with_suffix(".jsonl.tmp")
    stats = {"total": 0, "stripped_er": 0, "stripped_mem": 0}
    with SRC.open() as fin, tmp.open("w") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                fout.write(line)
                continue
            er = rec.get("expectedResponse")
            if isinstance(er, str) and THINK_TAG.search(er):
                rec["expectedResponse"] = THINK_TAG.sub("", er)
                stats["stripped_er"] += 1
            mems = rec.get("memoryEntries")
            if isinstance(mems, list):
                changed = False
                for m in mems:
                    if isinstance(m, dict):
                        c = m.get("content")
                        if isinstance(c, str) and THINK_TAG.search(c):
                            m["content"] = THINK_TAG.sub("", c)
                            changed = True
                if changed:
                    stats["stripped_mem"] += 1
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if stats["total"] % 200000 == 0:
                print(stats, file=sys.stderr)
    os.replace(tmp, SRC)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
