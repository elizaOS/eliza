#!/usr/bin/env python3
"""Regression tests for CVA6 CPU/AP boot report claim boundaries."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_false_claim_flags(report: dict, flags: dict[str, bool]) -> None:
    boundary = report.get("claim_boundary")
    if not isinstance(boundary, str) or "not_" not in boundary:
        raise AssertionError(f"report claim_boundary must explicitly deny promotion: {boundary!r}")
    for key in flags:
        if report.get(key) is not False:
            raise AssertionError(f"{key} must be false in {report.get('gate')} report")


def test_linux_boot_cva6_write_denies_product_and_complete_boot_claims() -> None:
    gate = load_module("check_linux_boot_cva6", ROOT / "scripts/check_linux_boot_cva6.py")
    with tempfile.TemporaryDirectory() as tmp:
        gate.REPORT = Path(tmp) / "linux_boot_cva6.json"
        gate._write("PASS", None, None, ["evidence"], {"stage": "linux"}, stage="linux")
        report = json.loads(gate.REPORT.read_text(encoding="utf-8"))
        staged = json.loads((Path(tmp) / "linux_boot_cva6.linux.json").read_text(encoding="utf-8"))
    assert_false_claim_flags(report, gate.FALSE_CLAIM_FLAGS)
    assert_false_claim_flags(staged, gate.FALSE_CLAIM_FLAGS)
    if report["claim_boundary"] != gate.CLAIM_BOUNDARY:
        raise AssertionError("linux_boot_cva6 report claim boundary drifted")


def test_opensbi_cva6_write_denies_handoff_and_os_claims() -> None:
    gate = load_module("check_opensbi_cva6_boot", ROOT / "scripts/check_opensbi_cva6_boot.py")
    with tempfile.TemporaryDirectory() as tmp:
        gate.REPORT = Path(tmp) / "opensbi_cva6_boot.json"
        gate._write("PASS", None, None, ["evidence"], {"proof": "banner"})
        report = json.loads(gate.REPORT.read_text(encoding="utf-8"))
    assert_false_claim_flags(report, gate.FALSE_CLAIM_FLAGS)
    if report["claim_boundary"] != gate.CLAIM_BOUNDARY:
        raise AssertionError("opensbi_cva6_boot report claim boundary drifted")


def test_cva6_boot_substrate_write_denies_firmware_and_os_claims() -> None:
    gate = load_module("check_cva6_boot_substrate", ROOT / "scripts/check_cva6_boot_substrate.py")
    with tempfile.TemporaryDirectory() as tmp:
        gate.REPORT = Path(tmp) / "cva6_boot_substrate.json"
        gate._write("PASS", None, None, ["evidence"], {"proof": "bare metal"})
        report = json.loads(gate.REPORT.read_text(encoding="utf-8"))
    assert_false_claim_flags(report, gate.FALSE_CLAIM_FLAGS)
    if report["claim_boundary"] != gate.CLAIM_BOUNDARY:
        raise AssertionError("cva6_boot_substrate report claim boundary drifted")


def main() -> int:
    tests = [
        test_linux_boot_cva6_write_denies_product_and_complete_boot_claims,
        test_opensbi_cva6_write_denies_handoff_and_os_claims,
        test_cva6_boot_substrate_write_denies_firmware_and_os_claims,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
