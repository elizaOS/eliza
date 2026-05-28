#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_source_decision import (  # noqa: E402
    build_fembot_source_decision_proof,
    dump_fembot_source_decision_proof_json,
    write_fembot_source_decision_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Record the per-link source decision between accepted controlled lofts "
            "and rejected ranked STEP/B-rep candidates."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-source-decision.json",
    )
    parser.add_argument(
        "--require-decision-ready",
        action="store_true",
        help="fail until every link has a defensible controlled-loft-vs-STEP source decision",
    )
    parser.add_argument(
        "--require-exact-brep-ready",
        action="store_true",
        help="fail until every link has exact STEP/B-rep source identity",
    )
    args = parser.parse_args()

    report = build_fembot_source_decision_proof()
    write_fembot_source_decision_proof(report, args.output)
    print(dump_fembot_source_decision_proof_json(report), end="")
    if args.require_exact_brep_ready:
        return 0 if report["accepted"] else 2
    if args.require_decision_ready:
        return 0 if report["ok"] else 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
