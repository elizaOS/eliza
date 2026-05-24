#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.fembot_visual_review import (  # noqa: E402
    DEFAULT_VISUAL_REVIEW_ROOT,
    build_fembot_visual_review_proof,
    dump_fembot_visual_review_proof_json,
    write_fembot_visual_review_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate fembot visual and mathematical review proof."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-visual-review.json",
    )
    parser.add_argument("--render-root", type=Path, default=DEFAULT_VISUAL_REVIEW_ROOT)
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until fembot visual review is manually accepted",
    )
    args = parser.parse_args()

    inventory = collect_fembot_inventory()
    report = build_fembot_visual_review_proof(
        inventory["body_groups"],
        output_root=args.render_root,
    )
    write_fembot_visual_review_proof(report, args.output)
    print(dump_fembot_visual_review_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
