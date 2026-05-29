#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import ASIMOV1_GENERATED_MJCF  # noqa: E402
from eliza_robot.asimov_1.mujoco_load_proof import (  # noqa: E402
    dump_mujoco_load_proof_json,
    write_mujoco_load_proof,
    build_mujoco_load_proof,
)
from eliza_robot.asimov_1.parametric_inventory import (  # noqa: E402
    ASIMOV_PARAM_PROOFS,
    collect_asimov1_parametric_inventory,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compile and step the ASIMOV-1 MJCF, recording a MuJoCo load proof."
    )
    parser.add_argument("--mjcf", type=Path, default=ASIMOV1_GENERATED_MJCF)
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "mujoco-load.json",
        help="Proof JSON path.",
    )
    parser.add_argument(
        "--require-ok",
        action="store_true",
        help="Exit nonzero unless the MJCF loads, forwards, steps, and has the expected actuator surface.",
    )
    args = parser.parse_args()

    inventory = collect_asimov1_parametric_inventory(mjcf=args.mjcf)
    proof_links = [record["link"] for record in inventory["records"]]
    report = build_mujoco_load_proof(mjcf_path=args.mjcf, proof_links=proof_links)
    write_mujoco_load_proof(report, args.output)
    print(dump_mujoco_load_proof_json(report), end="")
    return 0 if report["ok"] or not args.require_ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
