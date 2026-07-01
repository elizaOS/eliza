#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x3d_placement_model import build_placement_report  # noqa: E402
from compiler.runtime.e1x3d_wafer_model import E1X3DConfig  # noqa: E402

DEFAULT_OUT = ROOT / "benchmarks/results/e1x3d-placement-feasibility.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--memory-tiers-per-core", type=int, default=1)
    parser.add_argument("--bonding-pitch-um", type=float, default=6.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_placement_report(
        E1X3DConfig(
            memory_tiers_per_core=args.memory_tiers_per_core,
            inter_tier_via_pitch_um=args.bonding_pitch_um,
        )
    )
    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
