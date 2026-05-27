#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_wafer_model import E1XConfig, build_e1x_report  # noqa: E402

DEFAULT_OUT = ROOT / "benchmarks/results/e1x-wafer-mesh-model.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--logical-rows", type=int, default=32)
    parser.add_argument("--logical-cols", type=int, default=32)
    parser.add_argument("--spare-rows", type=int, default=2)
    parser.add_argument("--spare-cols", type=int, default=2)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = E1XConfig(
        logical_rows=args.logical_rows,
        logical_cols=args.logical_cols,
        spare_rows=args.spare_rows,
        spare_cols=args.spare_cols,
    )
    report = build_e1x_report(config)
    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
