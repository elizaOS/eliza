#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.lean_experiment import (  # noqa: E402
    HIP_SPACING_EXPERIMENT_SCALE,
    LEAN_EXPERIMENT_MJCF_PATH,
    build_asimov1_lean_experiment_proof,
    dump_asimov1_lean_experiment_json,
    write_asimov1_lean_experiment_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate the ASIMOV-1 lean parametric experiment proof."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "asimov-lean-experiment.json",
    )
    parser.add_argument("--output-mjcf", type=Path, default=LEAN_EXPERIMENT_MJCF_PATH)
    parser.add_argument("--hip-spacing-scale", type=float, default=HIP_SPACING_EXPERIMENT_SCALE)
    parser.add_argument("--skip-stl", action="store_true")
    parser.add_argument("--skip-repaired", action="store_true")
    parser.add_argument("--skip-mujoco", action="store_true")
    parser.add_argument("--require-ok", action="store_true")
    args = parser.parse_args()

    report = build_asimov1_lean_experiment_proof(
        output_mjcf=args.output_mjcf,
        hip_spacing_scale=args.hip_spacing_scale,
        generate_stl_fork=not args.skip_stl,
        generate_repaired_fork=not args.skip_repaired,
        generate_mjcf_variant=not args.skip_mujoco,
    )
    write_asimov1_lean_experiment_proof(report, args.output)
    print(dump_asimov1_lean_experiment_json(report), end="")
    return 0 if report["ok"] or not args.require_ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
