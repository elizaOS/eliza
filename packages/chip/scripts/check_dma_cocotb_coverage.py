#!/usr/bin/env python3
"""Fail-closed checker for the directed standalone DMA cocotb artifact."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COVERAGE = ROOT / "build/reports/dma_cocotb_coverage.json"
SCHEMA = "e1-chip.dma_cocotb_coverage.v1"
REQUIRED_CONTRACTS = frozenset(
    {
        "randomized_backpressure",
        "byte_exact_copy",
        "done_irq_clear",
        "zero_length_no_bus",
        "partial_tail_wstrb",
        "bus_response_error",
    }
)
REQUIRED_STATUS_BITS = ("busy", "done", "error")
REQUIRED_BOUNDARY_PHRASES = (
    "SoC fabric",
    "no coherent DMA",
    "IOMMU",
    "cache",
    "Linux dmaengine driver",
    "throughput",
    "production memory hierarchy",
)
FALSE_CLAIM_FLAGS = (
    "phone_claim_allowed",
    "release_claim_allowed",
    "production_memory_system_claim_allowed",
    "soc_fabric_claim_allowed",
    "coherent_dma_claim_allowed",
    "cache_coherency_claim_allowed",
    "iommu_claim_allowed",
    "linux_dmaengine_driver_claim_allowed",
    "throughput_claim_allowed",
)


def load_coverage(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"FAIL: missing DMA cocotb coverage artifact: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"FAIL: invalid JSON in {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"FAIL: {path}: top-level JSON must be an object")
    return payload


def validate_coverage(payload: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if payload.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA}")
    if payload.get("source") != "verify/cocotb/test_e1_dma.py":
        errors.append("source must name verify/cocotb/test_e1_dma.py")

    contracts = payload.get("covered_contracts")
    if not isinstance(contracts, list) or not all(isinstance(item, str) for item in contracts):
        errors.append("covered_contracts must be a list of strings")
        covered = set()
    else:
        covered = set(contracts)
    missing = sorted(REQUIRED_CONTRACTS - covered)
    if missing:
        errors.append(f"missing required DMA contracts: {', '.join(missing)}")

    status_bits = payload.get("status_bits")
    if not isinstance(status_bits, list) or not all(isinstance(item, str) for item in status_bits):
        errors.append("status_bits must be a list of strings")
        present_status = set()
    else:
        present_status = set(status_bits)
    missing_status = sorted(set(REQUIRED_STATUS_BITS) - present_status)
    if missing_status:
        errors.append(f"missing required status bits: {', '.join(missing_status)}")

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
        help="DMA cocotb coverage artifact to validate",
    )
    args = parser.parse_args(argv)

    payload = load_coverage(args.coverage)
    errors = validate_coverage(payload)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print(f"PASS: DMA cocotb coverage: {args.coverage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
