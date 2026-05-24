#!/usr/bin/env python3
"""mtt-checker gate (TEE-native confidential VM, lane 01 / work item W3).

Fail-closed gate for the E1 memory-tracking-table (MTT / RISC-V Smmtt) checker
RTL (rtl/security/mtt/e1_mtt_checker.sv + e1_mtt_pkg.sv) per
docs/security/tee-plan/01-tee-core-architecture.md S2. The MTT is the whole-OS
memory-isolation spine of the confidential VM: a hardware-walked, monitor-owned
table mapping every host-physical page to a {page state, owner domain}, checked
on every access against the requester's world. It enforces the six page states
of docs/security/confidential-domain.md / docs/spec-db/
tee-page-state-transitions.json with default-deny by construction.

Writes build/reports/mtt_checker.json in the eliza.gate_status.v1 shape. PASS
requires ALL of:
  (a) the shared page-state model (scripts/check_tee_page_state_model.py) still
      passes -- the RTL enforces the SAME six states / access semantics this
      pure-Python Mealy machine proves, so they must agree;
  (b) the page-state policy JSON (scripts/check_tee_page_state_policy.py)
      validates -- it is the single source of truth the RTL state numbering and
      the cocotb suite both derive from;
  (c) e1_mtt_pkg + e1_mtt_checker lint clean under `verilator --lint-only -Wall`
      (strict, no functional waivers -- default-deny by construction);
  (d) the cocotb suite (verify/cocotb/security/test_e1_mtt_checker.py) runs and
      every expected test passes -- permit confidential, deny host->confidential
      + fault record, shared per the I/O rule, default-deny on unmapped, the
      state-transition access invariant, and reprogram-after-lock dropped.

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
REPORT = ROOT / "build/reports/mtt_checker.json"

MTT_PKG = "rtl/security/mtt/e1_mtt_pkg.sv"
MTT_RTL = "rtl/security/mtt/e1_mtt_checker.sv"
PAGE_STATE_JSON = "docs/spec-db/tee-page-state-transitions.json"
MODEL_CHECK = ROOT / "scripts/check_tee_page_state_model.py"
POLICY_CHECK = ROOT / "scripts/check_tee_page_state_policy.py"
COCOTB_DIR = ROOT / "verify/cocotb/security"
COCOTB_MAKEFILE = "Makefile.mtt"
COCOTB_RESULTS = COCOTB_DIR / "results_mtt.xml"
COCOTB_SIM_BUILD = "sim_build_mtt"

EXPECTED_TESTS = (
    "default_deny_before_programming",
    "lock_and_ready",
    "enabled_unlocked_not_ready",
    "confidential_access_to_private_permitted",
    "host_access_to_private_denied_and_faulted",
    "host_access_to_measured_denied",
    "shared_page_accessible_per_io_rule",
    "free_page_host_only",
    "device_assigned_gated_by_dev_ok",
    "scrub_pending_denies_all",
    "unmapped_default_deny",
    "superpage_walk_one_step",
    "state_transition_enforced",
    "reprogram_after_lock_dropped",
)


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _run_model(script: Path, check_id: str, ok_detail: str) -> dict:
    if not script.is_file():
        return {"id": check_id, "status": "blocked", "detail": f"{script.name} missing"}
    proc = subprocess.run(
        [sys.executable, str(script)], capture_output=True, text=True, cwd=ROOT
    )
    if proc.returncode != 0:
        return {
            "id": check_id,
            "status": "fail",
            "detail": (proc.stderr.strip() or proc.stdout.strip())[:400],
        }
    return {"id": check_id, "status": "pass", "detail": ok_detail}


def check_page_state_model() -> dict:
    """The RTL enforces the SAME six-state machine the pure model proves."""
    return _run_model(
        MODEL_CHECK,
        "page_state_model",
        "page-state Mealy machine accepts legal / rejects illegal transitions; "
        "the MTT RTL enforces the same six states' access semantics",
    )


def check_page_state_policy() -> dict:
    """The transition JSON (shared source of truth for state numbering) validates."""
    return _run_model(
        POLICY_CHECK,
        "page_state_policy",
        "tee-page-state-transitions.json validates (six states, forbidden edges); "
        "the RTL PS_* encoding and the cocotb suite both derive from it",
    )


def check_lint(verilator: str) -> dict:
    """Strict `-Wall` lint with NO functional waivers (default-deny by construction)."""
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        str(ROOT / MTT_PKG),
        str(ROOT / MTT_RTL),
        "--top-module",
        "e1_mtt_checker",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    if proc.returncode == 0 and not diags:
        return {
            "id": "verilator_lint",
            "status": "pass",
            "detail": "e1_mtt_checker lints clean under verilator --lint-only -Wall "
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
            "id": "cocotb_mtt",
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
            "id": "cocotb_mtt",
            "status": "fail",
            "detail": f"failed={failed} missing={missing}",
        }
    return {
        "id": "cocotb_mtt",
        "status": "pass",
        "detail": f"{len(EXPECTED_TESTS)} MTT cocotb tests passed (permit-confidential/"
        "deny-host-to-confidential+fault/shared-per-IO-rule/default-deny/"
        "state-transition/reprogram-after-lock)",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks = [check_page_state_model(), check_page_state_policy()]

    verilator = _verilator()
    if verilator is None:
        checks.append(
            {
                "id": "verilator_lint",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            }
        )
        checks.append({"id": "cocotb_mtt", "status": "blocked", "detail": "verilator not found"})
    else:
        checks.append(check_lint(verilator))
        checks.append(check_cocotb())

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "mtt_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "mtt_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "mtt-checker",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            MTT_RTL,
            MTT_PKG,
            PAGE_STATE_JSON,
            "scripts/check_tee_page_state_model.py",
            "scripts/check_tee_page_state_policy.py",
            "verify/cocotb/security/test_e1_mtt_checker.py",
            "verify/cocotb/security/Makefile.mtt",
        ],
        "as_of": _now(),
        "subsystem": "security",
        "claim_boundary": (
            "The E1 MTT/Smmtt checker RTL (rtl/security/mtt/e1_mtt_checker.sv) is "
            "the whole-OS memory-isolation spine of the TEE-native confidential VM "
            "(01-tee-core-architecture.md S2). It walks a memory-resident, "
            "TSM-owned two-level table (root pointer programmed via MMIO, walked "
            "over a read-only AXI4 master) mapping every host-physical page to a "
            "{page state, owner domain}, and on each access {requester domain, "
            "addr, write?} returns a permit/deny verdict per the six "
            "confidential-domain.md page states and the I/O rule: a confidential "
            "(private/measured) or scrub-pending page is DENIED to the untrusted "
            "host; shared is the only cross-world bounce path; device-assigned is "
            "gated by the per-entry dev_ok (lane-03 source-ID match); unmapped is "
            "DEFAULT-DENY by construction. The root/enable are programmable only "
            "while unlocked AND by the privileged TSM (prog_unlock_i); lock is "
            "W1S-sticky so the untrusted host cannot reprogram it; the first "
            "denied access latches {domain, addr, state, write, kind}. This gate "
            "proves the shared page-state model agrees, the JSON policy validates, "
            "the RTL lints clean (-Wall, no functional waivers), and the cocotb "
            "permit/deny/fault/lock contracts pass. It does NOT prove SoC-fabric "
            "wiring of the requester domain-id to every master, an MTT entry "
            "cache, the TSM software transition-programming sequence, the memory "
            "crypto/integrity engine (MCIE, lane 01 S3), nor real-DRAM / "
            "side-channel evidence -- those remain BLOCKED follow-ons."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} mtt-checker -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
