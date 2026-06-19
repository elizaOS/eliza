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
    apply_asimov1_mjcf_patch,
    regenerate_asimov1_workspace,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply a structured patch to an ASIMOV-1 edit workspace MJCF."
    )
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--regenerate", action="store_true")
    args = parser.parse_args()
    patch = json.loads(args.patch.read_text(encoding="utf-8"))
    report = {"patch": apply_asimov1_mjcf_patch(args.workspace, patch)}
    if args.regenerate:
        report["regeneration"] = regenerate_asimov1_workspace(args.workspace)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
