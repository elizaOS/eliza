#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.cad_edit import create_asimov1_edit_workspace  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create an editable ASIMOV-1 CAD/MuJoCo workspace."
    )
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    report = create_asimov1_edit_workspace(args.workspace, force=args.force)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
