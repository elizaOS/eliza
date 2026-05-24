#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.fembot_materials import (  # noqa: E402
    build_fembot_material_manufacturing_proof,
    dump_fembot_material_manufacturing_proof_json,
    write_fembot_material_manufacturing_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Classify ASIMOV fembot candidate STEP parts by material and manufacturing process."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-material-manufacturing.json",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until generated fembot parts have accepted material/manufacturing evidence",
    )
    args = parser.parse_args()

    inventory = collect_fembot_inventory()
    report = build_fembot_material_manufacturing_proof(inventory["body_groups"])
    write_fembot_material_manufacturing_proof(report, args.output)
    print(dump_fembot_material_manufacturing_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
