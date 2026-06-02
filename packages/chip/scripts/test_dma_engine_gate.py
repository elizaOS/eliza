#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_dma_engine.py"
MAKEFILE = ROOT / "Makefile"


def load_gate():
    spec = importlib.util.spec_from_file_location("check_dma_engine", CHECK_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError(f"unable to import {CHECK_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_report_records_non_release_claim_flags() -> None:
    gate = load_gate()
    with tempfile.TemporaryDirectory() as tmp:
        original = gate.REPORT
        gate.REPORT = Path(tmp) / "dma_engine.json"
        try:
            gate.write_report(
                "PASS",
                None,
                None,
                {"verilator_lint": "clean", "cocotb": "FAIL=0"},
            )
            report = json.loads(gate.REPORT.read_text(encoding="utf-8"))
        finally:
            gate.REPORT = original

    for key in (
        "phone_claim_allowed",
        "release_claim_allowed",
        "production_memory_system_claim_allowed",
        "coherent_dma_claim_allowed",
        "linux_dmaengine_driver_claim_allowed",
        "throughput_claim_allowed",
    ):
        if report.get(key) is not False:
            raise AssertionError(f"{key} must be exactly false")
    if set(report["false_claim_flags"]) != set(gate.FALSE_CLAIM_FLAGS):
        raise AssertionError("false_claim_flags keys must match DMA engine claim flags")
    for key, value in report["false_claim_flags"].items():
        if value is not False:
            raise AssertionError(f"false_claim_flags.{key} must be exactly false")
    boundary = report.get("claim_boundary", "")
    for token in (
        "Does NOT cover SoC-fabric wiring",
        "Linux dmaengine driver",
        "silicon signoff",
    ):
        if token not in boundary:
            raise AssertionError(f"claim boundary missing {token!r}")
    print("PASS dma engine report keeps production claims false")


def test_makefile_wires_dma_engine_targets() -> None:
    makefile = MAKEFILE.read_text(encoding="utf-8")
    if ".PHONY: dma-engine-check dma-engine-gate-test" not in makefile:
        raise AssertionError("missing dma engine .PHONY targets")
    if "\ndma-engine-check:\n\t@$(PYTHON) scripts/check_dma_engine.py" not in makefile:
        raise AssertionError("dma-engine-check target not wired")
    if "\ndma-engine-gate-test:\n\t@$(PYTHON) scripts/test_dma_engine_gate.py" not in makefile:
        raise AssertionError("dma-engine-gate-test target not wired")
    print("PASS Makefile wires dma engine check targets")


def main() -> None:
    test_report_records_non_release_claim_flags()
    test_makefile_wires_dma_engine_targets()


if __name__ == "__main__":
    main()
