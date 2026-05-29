#!/usr/bin/env python3
"""Fail-closed checker for the directed DMA long-transfer cocotb artifact."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COVERAGE = ROOT / "build/reports/dma_long_transfer_cocotb_coverage.json"
SCHEMA = "e1-chip.dma_long_transfer_cocotb_coverage.v1"
REQUIRED_CONTRACTS = frozenset(
    {
        "long_transfer_1kib",
        "bytes_done_accounting",
        "partial_tail_wstrb",
        "unaligned_programming_error",
        "completion_irq",
        "read_slverr_propagates",
    }
)
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
        raise SystemExit(f"FAIL: missing DMA long-transfer coverage artifact: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"FAIL: invalid JSON in {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"FAIL: {path}: top-level JSON must be an object")
    return payload


def validate_coverage(payload: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if payload.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA}")
    if payload.get("source") != "verify/cocotb/dma/test_dma_long_transfer.py":
        errors.append("source must name verify/cocotb/dma/test_dma_long_transfer.py")

    contracts = payload.get("covered_contracts")
    if not isinstance(contracts, list) or not all(isinstance(item, str) for item in contracts):
        errors.append("covered_contracts must be a list of strings")
        covered = set()
    else:
        covered = set(contracts)
    missing = sorted(REQUIRED_CONTRACTS - covered)
    if missing:
        errors.append(f"missing required long-transfer contracts: {', '.join(missing)}")

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
        help="DMA long-transfer coverage artifact to validate",
    )
    args = parser.parse_args(argv)

    payload = load_coverage(args.coverage)
    errors = validate_coverage(payload)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print(f"PASS: DMA long-transfer coverage: {args.coverage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
