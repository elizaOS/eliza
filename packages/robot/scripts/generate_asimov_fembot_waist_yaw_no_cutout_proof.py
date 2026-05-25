#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_waist_yaw_no_cutout import (  # noqa: E402
    build_waist_yaw_no_cutout_proof,
    dump_waist_yaw_no_cutout_proof_json,
    write_waist_yaw_no_cutout_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate proof that WAIST_YAW has a smooth lofted chest with no front M cutout."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "waist-yaw-no-cutout.json",
    )
    parser.add_argument("--require-accepted", action="store_true")
    args = parser.parse_args()

    report = build_waist_yaw_no_cutout_proof()
    write_waist_yaw_no_cutout_proof(report, args.output)
    print(dump_waist_yaw_no_cutout_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
