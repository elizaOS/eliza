#!/usr/bin/env python3
"""Create a dry-run report for coverage-directed cocotb stimulus search."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COVERAGE_BINS = ROOT / "verify/ai_eda/coverage_bins/e1_npu_descriptor_queue.yaml"
DEFAULT_SEED_MANIFEST = ROOT / "verify/regression_seeds/ai_eda_npu_descriptor_queue.yaml"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cocotb_stimulus"
CLAIM_BOUNDARY = "no_ai_generated_stimulus_as_evidence_until_cocotb_regression_passes"


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--coverage-bins", type=Path, default=DEFAULT_COVERAGE_BINS)
    parser.add_argument("--seed-manifest", type=Path, default=DEFAULT_SEED_MANIFEST)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    args = parser.parse_args()
    if not args.dry_run:
        raise ValueError("only --dry-run mode is implemented for cocotb stimulus search")
    coverage = yaml.safe_load(args.coverage_bins.read_text())
    seeds = yaml.safe_load(args.seed_manifest.read_text())
    bins = coverage.get("bins", [])
    report = {
        "schema": "eliza.ai_eda.cocotb_stimulus.coverage_report.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "DRY_RUN",
        "claim_boundary": CLAIM_BOUNDARY,
        "backlog_item": "p0-llm4dv-cocotb-stimulus-loop",
        "source_ids": coverage.get("source_ids", []),
        "dut": coverage.get("dut"),
        "generated_candidate_count": 0,
        "invalid_candidate_count": 0,
        "coverage_delta_available": False,
        "coverage_bin_count": len(bins),
        "model_invocation": {"enabled": False},
        "required_followup_gates": ["make cocotb-npu", "make cocotb-contract"],
        "coverage_bins": [
            {"id": item.get("id"), "status": "UNMEASURED_DRY_RUN", "accepted_seed_ids": []}
            for item in bins
        ],
        "accepted_seeds": seeds.get("seeds", []),
    }
    out_dir = args.out_root.resolve() / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "coverage_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.cocotb_stimulus.dry_run {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
