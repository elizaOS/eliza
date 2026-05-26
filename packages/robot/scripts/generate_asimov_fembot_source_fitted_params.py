#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS  # noqa: E402
from eliza_robot.asimov_1.fembot_source_fitted_params import (  # noqa: E402
    DEFAULT_SOURCE_FITTED_PARAM_ROOT,
    build_fembot_source_fitted_params_proof,
    dump_fembot_source_fitted_params_proof_json,
    write_fembot_source_fitted_params_manifests,
    write_fembot_source_fitted_params_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export ASIMOV fembot source-fitted loft parameter manifests."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-source-fitted-params.json",
    )
    parser.add_argument(
        "--manifest-root",
        type=Path,
        default=DEFAULT_SOURCE_FITTED_PARAM_ROOT,
    )
    parser.add_argument("--require-accepted", action="store_true")
    args = parser.parse_args()

    body_groups = [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]
    report = build_fembot_source_fitted_params_proof(
        body_groups,
        output_root=args.manifest_root,
    )
    write_fembot_source_fitted_params_manifests(
        report,
        output_root=args.manifest_root,
    )
    write_fembot_source_fitted_params_proof(report, args.output)
    print(dump_fembot_source_fitted_params_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
