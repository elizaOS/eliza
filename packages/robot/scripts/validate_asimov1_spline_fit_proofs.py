#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.spline_fit_proof import collect_spline_fit_proof_matrix  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize ASIMOV-1 spline/interface/topology/surface proof coverage."
    )
    parser.add_argument(
        "--require-all",
        action="store_true",
        help="Exit non-zero unless every expected ASIMOV-1 link has a passing proof report.",
    )
    args = parser.parse_args()

    matrix = collect_spline_fit_proof_matrix()
    print(json.dumps(matrix, indent=2, sort_keys=True))
    if args.require_all and not matrix["ok"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
