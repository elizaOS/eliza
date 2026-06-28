#!/usr/bin/env python3
"""iopmp-rtl-check gate (secure-I/O lane, P1.3).

Fail-closed gate for the E1 IOPMP RTL (rtl/iommu/e1_iopmp.sv +
e1_iopmp_pkg.sv) per docs/security/tee-plan/03-secure-io-iommu-npu.md S1. The
IOPMP is the hardware enforcement of the RoT-programmed source-ID I/O policy:
a source-ID-gated, region-based R/W/X permission layer with default-deny,
programmed and locked by the RoT before the platform is released.

Writes build/reports/iopmp_rtl.json in the eliza.gate_status.v1 shape. PASS
requires ALL of:
  (a) the policy model docs/spec-db/tee-iopmp-source-id-map.json validates with
      scripts/check_tee_iopmp_policy.py (the RTL enforces what this declares);
  (b) e1_iopmp lints clean under `verilator --lint-only -Wall` (strict, no
      functional waivers);
  (c) the cocotb suite (verify/cocotb/security/test_e1_iopmp.py) runs and every
      expected test passes -- permit, default-deny, wrong-permission,
      out-of-range, write-after-lock, and the latched violation record.

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed).
"""

from __future__ import annotations

import datetime as _dt
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/iopmp_rtl.json"

IOPMP_PKG = "rtl/iommu/e1_iopmp_pkg.sv"
IOPMP_RTL = "rtl/iommu/e1_iopmp.sv"
POLICY_JSON = "docs/spec-db/tee-iopmp-source-id-map.json"
POLICY_CHECK = ROOT / "scripts/check_tee_iopmp_policy.py"
COCOTB_DIR = ROOT / "verify/cocotb/security"
COCOTB_MAKEFILE = "Makefile.iopmp"
COCOTB_RESULTS = COCOTB_DIR / "results_iopmp.xml"
COCOTB_SIM_BUILD = "sim_build_iopmp"

EXPECTED_TESTS = (
    "default_deny_before_programming",
    "lock_and_policy_ready",
    "enabled_unlocked_not_policy_ready",
    "permitted_source_passes",
    "non_matching_source_denied",
    "write_to_readonly_region_denied",
    "out_of_range_denied",
    "write_after_lock_dropped",
    "violation_record_latched",
    "permission_violation_type_latched",
)

FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "soc_fabric_integration_claim_allowed": False,
    "iommu_translation_claim_allowed": False,
    "silicon_claim_allowed": False,
    "secure_io_release_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def check_policy_model() -> dict:
    """The RTL enforces what the policy JSON declares; the JSON must validate."""
    if not (ROOT / POLICY_JSON).is_file():
        return {"id": "policy_model", "status": "blocked", "detail": f"{POLICY_JSON} missing"}
    proc = subprocess.run(
        [sys.executable, str(POLICY_CHECK)], capture_output=True, text=True, cwd=ROOT
    )
    if proc.returncode != 0:
        return {
            "id": "policy_model",
            "status": "fail",
            "detail": "tee-iopmp policy invalid: " + (proc.stderr.strip() or proc.stdout.strip()),
        }
    return {
        "id": "policy_model",
        "status": "pass",
        "detail": "tee-iopmp-source-id-map.json validates (default-deny, "
        "per-master source IDs); RTL enforces this model",
    }


def check_lint(verilator: str) -> dict:
    """Strict `-Wall` lint with NO functional waivers (default-deny by construction)."""
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        str(ROOT / IOPMP_PKG),
        str(ROOT / IOPMP_RTL),
        "--top-module",
        "e1_iopmp",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    if proc.returncode == 0 and not diags:
        return {
            "id": "verilator_lint",
            "status": "pass",
            "detail": "e1_iopmp lints clean under verilator --lint-only -Wall "
            "(no functional waivers)",
        }
    return {
        "id": "verilator_lint",
        "status": "fail",
        "detail": "lint failed: " + "\n".join(diags[:8]),
    }


def check_cocotb() -> dict:
    if COCOTB_RESULTS.exists():
        COCOTB_RESULTS.unlink()
    rc = subprocess.run(
        [
            "make",
            "-C",
            str(COCOTB_DIR),
            "-f",
            COCOTB_MAKEFILE,
            f"SIM_BUILD={COCOTB_SIM_BUILD}",
            f"COCOTB_RESULTS_FILE={COCOTB_RESULTS.name}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if not COCOTB_RESULTS.is_file():
        last = rc.stderr.splitlines()[-1] if rc.stderr else ""
        return {
            "id": "cocotb_iopmp",
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
            "id": "cocotb_iopmp",
            "status": "fail",
            "detail": f"failed={failed} missing={missing}",
        }
    return {
        "id": "cocotb_iopmp",
        "status": "pass",
        "detail": f"{len(EXPECTED_TESTS)} IOPMP cocotb tests passed "
        "(permit/default-deny/wrong-permission/out-of-range/write-after-lock/"
        "violation-record)",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks = [check_policy_model()]

    verilator = _verilator()
    if verilator is None:
        checks.append(
            {
                "id": "verilator_lint",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            }
        )
        checks.append({"id": "cocotb_iopmp", "status": "blocked", "detail": "verilator not found"})
    else:
        checks.append(check_lint(verilator))
        checks.append(check_cocotb())

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "iopmp_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "iopmp_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "iopmp-rtl-check",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        **FALSE_CLAIM_FLAGS,
        "evidence_paths": [
            IOPMP_RTL,
            IOPMP_PKG,
            POLICY_JSON,
            "scripts/check_tee_iopmp_policy.py",
            "verify/cocotb/security/test_e1_iopmp.py",
            "verify/cocotb/security/Makefile.iopmp",
        ],
        "as_of": _now(),
        "subsystem": "security",
        "claim_boundary": (
            "The E1 IOPMP RTL (rtl/iommu/e1_iopmp.sv) enforces the "
            "RoT-programmed source-ID I/O policy: a priority-ordered, "
            "source-ID-gated, region-based R/W/X permission table with "
            "DEFAULT-DENY by construction. Entries are programmable only while "
            "unlocked (the RoT programming window) and lock W1S-sticky before "
            "the platform is released; the first denied transaction is latched "
            "(source ID, address, type) for the RoT to read; policy_ready_o "
            "(enabled & locked) feeds e1_rot_reset_seq.iopmp_policy_ready_i. "
            "This gate proves the policy model validates, the RTL lints clean "
            "(-Wall, no functional waivers), and the cocotb permit/deny/lock/"
            "violation contracts pass. It does NOT prove SoC-level fabric "
            "wiring of the check port to every DMA master (integration item) "
            "nor IOMMU translation (separate block, rtl/iommu/e1_riscv_iommu.sv)."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} iopmp-rtl-check -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
