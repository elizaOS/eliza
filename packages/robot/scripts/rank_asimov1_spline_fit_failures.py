#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.spline_fit_proof import rank_spline_fit_repair_targets  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rank failed ASIMOV-1 spline fit proofs by likely repair difficulty."
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only print the top N repair targets.",
    )
    args = parser.parse_args()

    ranking = rank_spline_fit_repair_targets(limit=args.limit)
    print(json.dumps(ranking, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
