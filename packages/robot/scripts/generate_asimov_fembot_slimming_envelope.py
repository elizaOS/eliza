#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.fembot_slimming_envelope import (  # noqa: E402
    DEFAULT_ANCHOR_CLEARANCE_M,
    DEFAULT_ENVELOPE_MIN_EXTENT_M,
    build_fembot_slimming_envelope_proof,
    dump_fembot_slimming_envelope_proof_json,
    write_fembot_slimming_envelope_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Estimate initial ASIMOV fembot per-link slimming envelopes from source geometry and MJCF anchors."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-slimming-envelope.json",
    )
    parser.add_argument("--anchor-clearance-m", type=float, default=DEFAULT_ANCHOR_CLEARANCE_M)
    parser.add_argument(
        "--minimum-manufacturable-extent-m",
        type=float,
        default=DEFAULT_ENVELOPE_MIN_EXTENT_M,
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until generated fembot CAD passes clearance, structural, collision, and MuJoCo gates",
    )
    args = parser.parse_args()

    inventory = collect_fembot_inventory()
    report = build_fembot_slimming_envelope_proof(
        inventory["body_groups"],
        anchor_clearance_m=args.anchor_clearance_m,
        min_manufacturable_extent_m=args.minimum_manufacturable_extent_m,
    )
    write_fembot_slimming_envelope_proof(report, args.output)
    print(dump_fembot_slimming_envelope_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
