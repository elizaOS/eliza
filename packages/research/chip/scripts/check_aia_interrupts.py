#!/usr/bin/env python3
"""AIA interrupt gate (RISC-V Advanced Interrupt Architecture: IMSIC + APLIC).

Fail-closed gate for the E1 AIA RTL — the modern message-signalled interrupt
(MSI) path Linux/AOSP uses for device interrupts and virtualization, and the
"Secure IRQ (IMSIC)" the confidential domain requires
(docs/security/tee-plan/03-secure-io-iommu-npu.md §5). It is the complement to
the level-line CLINT/PLIC at rtl/interrupts/e1_clint.sv / e1_plic.sv.

  * rtl/interrupts/e1_imsic.sv — per-hart IMSIC interrupt files with EIP/EIE
    arrays, the memory-mapped seteipnum MSI doorbell, the xtopei claim/clear
    interface, and a per-file world qualifier (secure vs host) that gates every
    doorbell write so a confidential-domain MSI is isolated from the host world.
  * rtl/interrupts/e1_aplic.sv — APLIC in MSI mode: per-source sourcecfg
    (edge/level + M->S delegation), per-domain enable + target (dest IMSIC file,
    EIID, secure-world bit), and the MSI generation that writes the doorbell.

Writes build/reports/aia_interrupts.json in the eliza.gate_status.v1 shape.
PASS requires ALL of:
  (a) e1_imsic + e1_aplic lint clean under `verilator --lint-only -Wall` with
      NO functional waivers (only -Wno-DECLFILENAME, a filename-vs-module
      cosmetic). Strict lint is fail-closed by construction.
  (b) the cocotb KAT (verify/cocotb/security/test_e1_aia.py) runs and every
      expected test passes — device-MSI->IMSIC->topei->claim, AIA priority
      ordering, eie masking, M->S delegation, and the secure-domain isolation
      proof (a host-world MSI to the secure file is rejected and sets nothing;
      a confidential MSI lands only in the secure file; the APLIC secure target
      delivers only into the secure file).

If verilator/cocotb is unavailable the gate reports BLOCKED with the missing
dependency and exits non-zero (fail-closed), exactly as check_mcie.py.

CLAIM BOUNDARY. This gate proves the IMSIC + APLIC leaf semantics and the
secure-world doorbell gate against the harness. It does NOT prove the CSR-side
mtopei/stopei wiring into a real hart (the eidelivery/eithreshold/eip*/eie*
indirect CSR window lives in the core), nor the IOMMU MSI-translation binding
(rtl/iommu/e1_iommu_msi_xlate.sv, Phase P5.1) that drives msi_world_i from the
issuing device's owning DID. Those remain BLOCKED follow-ons.
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
REPORT = ROOT / "build/reports/aia_interrupts.json"

IMSIC_RTL = "rtl/interrupts/e1_imsic.sv"
APLIC_RTL = "rtl/interrupts/e1_aplic.sv"
COCOTB_DIR = ROOT / "verify/cocotb/security"
COCOTB_MAKEFILE = "Makefile.aia"
COCOTB_RESULTS = COCOTB_DIR / "results_aia.xml"
COCOTB_SIM_BUILD = "sim_build_aia"

EXPECTED_TESTS = (
    "device_msi_to_topei_claim",
    "topei_priority_order",
    "eie_masking",
    "m_to_s_delegation",
    "secure_domain_isolation",
)


def _verilator() -> str | None:
    found = shutil.which("verilator")
    if found:
        return found
    oss = ROOT / "external/oss-cad-suite/bin/verilator"
    return str(oss) if oss.is_file() else None


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _lint_one(verilator: str, rel: str, top: str) -> dict:
    """Strict `-Wall` lint of one module with no functional waivers."""
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        str(ROOT / rel),
        "--top-module",
        top,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    diags = [ln for ln in proc.stderr.splitlines() if "%Warning" in ln or "%Error" in ln]
    if proc.returncode == 0 and not diags:
        return {
            "id": f"verilator_lint_{top}",
            "status": "pass",
            "detail": f"{rel} lints clean under verilator --lint-only -Wall (no functional waivers)",
        }
    return {
        "id": f"verilator_lint_{top}",
        "status": "fail",
        "detail": f"{rel} lint failed: " + "\n".join(diags[:8]),
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
            "id": "cocotb_aia",
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
            "id": "cocotb_aia",
            "status": "fail",
            "detail": f"failed={failed} missing={missing}",
        }
    return {
        "id": "cocotb_aia",
        "status": "pass",
        "detail": f"{len(EXPECTED_TESTS)} AIA cocotb tests passed (device-MSI->IMSIC->topei->claim/"
        "priority-order/eie-masking/M->S-delegation/secure-domain-isolation)",
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks: list[dict] = []

    verilator = _verilator()
    if verilator is None:
        checks.append(
            {
                "id": "verilator_lint",
                "status": "blocked",
                "detail": "verilator not found; source tools/env.sh / install oss-cad-suite",
            }
        )
        checks.append({"id": "cocotb_aia", "status": "blocked", "detail": "verilator not found"})
    else:
        checks.append(_lint_one(verilator, IMSIC_RTL, "e1_imsic"))
        checks.append(_lint_one(verilator, APLIC_RTL, "e1_aplic"))
        checks.append(check_cocotb())

    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)

    if has_fail:
        status, blocker_id = "FAIL", "aia_check_failure"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail"
        )
    elif has_block:
        status, blocker_id = "BLOCKED", "aia_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "aia_interrupts",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            IMSIC_RTL,
            APLIC_RTL,
            "verify/cocotb/security/e1_aia_top.sv",
            "verify/cocotb/security/test_e1_aia.py",
            "verify/cocotb/security/Makefile.aia",
        ],
        "as_of": _now(),
        "subsystem": "interrupts",
        "dt_compatible": ["riscv,imsics", "riscv,aplic"],
        "claim_boundary": (
            "The E1 AIA RTL (rtl/interrupts/e1_imsic.sv + e1_aplic.sv) is the "
            "modern RISC-V message-signalled-interrupt path used by Linux/AOSP "
            "and required for the confidential domain's Secure IRQ "
            "(03-secure-io-iommu-npu.md §5). The IMSIC models per-hart interrupt "
            "files (EIP/EIE arrays) reached only by the memory-mapped seteipnum "
            "doorbell (offset 0 of each 4 KiB file page); the highest-priority "
            "pending+enabled identity (AIA: lowest identity = highest priority, "
            "masked by eithreshold) is exposed via the xtopei claim interface, "
            "and a claim pulse clears that identity's EIP. The APLIC runs in MSI "
            "mode with two domains (M parent, S child): per-source sourcecfg "
            "(inactive/edge/level + delegate), M->S delegation, and a per-domain "
            "target {dest IMSIC file, EIID, secure-world bit} whose firing emits "
            "one MSI write to the targeted file's doorbell (a level interlock "
            "yields exactly one MSI per assertion). SECURE-DOMAIN ISOLATION: "
            "every doorbell write carries a world qualifier; the IMSIC commits it "
            "only when the addressed file's world matches, so an untrusted-world "
            "MSI can never set a bit in the secure/monitor file and a secure MSI "
            "never lands in a host file. This gate proves the leaf semantics and "
            "the world gate (lint -Wall no functional waivers, cocotb KAT). It "
            "does NOT prove the CSR-side mtopei/stopei wiring into a real hart "
            "(the indirect eidelivery/eithreshold/eip*/eie* CSR window lives in "
            "the core), nor the IOMMU MSI-translation binding "
            "(rtl/iommu/e1_iommu_msi_xlate.sv, P5.1) that drives msi_world_i from "
            "the issuing device's owning DID — those remain BLOCKED follow-ons."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"STATUS: {status} aia_interrupts -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")

    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
