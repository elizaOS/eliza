#!/usr/bin/env python3
"""Fail-closed checker for the CPU/memory/interrupt cocotb contract artifact."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COVERAGE = ROOT / "build/reports/cpu_mem_intc_cocotb_coverage.json"
SCHEMA = "e1-chip.cpu_mem_intc_cocotb_coverage.v1"
CLAIM_BOUNDARY = "directed_cpu_mem_intc_contract_only_not_system_or_release_evidence"
REQUIRED_CONTRACTS = frozenset(
    {
        "axi_lite_response_liveness_and_balance",
        "axi_lite_valid_ready_stability",
        "decode_error_debug_register",
        "dma_npu_display_mmio_no_side_effect",
        "dram_sram_capacity_boundary",
        "dram_strobes",
        "dram_unaligned_slverr_no_mutation",
        "interrupt_mask_pending_claim_complete",
        "linux_contract_display_mmio",
        "linux_contract_npu_mmio",
        "split_axil_write",
        "unmapped_read_slverr",
    }
)
REQUIRED_BOUNDARY_PHRASES = (
    "tiny CPU harness",
    "no phone",
    "release",
    "application-class CPU",
    "MMU",
    "cache",
    "coherency",
    "IOMMU",
    "production memory system",
    "full SoC routing",
    "Linux boot",
    "Android boot",
)
FALSE_CLAIM_FLAGS = (
    "phone_claim_allowed",
    "release_claim_allowed",
    "application_cpu_claim_allowed",
    "linux_boot_claim_allowed",
    "android_boot_claim_allowed",
    "mmu_claim_allowed",
    "cache_claim_allowed",
    "coherency_claim_allowed",
    "iommu_claim_allowed",
    "production_memory_system_claim_allowed",
    "full_soc_routing_claim_allowed",
)


def load_coverage(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"FAIL: missing CPU/memory/interrupt coverage artifact: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"FAIL: invalid JSON in {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"FAIL: {path}: top-level JSON must be an object")
    return payload


def validate_coverage(payload: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if payload.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA}")
    if payload.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"claim_boundary must be {CLAIM_BOUNDARY}")
    if payload.get("source") != "verify/cocotb/test_cpu_mem_intc_contract.py":
        errors.append("source must name verify/cocotb/test_cpu_mem_intc_contract.py")

    contracts = payload.get("covered_contracts")
    if not isinstance(contracts, list) or not all(isinstance(item, str) for item in contracts):
        errors.append("covered_contracts must be a list of strings")
        covered = set()
    else:
        covered = set(contracts)
    missing = sorted(REQUIRED_CONTRACTS - covered)
    if missing:
        errors.append(f"missing required CPU/memory/interrupt contracts: {', '.join(missing)}")

    for flag in FALSE_CLAIM_FLAGS:
        if payload.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")

    boundary = payload.get("boundary")
    if not isinstance(boundary, str):
        errors.append("boundary must be a string")
    else:
        for phrase in REQUIRED_BOUNDARY_PHRASES:
            if phrase not in boundary:
                errors.append(f"boundary must explicitly mention {phrase!r}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--coverage",
        type=Path,
        default=DEFAULT_COVERAGE,
        help="CPU/memory/interrupt cocotb coverage artifact to validate",
    )
    args = parser.parse_args(argv)

    payload = load_coverage(args.coverage)
    errors = validate_coverage(payload)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print(f"PASS: CPU/memory/interrupt cocotb coverage: {args.coverage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
