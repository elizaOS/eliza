#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.collision_sweep import (  # noqa: E402
    build_asimov1_collision_sweep_proof,
    dump_collision_sweep_proof_json,
    write_collision_sweep_proof,
)
from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF  # noqa: E402
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a deterministic ASIMOV-1 MuJoCo joint-range collision sweep."
    )
    parser.add_argument("--mjcf", type=Path, default=ASIMOV1_GENERATED_MJCF)
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "collision-sweep.json",
    )
    parser.add_argument(
        "--endpoints-only",
        action="store_true",
        help="sample only lower/upper joint limits; by default midpoint poses are also checked",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="exit nonzero if any unapproved contacts are found",
    )
    args = parser.parse_args()

    report = build_asimov1_collision_sweep_proof(
        mjcf_path=args.mjcf,
        include_midpoints=not args.endpoints_only,
    )
    write_collision_sweep_proof(report, args.output)
    print(dump_collision_sweep_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
