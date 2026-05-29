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
        description="Validate ASIMOV-1 morphology parameters against geometry, source, and MuJoCo proof evidence."
    )
    parser.add_argument(
        "--require-usable",
        action="store_true",
        help="Exit nonzero until every cataloged morphology parameter has geometry, source, and MuJoCo proofs.",
    )
    parser.add_argument(
        "--require-supplier-vendor-ready",
        action="store_true",
        help="Exit nonzero until every cataloged morphology parameter is clear of measured supplier-vendor bbox growth blockers.",
    )
    parser.add_argument(
        "--require-supplier-vendor-exact-pocket-ready",
        action="store_true",
        help="Exit nonzero until every cataloged morphology parameter has exact placed supplier-vendor pockets and mate features accepted.",
    )
    args = parser.parse_args()

    report = collect_morphology_parameter_proof_matrix()
    print(dump_morphology_parameter_proof_matrix_json(report), end="")
    if args.require_usable and not report["ok"]:
        return 2
    if (
        args.require_supplier_vendor_ready
        and report["counts"].get("supplier_vendor_blocked", 0) != 0
    ):
        return 2
    if (
        args.require_supplier_vendor_exact_pocket_ready
        and report["counts"].get("supplier_vendor_exact_pocket_blocked", 0) != 0
    ):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
