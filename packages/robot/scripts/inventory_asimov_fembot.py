#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import (  # noqa: E402
    collect_fembot_inventory,
    dump_fembot_inventory_json,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--require-production-ready",
        action="store_true",
        help="fail until all fembot body groups have complete proof evidence",
    )
    args = parser.parse_args()

    report = collect_fembot_inventory()
    print(dump_fembot_inventory_json(report), end="")
    if args.require_production_ready and not report["production_ready"]:
        return 2
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
