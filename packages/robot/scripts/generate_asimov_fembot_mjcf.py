#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_mjcf import (  # noqa: E402
    FEMBOT_MJCF_PATH,
    HIP_SPACING_SCALE,
    dump_fembot_mjcf_json,
    generate_fembot_mjcf,
    write_fembot_mjcf_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an ASIMOV fembot MJCF backed by parametric STL outputs."
    )
    parser.add_argument("--output-mjcf", type=Path, default=FEMBOT_MJCF_PATH)
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-mjcf.json",
    )
    parser.add_argument("--hip-spacing-scale", type=float, default=HIP_SPACING_SCALE)
    parser.add_argument("--require-ok", action="store_true")
    args = parser.parse_args()

    report = generate_fembot_mjcf(
        output_mjcf=args.output_mjcf,
        hip_spacing_scale=args.hip_spacing_scale,
    )
    write_fembot_mjcf_proof(report, args.output)
    print(dump_fembot_mjcf_json(report), end="")
    return 0 if report["ok"] or not args.require_ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
