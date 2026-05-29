#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_cpu_mem_intc_cocotb_coverage.py"


def load_gate():
    spec = importlib.util.spec_from_file_location("check_cpu_mem_intc_cocotb_coverage", CHECK)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def valid_payload(gate):
    return {
        "schema": gate.SCHEMA,
        "claim_boundary": gate.CLAIM_BOUNDARY,
        "source": "verify/cocotb/test_cpu_mem_intc_contract.py",
        "covered_contracts": sorted(gate.REQUIRED_CONTRACTS),
        "boundary": (
            "Directed AXI-Lite tiny CPU harness checks only; no phone, release, "
            "application-class CPU, MMU, cache, coherency, IOMMU, production "
            "memory system, full SoC routing, Linux boot, or Android boot coverage."
        ),
        **{flag: False for flag in gate.FALSE_CLAIM_FLAGS},
    }


def test_valid_payload_passes():
    gate = load_gate()

    assert gate.validate_coverage(valid_payload(gate)) == []


def test_missing_contract_fails():
    gate = load_gate()
    payload = valid_payload(gate)
    payload["covered_contracts"].remove("linux_contract_display_mmio")

    errors = gate.validate_coverage(payload)

    assert any("linux_contract_display_mmio" in error for error in errors)


def test_rejects_missing_or_true_false_claim_flag():
    gate = load_gate()
    payload = valid_payload(gate)
    payload.pop("iommu_claim_allowed")
    payload["release_claim_allowed"] = True

    errors = gate.validate_coverage(payload)

    assert any("iommu_claim_allowed" in error for error in errors)
    assert any("release_claim_allowed" in error for error in errors)


def test_cli_rejects_missing_boundary(tmp_path):
    gate = load_gate()
    payload = valid_payload(gate)
    payload["boundary"] = "Directed local interconnect coverage."
    coverage = tmp_path / "coverage.json"
    coverage.write_text(json.dumps(payload) + "\n", encoding="utf-8")

    assert gate.main(["--coverage", str(coverage)]) == 1
