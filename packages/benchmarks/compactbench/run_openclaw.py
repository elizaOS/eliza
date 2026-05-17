#!/usr/bin/env python3
"""OpenClaw CompactBench runner entry.

This runner exists to prevent misleading cross-agent rows. It reports that
OpenClaw's currently exposed benchmark path has no native CompactBench
compactor API, writes an auditable JSONL status event, and exits non-zero.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from eliza_compactbench.openclaw_compactor import openclaw_compaction_status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("openclaw-compactbench.jsonl"))
    parser.add_argument("--model", default="gpt-oss-120b")
    parser.add_argument(
        "--expect-unsupported",
        action="store_true",
        help="Exit 0 after writing the unsupported status; intended for tests.",
    )
    args = parser.parse_args()

    status = openclaw_compaction_status()
    status["model"] = args.model
    event = {"event": "adapter_unsupported", **status}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(event, ensure_ascii=True, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(event, indent=2, sort_keys=True))
    return 0 if args.expect_unsupported else 2


if __name__ == "__main__":
    sys.exit(main())
