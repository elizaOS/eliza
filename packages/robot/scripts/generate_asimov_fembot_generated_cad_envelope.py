#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_generated_cad import (  # noqa: E402
    DEFAULT_BULGED_PREVIEW_OUTPUT_ROOT,
    DEFAULT_EXTENT_TOLERANCE_M,
    DEFAULT_LINK_POCKET_SET_OUTPUT_ROOT,
    DEFAULT_MANUFACTURING_ADJUSTED_PLATE_OUTPUT_ROOT,
    DEFAULT_POCKET_OUTPUT_ROOT,
    DEFAULT_POCKETED_PREVIEW_OUTPUT_ROOT,
    DEFAULT_RIBBED_BULGED_PREVIEW_OUTPUT_ROOT,
    DEFAULT_STEP_OUTPUT_ROOT,
    DEFAULT_SUPPLIER_VENDOR_ADJUSTED_OUTPUT_ROOT,
    build_fembot_generated_cad_envelope_proof,
    dump_fembot_generated_cad_envelope_proof_json,
    write_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS  # noqa: E402
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate clearance-adjusted ASIMOV fembot parametric STEP reference solids."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-generated-cad-envelope.json",
    )
    parser.add_argument("--step-root", type=Path, default=DEFAULT_STEP_OUTPUT_ROOT)
    parser.add_argument("--pocket-root", type=Path, default=DEFAULT_POCKET_OUTPUT_ROOT)
    parser.add_argument(
        "--link-pocket-root",
        type=Path,
        default=DEFAULT_LINK_POCKET_SET_OUTPUT_ROOT,
    )
    parser.add_argument(
        "--pocketed-preview-root",
        type=Path,
        default=DEFAULT_POCKETED_PREVIEW_OUTPUT_ROOT,
    )
    parser.add_argument(
        "--bulged-preview-root",
        type=Path,
        default=DEFAULT_BULGED_PREVIEW_OUTPUT_ROOT,
    )
    parser.add_argument(
        "--ribbed-bulged-preview-root",
        type=Path,
        default=DEFAULT_RIBBED_BULGED_PREVIEW_OUTPUT_ROOT,
    )
    parser.add_argument(
        "--supplier-vendor-adjusted-root",
        type=Path,
        default=DEFAULT_SUPPLIER_VENDOR_ADJUSTED_OUTPUT_ROOT,
    )
    parser.add_argument(
        "--manufacturing-adjusted-plate-root",
        type=Path,
        default=DEFAULT_MANUFACTURING_ADJUSTED_PLATE_OUTPUT_ROOT,
    )
    parser.add_argument("--extent-tolerance-m", type=float, default=DEFAULT_EXTENT_TOLERANCE_M)
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until generated CAD is final lofted, manufacturable, and fully verified",
    )
    args = parser.parse_args()

    body_groups = [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]
    report = build_fembot_generated_cad_envelope_proof(
        body_groups,
        step_root=args.step_root,
        pocket_root=args.pocket_root,
        link_pocket_root=args.link_pocket_root,
        pocketed_preview_root=args.pocketed_preview_root,
        bulged_preview_root=args.bulged_preview_root,
        ribbed_bulged_preview_root=args.ribbed_bulged_preview_root,
        supplier_vendor_adjusted_root=args.supplier_vendor_adjusted_root,
        manufacturing_adjusted_plate_root=args.manufacturing_adjusted_plate_root,
        extent_tolerance_m=args.extent_tolerance_m,
    )
    write_fembot_generated_cad_envelope_proof(report, args.output)
    print(dump_fembot_generated_cad_envelope_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
