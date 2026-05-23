#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_rot_integration.py"

spec = importlib.util.spec_from_file_location("check_rot_integration", CHECK_PATH)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_rot_integration = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_rot_integration
spec.loader.exec_module(check_rot_integration)


def test_blocked_check_emits_finding() -> None:
    findings = check_rot_integration.structured_findings(
        checks=[
            {
                "id": "opentitan_pin",
                "status": "blocked",
                "detail": "external/opentitan/opentitan absent",
            }
        ],
        shimmed=[],
        blocker_id=None,
        blocker_reason=None,
        evidence_paths=[],
    )
    codes = [finding["code"] for finding in findings]
    if codes != ["rot_integration_check_blocked_opentitan_pin"]:
        raise AssertionError(codes)
    print("PASS RoT blocked checks emit structured findings")


def test_shim_and_physical_blocker_emit_findings() -> None:
    findings = check_rot_integration.structured_findings(
        checks=[],
        shimmed=[{"block": "rom_ctrl", "missing_dependency": "missing real RTL"}],
        blocker_id="rot_crypto_fips_entropy_physical",
        blocker_reason="FIPS entropy needs silicon AST noise source",
        evidence_paths=["rtl/security/rot/e1_rot_top.sv"],
    )
    codes = [finding["code"] for finding in findings]
    expected = {
        "rot_integration_crypto_block_shimmed_rom_ctrl",
        "rot_integration_blocker_rot_crypto_fips_entropy_physical",
    }
    if set(codes) != expected:
        raise AssertionError(codes)
    print("PASS RoT shim and physical blockers emit structured findings")


def main() -> None:
    test_blocked_check_emits_finding()
    test_shim_and_physical_blocker_emit_findings()


if __name__ == "__main__":
    main()
