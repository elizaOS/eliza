#!/usr/bin/env python3
"""Regression tests for the documented DRAM controller Make targets."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_documented_dram_controller_target_exists() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert ".PHONY: dram-controller-check" in makefile
    assert "\ndram-controller-check:\n\t@$(PYTHON) scripts/check_dram_controller.py\n" in makefile


def test_memory_axi4_check_runs_dram_controller_gate() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    target = makefile.split("\nmemory-axi4-check:\n", 1)[1].split("\n\n", 1)[0]
    assert "@$(MAKE) -s dram-controller-check" in target


def test_dram_controller_report_has_claim_boundary_fields() -> None:
    checker = (ROOT / "scripts/check_dram_controller.py").read_text(encoding="utf-8")
    assert '"phone_claim_allowed": False' in checker
    assert '"release_claim_allowed": False' in checker
    assert "not phone-class memory evidence" in checker
    assert '"cocotb_result": "verify/cocotb/memory/results.xml"' in checker


if __name__ == "__main__":
    test_documented_dram_controller_target_exists()
    test_memory_axi4_check_runs_dram_controller_gate()
    test_dram_controller_report_has_claim_boundary_fields()
    print("PASS dram controller Make target regression")
