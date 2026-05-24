#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS  # noqa: E402
from eliza_robot.asimov_1.fembot_thinness_frontier import (  # noqa: E402
    build_fembot_thinness_frontier_proof,
    dump_fembot_thinness_frontier_proof_json,
    write_fembot_thinness_frontier_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate the ASIMOV fembot per-link thinness frontier proof."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-thinness-frontier.json",
    )
    parser.add_argument("--require-accepted", action="store_true")
    args = parser.parse_args()

    body_groups = [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]
    report = build_fembot_thinness_frontier_proof(body_groups)
    write_fembot_thinness_frontier_proof(report, args.output)
    print(dump_fembot_thinness_frontier_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
