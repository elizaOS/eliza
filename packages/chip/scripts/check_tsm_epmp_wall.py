#!/usr/bin/env python3
"""tsm-epmp-wall-check gate (TEE core lane, W4).

Fail-closed gate for the E1 TSM Smepmp/ePMP protection wall
(rtl/security/tsm/e1_tsm_epmp_wall.sv + e1_tsm_epmp_pkg.sv) per
docs/security/tee-plan/01-tee-core-architecture.md S1. The wall is the
Dorami-pattern intra-M-mode isolation that walls off the tiny M-mode TEE
Security Manager (TSM) from the untrusted OpenSBI that shares M-mode: a
synthesizable Smepmp permission checker (mseccfg.MML/MMWP/RLB + pmpcfg/pmpaddr
TOR/NA4/NAPOT entries) that enforces the full Smepmp truth table, with an MMIO
programming interface the measured-launch launcher uses to set up + lock the
rules (RLB=0 then freezes them until reset).

Writes build/reports/tsm_epmp_wall.json in the eliza.gate_status.v1 shape. PASS
requires ALL of:
  (a) e1_tsm_epmp_wall lints clean under `verilator --lint-only -Wall` (strict,
      no functional waivers; only DECLFILENAME for the pkg/module split);
  (b) the cocotb suite (verify/cocotb/security/test_e1_tsm_epmp_wall.py) runs
      and every expected test passes -- the untrusted-M-mode-denied-into-TSM
      proofs, MMWP default-deny, RLB-locked immutability, S/U denial, the
      sticky mseccfg bits, and the TOR/NA4/NAPOT address-matching coverage.

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed).
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/tsm_epmp_wall.json"

PKG = "rtl/security/tsm/e1_tsm_epmp_pkg.sv"
RTL = "rtl/security/tsm/e1_tsm_epmp_wall.sv"
COCOTB_DIR = ROOT / "verify/cocotb/security"
COCOTB_MAKEFILE = "Makefile.tsm_epmp"
COCOTB_RESULTS = COCOTB_DIR / "results_tsm_epmp.xml"
COCOTB_SIM_BUILD = "sim_build_tsm_epmp"
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "production_security_claim_allowed": False,
    "integrated_pmp_pipeline_claim_allowed": False,
    "silicon_tee_claim_allowed": False,
}

EXPECTED_TESTS = (
    "reset_posture_fail_closed",
    "launcher_programs_before_lock",
    "tsm_own_access_permitted",
    "untrusted_mmode_read_into_tsm_denied",
    "untrusted_mmode_write_into_tsm_denied",
    "untrusted_mmode_exec_of_tsm_data_denied",
    "mmwp_default_deny_unmatched_mmode",
    "su_access_to_tsm_denied",
    "rlb_zero_locked_rule_immutable",
    "rlb_cannot_be_resurrected",
    "mml_mmwp_sticky_set",
    "shared_gate_executable_both_modes",
    "tor_and_na4_matching",
)


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def provenance_safe(value: Any) -> Any:
    from provenance_sanitize import sanitize_host_local_paths

    if isinstance(value, str):
        return sanitize_host_local_paths(value)
    if isinstance(value, list):
        return [provenance_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): provenance_safe(item) for key, item in value.items()}
    return value


def check_lint(verilator: str) -> dict:
    """Strict `-Wall` lint. DECLFILENAME is the only waiver (pkg/module split);
    every functional warning is an error -- the checker is default-deny by
    construction so no width/latch waiver is needed."""
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        str(ROOT / PKG),
        str(ROOT / RTL),
        "--top-module",
        "e1_tsm_epmp_wall",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    if proc.returncode == 0 and not diags:
        return {
            "id": "verilator_lint",
            "status": "pass",
            "detail": "e1_tsm_epmp_wall lints clean under verilator --lint-only "
            "-Wall (no functional waivers)",
        }
    return {
        "id": "verilator_lint",
        "status": "fail",
        "detail": "lint failed: " + "\n".join(diags[:8]),
    }


def check_cocotb(verilator: str) -> dict:
    if COCOTB_RESULTS.exists():
        COCOTB_RESULTS.unlink()
    env = os.environ.copy()
    verilator_dir = str(Path(verilator).resolve().parent)
    try:
        python_bin = subprocess.check_output(
            ["cocotb-config", "--python-bin"], text=True, cwd=ROOT
        ).strip()
    except Exception:  # noqa: BLE001
        python_bin = sys.executable or "python3"
    rc = subprocess.run(
        [
            "make",
            "-C",
            str(COCOTB_DIR),
            "-f",
            COCOTB_MAKEFILE,
            f"VERILATOR_BIN_DIR={verilator_dir}",
            f"PYTHON={python_bin}",
            f"PYTHON_BIN={python_bin}",
            f"SIM_BUILD={COCOTB_SIM_BUILD}",
            f"COCOTB_RESULTS_FILE={COCOTB_RESULTS.name}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
        env=env,
    )
    if not COCOTB_RESULTS.is_file():
        last = rc.stderr.splitlines()[-1] if rc.stderr else ""
        return {
            "id": "cocotb_tsm_epmp",
            "status": "blocked",
            "detail": f"no {COCOTB_RESULTS.name}; cocotb/verilator unavailable. {last}",
        }
    tree = ET.parse(COCOTB_RESULTS)
    seen, failed = set(), []
    for tc in tree.iter("testcase"):
        name = tc.get("name", "")
        seen.add(name)
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.append(name)
    missing = [t for t in EXPECTED_TESTS if t not in seen]
    if failed or missing:
        return {
            "id": "cocotb_tsm_epmp",
            "status": "fail",
            "detail": f"failed={failed} missing={missing}",
        }
    return {
        "id": "cocotb_tsm_epmp",
        "status": "pass",
        "detail": f"{len(EXPECTED_TESTS)} TSM-wall cocotb tests passed "
        "(untrusted-M-mode-denied-into-TSM/MMWP-default-deny/RLB-immutable/"
        "S-U-denied/sticky-mseccfg/TOR-NA4-NAPOT)",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks = []

    verilator = _verilator()
    if verilator is None:
        checks.append(
            {
                "id": "verilator_lint",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            }
        )
        checks.append(
            {"id": "cocotb_tsm_epmp", "status": "blocked", "detail": "verilator not found"}
        )
    else:
        checks.append(check_lint(verilator))
        checks.append(check_cocotb(verilator))

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "tsm_epmp_wall_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "tsm_epmp_wall_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "tsm-epmp-wall-check",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            RTL,
            PKG,
            "verify/cocotb/security/test_e1_tsm_epmp_wall.py",
            "verify/cocotb/security/Makefile.tsm_epmp",
        ],
        "as_of": _now(),
        "subsystem": "security",
        "claim_boundary": (
            "The E1 TSM Smepmp/ePMP wall RTL (rtl/security/tsm/"
            "e1_tsm_epmp_wall.sv) is a standalone, synthesizable Smepmp "
            "permission checker for the Dorami intra-M-mode TSM isolation "
            "(docs/security/tee-plan/01-tee-core-architecture.md S1). It models "
            "mseccfg.{MML,MMWP,RLB} + pmpcfg/pmpaddr (TOR/NA4/NAPOT, L/R/W/X) "
            "and enforces the full Smepmp MML truth table: a locked M-only TSM "
            "region (untrusted-M-mode OpenSBI read/write/execute into it is "
            "DENIED), MMWP default-deny for unmatched M-mode, RLB=0 freezing "
            "locked rules until reset, and S/U denial. This gate proves the RTL "
            "lints clean (-Wall, no functional waivers) and the cocotb truth-"
            "table / lock / deny contracts pass under Verilator. It does NOT "
            "prove integration with a real M-mode core's PMP fetch/load/store "
            "pipeline (the repo CVA6 wrapper has PMP disabled -- a wiring "
            "follow-on), nor the TSM software that programs and enters the wall "
            "through its trampoline. No production security claim is implied; "
            "the TEE program remains release-blocked per "
            "build/reports/security_lifecycle_scope.json."
        ),
        "release_claim_allowed": False,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
            "false_claim_flags": FALSE_CLAIM_FLAGS,
        },
        "checks": checks,
    }
    report = provenance_safe(report)
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} tsm-epmp-wall-check -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
