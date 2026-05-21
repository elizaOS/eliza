#!/usr/bin/env python3
"""Create a dry-run report for the E1 ZigZag NPU DSE lane."""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CURRENT = ROOT / "compiler/runtime/ai_eda/zigzag/e1_npu_current.yaml"
DEFAULT_TARGET = ROOT / "compiler/runtime/ai_eda/zigzag/e1_npu_target.yaml"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/zigzag"
CLAIM_BOUNDARY = "architecture_estimate_only_no_tops_android_or_tapeout_claim"


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summary(data: dict) -> dict:
    arch = data["architecture"]
    return {
        "name": arch.get("name"),
        "phase": arch.get("phase"),
        "operator_ids": [item.get("id") for item in arch.get("operators", [])],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--current", type=Path, default=DEFAULT_CURRENT)
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    args = parser.parse_args()
    if not args.dry_run:
        raise ValueError("only --dry-run mode is implemented for ZigZag NPU DSE")
    current = yaml.safe_load(args.current.read_text())
    target = yaml.safe_load(args.target.read_text())
    report = {
        "schema": "eliza.ai_eda.zigzag_dse_report.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "DRY_RUN",
        "claim_boundary": CLAIM_BOUNDARY,
        "backlog_item": "p0-zigzag-npu-dse",
        "zigzag_invocation": {"enabled": False},
        "estimates_available": False,
        "latency_energy_available": False,
        "input_artifacts": [
            {
                "path": rel(args.current),
                "sha256": sha256_file(args.current),
                "summary": summary(current),
            },
            {
                "path": rel(args.target),
                "sha256": sha256_file(args.target),
                "summary": summary(target),
            },
        ],
        "required_followup_gates": [
            "python3 scripts/check_ai_eda_source_inventory.py",
            "make npu-runtime-contract-check",
            "make npu-roadmap-check",
        ],
    }
    out_dir = args.out_root.resolve() / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "dse_report.yaml"
    path.write_text(yaml.safe_dump(report, sort_keys=False))
    print(f"STATUS: PASS ai_eda.zigzag.dry_run {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
