#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.fembot_step_body_index import (  # noqa: E402
    DEFAULT_MAX_FILES_PER_GROUP,
    build_fembot_step_body_index_proof,
    dump_fembot_step_body_index_proof_json,
    write_fembot_step_body_index_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Index ASIMOV fembot candidate fabrication STEP bodies with the isolated CAD kernel."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-step-body-index.json",
    )
    parser.add_argument(
        "--max-files-per-group",
        type=int,
        default=DEFAULT_MAX_FILES_PER_GROUP,
        help="bounded per-group sample size; use 0 for the full fabrication STEP index",
    )
    parser.add_argument(
        "--include-main-assembly",
        action="store_true",
        help=(
            "also load the large mechanical/ASV1/ASIMOV_V1.STEP assembly through "
            "the CAD kernel and record its body index"
        ),
    )
    parser.add_argument(
        "--main-assembly-timeout-s",
        type=int,
        default=300,
        help="timeout for the optional main assembly CAD-kernel load",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until exact link-to-body matching and bounded fit/interface errors are accepted",
    )
    args = parser.parse_args()

    max_files_per_group = None if args.max_files_per_group == 0 else args.max_files_per_group
    inventory = collect_fembot_inventory()
    report = build_fembot_step_body_index_proof(
        inventory["body_groups"],
        max_files_per_group=max_files_per_group,
        include_main_assembly=args.include_main_assembly,
        main_assembly_timeout_s=args.main_assembly_timeout_s,
    )
    write_fembot_step_body_index_proof(report, args.output)
    print(dump_fembot_step_body_index_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
