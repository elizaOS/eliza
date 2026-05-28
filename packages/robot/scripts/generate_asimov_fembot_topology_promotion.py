#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_topology import DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M  # noqa: E402
from eliza_robot.asimov_1.fembot_topology_promotion import (  # noqa: E402
    DEFAULT_TOPOLOGY_PROMOTION_ROOT,
    build_fembot_topology_promotion_proof,
    dump_fembot_topology_promotion_proof_json,
    write_fembot_topology_promotion_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def _load_json(path: Path) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Promote topology-clean ASIMOV fembot STEP references."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-topology-promotion.json",
    )
    parser.add_argument(
        "--generated-cad-proof",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json",
    )
    parser.add_argument(
        "--topology-proof",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-topology.json",
    )
    parser.add_argument("--promotion-root", type=Path, default=DEFAULT_TOPOLOGY_PROMOTION_ROOT)
    parser.add_argument("--merge-tolerance-m", type=float, default=DEFAULT_TOPOLOGY_MERGE_TOLERANCE_M)
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until all promoted STEP meshes validate with clean topology",
    )
    args = parser.parse_args()

    report = build_fembot_topology_promotion_proof(
        generated_cad_report=_load_json(args.generated_cad_proof),
        topology_report=_load_json(args.topology_proof),
        promotion_root=args.promotion_root,
        merge_tolerance_m=args.merge_tolerance_m,
    )
    write_fembot_topology_promotion_proof(report, args.output)
    print(dump_fembot_topology_promotion_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
