#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.fembot_source_manifest import (  # noqa: E402
    build_fembot_source_manifest_proof,
    dump_fembot_source_manifest_proof_json,
    write_fembot_source_manifest_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the ASIMOV fembot body-group STEP source split manifest."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-source-manifest.json",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until every fembot link has exact STEP/B-rep or controlled-loft source proof",
    )
    args = parser.parse_args()

    inventory = collect_fembot_inventory()
    report = build_fembot_source_manifest_proof(inventory["body_groups"])
    write_fembot_source_manifest_proof(report, args.output)
    print(dump_fembot_source_manifest_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
