#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_mesh_traceability import (  # noqa: E402
    build_fembot_mesh_parametric_traceability_proof,
    dump_fembot_mesh_parametric_traceability_proof_json,
    write_fembot_mesh_parametric_traceability_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Trace every ASIMOV visual mesh through source references, controlled "
            "loft proof, attachment interfaces, topology, surface distance, and MuJoCo mapping."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-mesh-parametric-traceability.json",
    )
    parser.add_argument(
        "--require-controlled-loft-ready",
        action="store_true",
        help="Exit nonzero until all 28 visual meshes have controlled-loft traceability.",
    )
    parser.add_argument(
        "--require-exact-step-ready",
        action="store_true",
        help="Exit nonzero until all 28 visual meshes are traced to exact STEP/B-rep sources.",
    )
    args = parser.parse_args()

    report = build_fembot_mesh_parametric_traceability_proof()
    write_fembot_mesh_parametric_traceability_proof(report, args.output)
    print(dump_fembot_mesh_parametric_traceability_proof_json(report), end="")
    if args.require_exact_step_ready:
        return 0 if report["accepted"] else 2
    if args.require_controlled_loft_ready:
        return 0 if report["ok"] else 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
