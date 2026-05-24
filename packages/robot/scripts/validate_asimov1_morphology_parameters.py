#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.morphology_readiness import (  # noqa: E402
    collect_morphology_parameter_proof_matrix,
    dump_morphology_parameter_proof_matrix_json,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate ASIMOV-1 morphology parameters against geometry, STEP, and MuJoCo proof evidence."
    )
    parser.add_argument(
        "--require-usable",
        action="store_true",
        help="Exit nonzero until every cataloged morphology parameter has all required proofs.",
    )
    args = parser.parse_args()

    report = collect_morphology_parameter_proof_matrix()
    print(dump_morphology_parameter_proof_matrix_json(report), end="")
    return 0 if report["ok"] or not args.require_usable else 2


if __name__ == "__main__":
    raise SystemExit(main())
