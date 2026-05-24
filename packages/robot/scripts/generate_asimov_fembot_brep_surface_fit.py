#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_brep_surface_fit import (  # noqa: E402
    DEFAULT_MAX_SAMPLE_COUNT,
    DEFAULT_SURFACE_CANDIDATES_PER_LINK,
    DEFAULT_SURFACE_TOLERANCE_M,
    build_fembot_brep_surface_fit_proof,
    dump_fembot_brep_surface_fit_proof_json,
    write_fembot_brep_surface_fit_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure ranked ASIMOV fembot STEP/B-rep body candidates against source STL surfaces."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-brep-surface-fit.json",
    )
    parser.add_argument(
        "--body-matching-proof",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-body-matching.json",
    )
    parser.add_argument("--surface-tolerance-m", type=float, default=DEFAULT_SURFACE_TOLERANCE_M)
    parser.add_argument("--max-sample-count", type=int, default=DEFAULT_MAX_SAMPLE_COUNT)
    parser.add_argument(
        "--surface-candidates-per-link",
        type=int,
        default=DEFAULT_SURFACE_CANDIDATES_PER_LINK,
        help="ranked STEP/B-rep candidates per link to export and measure",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until every best STEP/B-rep candidate is within surface-fit tolerance",
    )
    args = parser.parse_args()

    body_matching_report = (
        json.loads(args.body_matching_proof.read_text(encoding="utf-8"))
        if args.body_matching_proof.is_file()
        else None
    )
    report = build_fembot_brep_surface_fit_proof(
        body_matching_report=body_matching_report,
        surface_tolerance_m=args.surface_tolerance_m,
        max_sample_count=args.max_sample_count,
        surface_candidates_per_link=args.surface_candidates_per_link,
    )
    write_fembot_brep_surface_fit_proof(report, args.output)
    print(dump_fembot_brep_surface_fit_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
