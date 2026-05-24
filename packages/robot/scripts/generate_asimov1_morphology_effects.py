#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.morphology_effects import (  # noqa: E402
    build_morphology_effect_proof,
    dump_morphology_effect_proof_json,
    write_morphology_effect_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure whether generated ASIMOV-1 fembot meshes express cataloged morphology parameters."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "morphology-effects.json",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until every cataloged morphology parameter has a measured generated-mesh effect",
    )
    args = parser.parse_args()

    report = build_morphology_effect_proof()
    write_morphology_effect_proof(report, args.output)
    print(dump_morphology_effect_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
