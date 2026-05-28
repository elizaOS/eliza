#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_topology import (  # noqa: E402
    DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M,
    build_fembot_topology_proof,
    dump_fembot_topology_proof_json,
    write_fembot_topology_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate ASIMOV fembot generated STEP mesh topology proof."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-topology.json",
    )
    parser.add_argument(
        "--generated-cad-proof",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json",
    )
    parser.add_argument(
        "--merge-tolerance-m",
        type=float,
        default=DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M,
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until every generated STEP mesh export is closed and single-component",
    )
    args = parser.parse_args()

    generated_cad_report = (
        json.loads(args.generated_cad_proof.read_text(encoding="utf-8"))
        if args.generated_cad_proof.is_file()
        else None
    )
    report = build_fembot_topology_proof(
        generated_cad_report=generated_cad_report,
        merge_tolerance_m=args.merge_tolerance_m,
    )
    write_fembot_topology_proof(report, args.output)
    print(dump_fembot_topology_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
