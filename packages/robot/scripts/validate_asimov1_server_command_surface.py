#!/usr/bin/env python3
"""Validate ASIMOV commands through the websocket bridge server."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.server_command_dry_run import (  # noqa: E402
    validate_asimov_server_command_surface,
)


def main() -> int:
    report = validate_asimov_server_command_surface()
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
