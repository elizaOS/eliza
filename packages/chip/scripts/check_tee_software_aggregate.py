#!/usr/bin/env python3
"""Aggregate gate for the buildable-now TEE software checkers (OS WI-0).

Runs every pure-software TEE checker/model and reports a single pass/blocked
summary. This is the lowest-risk Phase-1 win from tee-plan/07 section 8: it
wires the previously-orphaned check_tee_*.py scripts plus the new Phase-1 models
into one gate. Silicon/FPGA/lab work is tracked as BLOCKED scope items naming
the missing dependency and proving command; this aggregate enforces only the
software floor and stays release-blocked for product-grade TEE claims.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from provenance_sanitize import sanitize_host_local_paths

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/reports/tee_software_aggregate.json"

# (id, script) — each is a self-contained checker that exits 0 on pass.
SOFTWARE_CHECKERS: list[tuple[str, str]] = [
    ("confidential-domain-contract", "scripts/check_tee_confidential_domain_contract.py"),
    ("page-state-policy", "scripts/check_tee_page_state_policy.py"),
    ("page-state-model", "scripts/check_tee_page_state_model.py"),
    ("iopmp-policy", "scripts/check_tee_iopmp_policy.py"),
    ("side-channel-claims", "scripts/check_tee_side_channel_claims.py"),
    ("attestation-evidence", "scripts/check_tee_attestation_evidence.py"),
    ("cove-quote", "scripts/check_cove_quote.py"),
    ("quote-serializer", "scripts/test_tee_quote_serializer.py"),
    ("measured-launch-map", "scripts/check_tee_measured_launch_map.py"),
    ("evidence-policy-fixtures", "scripts/test_tee_evidence_policy.py"),
    ("image-manifest", "scripts/check_tee_image_manifest.py"),
    ("topology-policy", "scripts/check_tee_topology_policy.py"),
    ("core-target", "scripts/check_tee_core_target.py"),
    ("core-scope", "scripts/check_tee_core_scope.py"),
    ("otp-fuse-map", "scripts/check_otp_fuse_map.py"),
    ("otp-fuse-map-test", "scripts/test_otp_fuse_map.py"),
    ("mee-freshness-model", "scripts/check_tee_mee_freshness_model.py"),
    ("integrity-tree-model", "scripts/check_tee_integrity_tree_model.py"),
    ("integrity-tree-model-test", "scripts/test_tee_integrity_tree_model.py"),
    ("purge-sequence-scope", "scripts/check_tee_purge_sequence_scope.py"),
]

# Phase-2/3 work that is BLOCKED on FPGA / silicon / LPDDR PHY / side-channel
# lab. Each names the dependency and the command that will later prove it.
BLOCKED_HARDWARE_GATES: list[dict[str, str]] = [
    {
        "id": "mtt-checker-rtl",
        "claim": "per-access MTT page-state enforcement in hardware (C3)",
        "missing_dependency": "rtl/security/e1_mtt_checker.sv + cocotb harness",
        "proving_command": "make cocotb-mtt-checker (pending RTL landing)",
    },
    {
        "id": "tsm-epmp-wall-rtl",
        "claim": "Smepmp Dorami wall isolates TSM from OpenSBI (C4)",
        "missing_dependency": "rtl/security/e1_tsm_epmp_wall.sv",
        "proving_command": "make cocotb-tsm-wall (pending RTL landing)",
    },
    {
        "id": "secure-boot-rom",
        "claim": "verified secure boot chain (R2/R3/R7)",
        "missing_dependency": "fw/boot-rom/secure constant-time Ed25519 + measurement extend",
        "proving_command": "make boot-security-chain-contract-check (pending firmware + negative vectors)",
    },
    {
        "id": "otp-lc-ctrl-rtl",
        "claim": "OTP shadow regs + 6-state lc_ctrl (R4/R5)",
        "missing_dependency": "rtl/security/otp/e1_otp_map.sv + rtl/security/lc/e1_lc_ctrl.sv",
        "proving_command": "make otp-fuse-map-check on RTL (pending RTL landing)",
    },
    {
        "id": "iommu-iopmp-rebuild",
        "claim": "two-stage IOMMU + IOPMP source-ID enforcement (IO1-IO8)",
        "missing_dependency": "rtl/iommu/* PTW + DDT/PDT + IOPMP",
        "proving_command": "make cocotb-iommu + iommu-evidence-check (pending greenfield RTL)",
    },
    {
        "id": "npu-secure-io-rehome",
        "claim": "NPU re-homed behind IOMMU as confidential I/O (IO11-IO13)",
        "missing_dependency": "rtl/npu/e1_npu_secure_io.sv + private-queue FSM",
        "proving_command": "make cocotb-npu-secure-io (pending RTL landing)",
    },
    {
        "id": "mcie-lpddr5x",
        "claim": "MCIE AES-CTR + integrity tree on real LPDDR5X (section 3.2)",
        "missing_dependency": "docs/evidence/memory/lpddr-phy-procurement.yaml + DRAM controller",
        "proving_command": "make dramsim-sweep + ciphertext bench (pending PHY + silicon)",
    },
    {
        "id": "side-channel-lab",
        "claim": "TVLA/DPA/glitch/ciphertext-bench/tamper validation (section 6)",
        "missing_dependency": "side-channel lab + DDR capture bench",
        "proving_command": "lab validation campaign (pending silicon + lab)",
    },
]


def run_checker(checker_id: str, script: str) -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    status = "pass" if result.returncode == 0 else "fail"
    row: dict[str, Any] = {
        "id": checker_id,
        "script": script,
        "status": status,
        "returncode": result.returncode,
    }
    if status != "pass":
        row["stdout_tail"] = [
            sanitize_host_local_paths(line)
            for line in (result.stdout.strip().splitlines()[-1:] if result.stdout else [])
        ]
        row["stderr_tail"] = [
            sanitize_host_local_paths(line)
            for line in (result.stderr.strip().splitlines()[-3:] if result.stderr else [])
        ]
    return row


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def structured_findings(
    software_checks: list[dict[str, Any]],
    blocked_hardware_gates: list[dict[str, str]],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for gate in blocked_hardware_gates:
        gate_id = str(gate.get("id", "hardware_gate"))
        findings.append(
            {
                "code": f"tee_software_missing_hardware_gate_{code_from_text(gate_id, 'gate')}",
                "severity": "blocker",
                "message": (
                    f"{gate.get('claim', gate_id)} remains blocked by "
                    f"{gate.get('missing_dependency', 'missing hardware evidence')}"
                ),
                "evidence": gate.get("proving_command"),
                "next_step": (
                    "Implement the missing TEE/security hardware dependency and "
                    "capture the named proving command before promoting the "
                    "software TEE floor to product-grade TEE evidence."
                ),
            }
        )
    for check in software_checks:
        if check.get("status") == "pass":
            continue
        check_id = str(check.get("id", "software_check"))
        findings.append(
            {
                "code": f"tee_software_check_failed_{code_from_text(check_id, 'check')}",
                "severity": "blocker",
                "message": f"{check_id} returned {check.get('returncode')}",
                "evidence": check.get("script"),
                "next_step": (
                    "Repair the failing pure-software TEE checker before using "
                    "the aggregate as a software-floor signal."
                ),
            }
        )
    return findings


def build_report() -> dict[str, Any]:
    checks = [run_checker(checker_id, script) for checker_id, script in SOFTWARE_CHECKERS]
    failed = [check for check in checks if check["status"] != "pass"]
    return {
        "schema": "eliza.tee_software_aggregate.v1",
        "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "status": "tee_software_floor_only_release_blocked",
        "claim_boundary": (
            "Pure-software TEE models, contracts, and checkers only; not secure "
            "boot, not memory encryption, not IOMMU/NPU isolation, not silicon, "
            "and not side-channel evidence."
        ),
        "software_checks": checks,
        "blocked_hardware_gates": BLOCKED_HARDWARE_GATES,
        "findings": structured_findings(checks, BLOCKED_HARDWARE_GATES),
        "summary": {
            "software_check_count": len(checks),
            "software_passing_count": len(checks) - len(failed),
            "blocked_hardware_count": len(BLOCKED_HARDWARE_GATES),
            "release_claim_allowed": False,
        },
    }


def main() -> int:
    report = build_report()
    checks = report["software_checks"]
    failed = [check for check in checks if check["status"] != "pass"]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    for check in checks:
        marker = "PASS" if check["status"] == "pass" else "FAIL"
        print(f"{marker}: tee software check: {check['id']} ({check['script']})")
        if check["status"] != "pass":
            for line in check["stderr_tail"]:
                print(f"      {line}", file=sys.stderr)
    for gate in BLOCKED_HARDWARE_GATES:
        print(f"BLOCKED: {gate['id']}: {gate['missing_dependency']} -> {gate['proving_command']}")

    if failed:
        print(
            f"FAIL: {len(failed)}/{len(checks)} TEE software checkers failed",
            file=sys.stderr,
        )
        return 1
    print(
        f"PASS: {len(checks)} TEE software checkers; "
        f"{len(BLOCKED_HARDWARE_GATES)} hardware gates BLOCKED (release-blocked floor)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
