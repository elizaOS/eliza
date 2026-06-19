#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.cad_edit import (  # noqa: E402
    promote_asimov1_workspace,
    regenerate_asimov1_workspace,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Promote generated ASIMOV-1 workspace outputs into profile assets."
    )
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--regenerate", action="store_true")
    parser.add_argument(
        "--apply", action="store_true", help="copy generated outputs into package assets"
    )
    args = parser.parse_args()
    report = {}
    if args.regenerate:
        report["regeneration"] = regenerate_asimov1_workspace(args.workspace)
    report["promotion"] = promote_asimov1_workspace(args.workspace, dry_run=not args.apply)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
