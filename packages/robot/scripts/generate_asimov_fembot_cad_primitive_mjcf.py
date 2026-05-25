#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_cad_primitive_mjcf import (  # noqa: E402
    FEMBOT_CAD_PRIMITIVE_MJCF_PATH,
    build_fembot_cad_primitive_mjcf_proof,
    dump_fembot_cad_primitive_mjcf_proof_json,
    write_fembot_cad_primitive_mjcf_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS  # noqa: E402
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an ASIMOV fembot no-STL CAD-primitive MJCF proof."
    )
    parser.add_argument("--mjcf-output", type=Path, default=FEMBOT_CAD_PRIMITIVE_MJCF_PATH)
    parser.add_argument(
        "--proof-output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-cad-primitive-mjcf.json",
    )
    parser.add_argument("--require-accepted", action="store_true")
    args = parser.parse_args()

    body_groups = [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]
    report = build_fembot_cad_primitive_mjcf_proof(
        body_groups,
        output_mjcf=args.mjcf_output,
    )
    write_fembot_cad_primitive_mjcf_proof(report, args.proof_output)
    print(dump_fembot_cad_primitive_mjcf_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
