#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.source_inventory import collect_asimov1_source_inventory  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-parent-gitlink", action="store_true")
    args = parser.parse_args()
    report = collect_asimov1_source_inventory()
    if args.require_parent_gitlink:
        report["ok"] = report["ok"] and report["parent_gitlink_registered"]
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
