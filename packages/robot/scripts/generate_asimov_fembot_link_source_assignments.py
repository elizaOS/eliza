#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.fembot_link_sources import (  # noqa: E402
    build_fembot_link_source_assignment_proof,
    dump_fembot_link_source_assignment_proof_json,
    write_fembot_link_source_assignment_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build candidate per-link ASIMOV fembot STEP/control-loft source assignments."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-link-source-assignments.json",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until every link has accepted STEP/B-rep or controlled-loft source assignment",
    )
    parser.add_argument(
        "--body-matching-proof",
        type=Path,
        default=None,
        help="optional fembot-body-matching.json to reuse for per-link best STEP body candidates",
    )
    args = parser.parse_args()

    inventory = collect_fembot_inventory()
    body_matching_report = (
        json.loads(args.body_matching_proof.read_text(encoding="utf-8"))
        if args.body_matching_proof
        else None
    )
    report = build_fembot_link_source_assignment_proof(
        inventory["body_groups"],
        body_matching_report=body_matching_report,
    )
    write_fembot_link_source_assignment_proof(report, args.output)
    print(dump_fembot_link_source_assignment_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
