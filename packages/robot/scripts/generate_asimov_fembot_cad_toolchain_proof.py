#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_cad_toolchain import (  # noqa: E402
    build_fembot_cad_toolchain_readiness_proof,
    dump_fembot_cad_toolchain_readiness_proof_json,
    write_fembot_cad_toolchain_readiness_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check command-line Python/OCC CAD readiness for ASIMOV fembot."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-cad-toolchain.json",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until a preferred command-line Python/OCC CAD backend is available",
    )
    args = parser.parse_args()

    report = build_fembot_cad_toolchain_readiness_proof()
    write_fembot_cad_toolchain_readiness_proof(report, args.output)
    print(dump_fembot_cad_toolchain_readiness_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
