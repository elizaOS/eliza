#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.parametric_inventory import (  # noqa: E402
    collect_asimov1_parametric_inventory,
    dump_parametric_inventory_json,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inventory ASIMOV-1 STL links against the parametric CAD conversion target."
    )
    parser.add_argument(
        "--require-fully-parametric",
        action="store_true",
        help="Exit non-zero unless every ASIMOV-1 visual mesh has proven STEP/loft coverage.",
    )
    args = parser.parse_args()

    report = collect_asimov1_parametric_inventory()
    print(dump_parametric_inventory_json(report), end="")
    if args.require_fully_parametric and not report["fully_parametric"]:
        return 2
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
