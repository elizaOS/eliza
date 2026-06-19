#!/usr/bin/env python3
"""Gate for the e1 OTP controller RTL (W4, rtl/security/otp/e1_otp_map.sv).

Runs two checks and writes an eliza.gate_status.v1 report to
build/reports/otp_rtl_check.json:

  1. ``verilator --lint-only -Wall`` elaborates the module clean.
  2. The cocotb suite verify/cocotb/security/test_e1_otp_map.py runs and every
     testcase passes (reset shadow load, 2-of-3 majority, single-/double-row
     fault, lifecycle transition gating, rollback advance-only, after-LOCKED
     write lock).

Status is PASS only when the lint is clean and the cocotb XML reports zero
failures/errors over a non-empty testcase set. Exits non-zero otherwise so the
caller fails closed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CHIP_ROOT = Path(__file__).resolve().parents[1]
RTL = CHIP_ROOT / "rtl/security/otp/e1_otp_map.sv"
COCOTB_DIR = "verify/cocotb/security"
COCOTB_TOP = "e1_otp_map"
COCOTB_MOD = "test_e1_otp_map"
RESULT_XML = CHIP_ROOT / "verify/cocotb/results" / f"{COCOTB_TOP}_{COCOTB_MOD}.xml"
REPORT_PATH = CHIP_ROOT / "build/reports/otp_rtl_check.json"
GATE = "otp-rtl-check"
BLOCKER_ID = "otp_rtl_check_failed"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "silicon_otp_claim_allowed": False,
    "efuse_macro_claim_allowed": False,
    "provisioning_claim_allowed": False,
    "secure_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

EVIDENCE_PATHS = [
    "rtl/security/otp/e1_otp_map.sv",
    "verify/cocotb/security/test_e1_otp_map.py",
    "verify/cocotb/security/Makefile",
    "docs/security/otp-fuse-map.md",
    "docs/spec-db/tee-otp-fuse-map.json",
]


def _toolchain_env() -> dict[str, str]:
    """Prepend the native oss-cad-suite bin so verilator/iverilog resolve even
    when the caller has not sourced tools/env.sh."""
    env = os.environ.copy()
    bin_dir = CHIP_ROOT / "external/oss-cad-suite/bin"
    if bin_dir.is_dir():
        env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    return env


def run_lint() -> tuple[bool, str]:
    proc = subprocess.run(
        ["verilator", "--lint-only", "-Wall", str(RTL)],
        cwd=CHIP_ROOT,
        capture_output=True,
        text=True,
        env=_toolchain_env(),
    )
    ok = proc.returncode == 0
    detail = "clean" if ok else (proc.stderr.strip() or proc.stdout.strip())
    return ok, detail


def run_cocotb() -> tuple[bool, str]:
    venv_python = CHIP_ROOT / ".venv/bin/python"
    env = _toolchain_env()
    env["COCOTB_TOPLEVEL"] = COCOTB_TOP
    env["COCOTB_MODULE"] = COCOTB_MOD
    env["COCOTB_DIR"] = COCOTB_DIR
    if venv_python.exists():
        env["PYTHON"] = str(venv_python)
    proc = subprocess.run(
        ["scripts/run_cocotb.sh"],
        cwd=CHIP_ROOT,
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-500:]
    return parse_cocotb_xml()


def parse_cocotb_xml() -> tuple[bool, str]:
    if not RESULT_XML.exists():
        return False, f"missing cocotb result {RESULT_XML}"
    text = RESULT_XML.read_text(errors="ignore")
    root = ET.fromstring(text)
    cases = list(root.iter("testcase"))
    failures = sum(1 for c in cases if c.find("failure") is not None)
    errors = sum(1 for c in cases if c.find("error") is not None)
    if not cases:
        return False, "no cocotb testcases ran"
    if failures or errors:
        return False, f"{failures} failure(s), {errors} error(s) of {len(cases)} cases"
    return True, f"{len(cases)} testcases passed"


def main() -> int:
    report: dict[str, Any]
    now = datetime.now(UTC).isoformat()
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)

    if not RTL.exists():
        report = {
            "schema": "eliza.gate_status.v1",
            "gate": GATE,
            "status": "BLOCKED",
            "blocker_id": BLOCKER_ID,
            "blocker_reason": f"missing RTL {RTL.relative_to(CHIP_ROOT)}",
            **FALSE_CLAIM_FLAGS,
            "evidence_paths": [],
            "as_of": now,
            "subsystem": "security",
        }
        REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
        print(f"BLOCKED: {report['blocker_reason']}", file=sys.stderr)
        return 1

    checks = []
    lint_ok, lint_detail = run_lint()
    checks.append(
        {
            "id": "verilator_lint_only_clean",
            "status": "pass" if lint_ok else "fail",
            "detail": lint_detail,
        }
    )

    cocotb_ok, cocotb_detail = run_cocotb()
    checks.append(
        {
            "id": "cocotb_otp_suite_pass",
            "status": "pass" if cocotb_ok else "fail",
            "detail": cocotb_detail,
        }
    )

    failures = [c["id"] for c in checks if c["status"] != "pass"]
    passed = not failures

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": GATE,
        "status": "PASS" if passed else "BLOCKED",
        "blocker_id": None if passed else BLOCKER_ID,
        "blocker_reason": None if passed else "; ".join(failures),
        "evidence_paths": EVIDENCE_PATHS,
        "as_of": now,
        "subsystem": "security",
        "claim_boundary": (
            "OTP controller RTL lint + simulation only; not silicon OTP/eFuse "
            "evidence and not a selected OTP macro. The behavioral contract is "
            "docs/security/otp-fuse-map.md (§2 field semantics, §3 2-of-3 "
            "majority, §4 write authorization) over the partition layout in "
            "docs/spec-db/tee-otp-fuse-map.json."
        ),
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": failures,
        },
        "checks": checks,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")

    if passed:
        print(f"PASS: OTP RTL gate ({len(checks)} checks); report {REPORT_PATH}")
        return 0
    print(f"BLOCKED: {'; '.join(failures)}", file=sys.stderr)
    for c in checks:
        if c["status"] != "pass":
            print(f"  - {c['id']}: {c['detail']}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
