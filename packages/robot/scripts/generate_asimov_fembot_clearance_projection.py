#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_clearance_projection import (  # noqa: E402
    DEFAULT_KEEPOUT_MARGIN_M,
    build_fembot_clearance_projection_proof,
    dump_fembot_clearance_projection_proof_json,
    write_fembot_clearance_projection_proof,
)
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Project ASIMOV fembot slimming envelopes against inventoried keepout points."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-clearance-projection.json",
    )
    parser.add_argument("--keepout-margin-m", type=float, default=DEFAULT_KEEPOUT_MARGIN_M)
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until generated fembot CAD passes full volume clearance gates",
    )
    args = parser.parse_args()

    inventory = collect_fembot_inventory()
    report = build_fembot_clearance_projection_proof(
        inventory["body_groups"],
        keepout_margin_m=args.keepout_margin_m,
    )
    write_fembot_clearance_projection_proof(report, args.output)
    print(dump_fembot_clearance_projection_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
