#!/usr/bin/env python3
"""Dry-run the ASIMOV-1 real LiveKit/protobuf bridge path locally."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.livekit_dry_run import validate_asimov_livekit_dry_run  # noqa: E402


def main() -> int:
    report = validate_asimov_livekit_dry_run()
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
