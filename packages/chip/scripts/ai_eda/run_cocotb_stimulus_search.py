#!/usr/bin/env python3
"""Create a dry-run report for coverage-directed cocotb stimulus search."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COVERAGE_BINS = (
    ROOT / "verify/ai_eda/coverage_bins/e1_npu_descriptor_queue.yaml",
    ROOT / "verify/ai_eda/coverage_bins/e1_dma_backpressure_error.yaml",
    ROOT / "verify/ai_eda/coverage_bins/e1_iommu_translation_fault.yaml",
    ROOT / "verify/ai_eda/coverage_bins/e1_interrupt_reset_edges.yaml",
    ROOT / "verify/ai_eda/coverage_bins/e1_npu_command_buffer.yaml",
)
DEFAULT_SEED_MANIFESTS = (
    ROOT / "verify/regression_seeds/ai_eda_npu_descriptor_queue.yaml",
    ROOT / "verify/regression_seeds/ai_eda_dma_backpressure_error.yaml",
    ROOT / "verify/regression_seeds/ai_eda_iommu_translation_fault.yaml",
    ROOT / "verify/regression_seeds/ai_eda_interrupt_reset_edges.yaml",
    ROOT / "verify/regression_seeds/ai_eda_npu_command_buffer.yaml",
)
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cocotb_stimulus"
CLAIM_BOUNDARY = "no_ai_generated_stimulus_as_evidence_until_cocotb_regression_passes"


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected YAML mapping")
    return data


def source_exists(source: str) -> bool:
    path_text, _, symbol = source.partition("::")
    path = ROOT / path_text
    if not path.exists():
        return False
    if not symbol:
        return True
    text = path.read_text(encoding="utf-8")
    return f"def {symbol}(" in text or f"async def {symbol}(" in text


def validate_coverage(path: Path, coverage: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if coverage.get("schema") != "eliza.ai_eda.coverage_bins.v1":
        errors.append(f"{path}: schema must be eliza.ai_eda.coverage_bins.v1")
    if not coverage.get("dut"):
        errors.append(f"{path}: dut is required")
    bins = coverage.get("bins")
    if not isinstance(bins, list) or not bins:
        errors.append(f"{path}: bins must be a non-empty list")
    else:
        seen: set[str] = set()
        for item in bins:
            if not isinstance(item, dict):
                errors.append(f"{path}: bin must be a mapping")
                continue
            bin_id = item.get("id")
            if not isinstance(bin_id, str) or not bin_id:
                errors.append(f"{path}: bin.id is required")
            elif bin_id in seen:
                errors.append(f"{path}: duplicate bin id {bin_id}")
            else:
                seen.add(bin_id)
            for field in ("description", "required_observation", "existing_reference"):
                if field not in item:
                    errors.append(f"{path}: bin {bin_id} missing {field}")
            references = item.get("existing_reference", [])
            if not isinstance(references, list) or not references:
                errors.append(f"{path}: bin {bin_id} existing_reference must be non-empty")
            else:
                for reference in references:
                    if not isinstance(reference, str) or not source_exists(reference):
                        errors.append(f"{path}: bin {bin_id} reference not found: {reference!r}")
    return errors


def validate_seeds(path: Path, seed_manifest: dict[str, Any], bin_ids: set[str]) -> list[str]:
    errors: list[str] = []
    if seed_manifest.get("schema") != "eliza.ai_eda.regression_seed_manifest.v1":
        errors.append(f"{path}: schema must be eliza.ai_eda.regression_seed_manifest.v1")
    seeds = seed_manifest.get("seeds")
    if not isinstance(seeds, list):
        errors.append(f"{path}: seeds must be a list")
        return errors
    for item in seeds:
        if not isinstance(item, dict):
            errors.append(f"{path}: seed must be a mapping")
            continue
        seed_id = item.get("id", "<unknown>")
        source = item.get("source")
        if not isinstance(source, str) or not source_exists(source):
            errors.append(f"{path}: seed {seed_id} source not found: {source!r}")
        if item.get("status") != "EXISTING_TEST_REFERENCE":
            errors.append(f"{path}: seed {seed_id} status must be EXISTING_TEST_REFERENCE")
        covers = item.get("covers")
        if not isinstance(covers, list) or not covers:
            errors.append(f"{path}: seed {seed_id} covers must be non-empty")
            continue
        unknown = sorted(str(bin_id) for bin_id in covers if str(bin_id) not in bin_ids)
        if unknown:
            errors.append(f"{path}: seed {seed_id} references unknown bins {unknown}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--coverage-bins", action="append", type=Path, default=[])
    parser.add_argument("--seed-manifest", action="append", type=Path, default=[])
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    args = parser.parse_args()
    if not args.dry_run:
        raise ValueError("only --dry-run mode is implemented for cocotb stimulus search")
    coverage_paths = args.coverage_bins or list(DEFAULT_COVERAGE_BINS)
    seed_paths = args.seed_manifest or list(DEFAULT_SEED_MANIFESTS)
    if len(seed_paths) != len(coverage_paths):
        raise ValueError("--seed-manifest count must match --coverage-bins count")

    scopes = []
    errors: list[str] = []
    for coverage_path, seed_path in zip(coverage_paths, seed_paths, strict=True):
        coverage = load_yaml(coverage_path)
        seeds = load_yaml(seed_path)
        errors.extend(validate_coverage(coverage_path, coverage))
        bins = coverage.get("bins", [])
        bin_ids = {str(item.get("id")) for item in bins if isinstance(item, dict)}
        errors.extend(validate_seeds(seed_path, seeds, bin_ids))
        seed_items = seeds.get("seeds", [])
        covered_by_seed = {
            str(bin_id)
            for seed in seed_items
            if isinstance(seed, dict)
            for bin_id in seed.get("covers", [])
        }
        scopes.append(
            {
                "coverage_bins": rel(coverage_path),
                "seed_manifest": rel(seed_path),
                "source_ids": coverage.get("source_ids", []),
                "dut": coverage.get("dut"),
                "required_followup_gates": coverage.get(
                    "required_followup_gates",
                    ["make cocotb-npu", "make cocotb-contract"],
                ),
                "coverage_bin_count": len(bins),
                "accepted_seed_count": len(seed_items) if isinstance(seed_items, list) else 0,
                "coverage_bins_detail": [
                    {
                        "id": item.get("id"),
                        "status": "UNMEASURED_DRY_RUN",
                        "accepted_seed_ids": [
                            seed.get("id")
                            for seed in seed_items
                            if isinstance(seed, dict) and item.get("id") in seed.get("covers", [])
                        ],
                        "has_seed_reference": item.get("id") in covered_by_seed,
                    }
                    for item in bins
                    if isinstance(item, dict)
                ],
                "accepted_seeds": seed_items,
            }
        )
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.cocotb_stimulus.dry_run {error}")
        return 1

    report = {
        "schema": "eliza.ai_eda.cocotb_stimulus.coverage_report.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "DRY_RUN",
        "claim_boundary": CLAIM_BOUNDARY,
        "backlog_item": "p0-llm4dv-cocotb-stimulus-loop",
        "scope_count": len(scopes),
        "duts": [scope["dut"] for scope in scopes],
        "generated_candidate_count": 0,
        "invalid_candidate_count": 0,
        "coverage_delta_available": False,
        "coverage_bin_count": sum(scope["coverage_bin_count"] for scope in scopes),
        "model_invocation": {"enabled": False},
        "scopes": scopes,
        "required_followup_gates": sorted(
            {gate for scope in scopes for gate in scope["required_followup_gates"]}
        ),
    }
    out_dir = args.out_root.resolve() / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "coverage_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.cocotb_stimulus.dry_run {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
