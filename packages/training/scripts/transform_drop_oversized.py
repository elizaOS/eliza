#!/usr/bin/env python3
"""Drop records whose expectedResponse exceeds a sane training context.

Survey shows 113 records over 200k chars (largest is 1.8MB — a malformed
n8n workflow dump). These exceed any model context window we ship and
will OOM the trainer when packed.

Default cap: 200,000 chars (~50k tokens at 4 chars/token). Override via
ELIZA_MAX_RESPONSE_CHARS env var.

Operates in-place on data/final/train_final.jsonl.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "final" / "train_final.jsonl"

MAX_CHARS = int(os.environ.get("ELIZA_MAX_RESPONSE_CHARS", "200000"))


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} missing", file=sys.stderr)
        return 2
    tmp = SRC.with_suffix(".jsonl.tmp")
    stats = {"total": 0, "kept": 0, "dropped": 0, "by_task_type": {}}
    with SRC.open() as fin, tmp.open("w") as fout:
        for line in fin:
            stats["total"] += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                fout.write(line)
                stats["kept"] += 1
                continue
            er = rec.get("expectedResponse", "") or ""
            if isinstance(er, str) and len(er) > MAX_CHARS:
                tt = rec.get("metadata", {}).get("task_type", "unknown")
                stats["by_task_type"][tt] = stats["by_task_type"].get(tt, 0) + 1
                stats["dropped"] += 1
                continue
            fout.write(line)
            stats["kept"] += 1
    os.replace(tmp, SRC)
    print(json.dumps(stats, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
