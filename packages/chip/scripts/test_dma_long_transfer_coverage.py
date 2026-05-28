#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_dma_long_transfer_coverage.py"


def load_gate():
    spec = importlib.util.spec_from_file_location("check_dma_long_transfer_coverage", CHECK)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def valid_payload(gate):
    return {
        "schema": gate.SCHEMA,
        "source": "verify/cocotb/dma/test_dma_long_transfer.py",
        "covered_contracts": sorted(gate.REQUIRED_CONTRACTS),
        "boundary": (
            "Directed standalone e1_dma long-transfer coverage only; "
            "no coherent DMA or production memory hierarchy coverage."
        ),
    }


def test_valid_payload_passes():
    gate = load_gate()

    assert gate.validate_coverage(valid_payload(gate)) == []


def test_missing_contract_fails():
    gate = load_gate()
    payload = valid_payload(gate)
    payload["covered_contracts"].remove("read_slverr_propagates")

    errors = gate.validate_coverage(payload)

    assert any("read_slverr_propagates" in error for error in errors)


def test_cli_rejects_missing_boundary(tmp_path):
    gate = load_gate()
    payload = valid_payload(gate)
    payload["boundary"] = "Directed standalone e1_dma coverage."
    coverage = tmp_path / "coverage.json"
    coverage.write_text(json.dumps(payload) + "\n", encoding="utf-8")

    assert gate.main(["--coverage", str(coverage)]) == 1
