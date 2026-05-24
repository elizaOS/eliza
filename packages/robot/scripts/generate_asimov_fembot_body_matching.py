#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_body_matching import (  # noqa: E402
    DEFAULT_ACCEPTANCE_SCORE,
    DEFAULT_TOP_MATCHES_PER_LINK,
    build_fembot_body_matching_proof,
    dump_fembot_body_matching_proof_json,
    write_fembot_body_matching_proof,
)
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.fembot_step_body_index import DEFAULT_MAX_FILES_PER_GROUP  # noqa: E402
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rank ASIMOV fembot candidate STEP bodies against source STL link envelopes."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-body-matching.json",
    )
    parser.add_argument(
        "--max-files-per-group",
        type=int,
        default=DEFAULT_MAX_FILES_PER_GROUP,
        help="bounded per-group STEP body index size; use 0 for all candidate fabrication STEP files",
    )
    parser.add_argument("--top-matches-per-link", type=int, default=DEFAULT_TOP_MATCHES_PER_LINK)
    parser.add_argument("--acceptance-score", type=float, default=DEFAULT_ACCEPTANCE_SCORE)
    parser.add_argument(
        "--include-main-assembly",
        action="store_true",
        help=(
            "include bodies from the top-level ASIMOV_V1.STEP assembly in the "
            "per-link ranking. Use --step-index-proof to reuse an existing deep index."
        ),
    )
    parser.add_argument(
        "--step-index-proof",
        type=Path,
        default=None,
        help=(
            "optional fembot-step-body-index.json to reuse, avoiding another load "
            "of the large main assembly STEP"
        ),
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until every link has accepted exact B-rep identity and fit/interface bounds",
    )
    args = parser.parse_args()

    max_files_per_group = None if args.max_files_per_group == 0 else args.max_files_per_group
    inventory = collect_fembot_inventory()
    step_index_report = (
        json.loads(args.step_index_proof.read_text(encoding="utf-8"))
        if args.step_index_proof
        else None
    )
    report = build_fembot_body_matching_proof(
        inventory["body_groups"],
        max_files_per_group=max_files_per_group,
        top_matches_per_link=args.top_matches_per_link,
        acceptance_score=args.acceptance_score,
        step_index_report=step_index_report,
        include_main_assembly_candidates=args.include_main_assembly,
    )
    write_fembot_body_matching_proof(report, args.output)
    print(dump_fembot_body_matching_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
