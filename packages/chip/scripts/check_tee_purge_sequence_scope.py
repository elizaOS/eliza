#!/usr/bin/env python3
"""Purge-sequence scope gate (lane 04 section 6, fail-closed).

Runs the pure-software cross-domain purge-sequence model against positive and
negative vectors, then emits a scope report that stays release-blocked: the
model proves the ordering contract but NOT the silicon behavior. The RTL
sequencer, the SVA proof, and the FPGA residue/single-step harnesses are named
here as BLOCKED with the proving command for each.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tee.purge_sequence_model import (  # noqa: E402
    PURGE_STEPS,
    PurgeError,
    PurgeSequencer,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/reports/tee_purge_sequence_scope.json"

BLOCKED_UNTIL_REAL_EVIDENCE = [
    {
        "claim": "cross-domain microarchitectural purge enforced in hardware",
        "missing_dependency": "rtl/cpu/cd_purge_seq.sv + integration",
        "proving_command": "make tee-purge-sva (Verilator/formal; BLOCKED until RTL lands)",
    },
    {
        "claim": "no boundary crossing completes with an unacked purge step",
        "missing_dependency": "SystemVerilog assertions over cd_purge_seq.sv",
        "proving_command": "make formal (SVA: no CD boundary completes while ack low)",
    },
    {
        "claim": "no CD-ASID L1D / BPU residue survives a domain switch",
        "missing_dependency": "FPGA bitstream + cache/BPU residue probe harness",
        "proving_command": "FPGA residue harness (BLOCKED until bitstream)",
    },
    {
        "claim": "single-step yields no clean secret observation",
        "missing_dependency": "FPGA single-step (SGX-Step-class) harness",
        "proving_command": "FPGA single-step harness (BLOCKED until bitstream)",
    },
]


def model_failures() -> list[str]:
    errors: list[str] = []

    # Positive: full in-order ack sequence permits the crossing.
    sequencer = PurgeSequencer()
    try:
        for step in PURGE_STEPS:
            sequencer.ack(step)
        sequencer.assert_can_cross()
    except PurgeError as exc:
        errors.append(f"in-order purge sequence rejected: {exc}")

    # Negative: completing before the final ack must block the crossing.
    partial = PurgeSequencer()
    for step in PURGE_STEPS[:-1]:
        partial.ack(step)
    try:
        partial.assert_can_cross()
        errors.append("crossing allowed with an unacked purge step")
    except PurgeError:
        pass

    # Negative: out-of-order ack must fault.
    misordered = PurgeSequencer()
    try:
        misordered.ack(PURGE_STEPS[1])
        errors.append("out-of-order purge ack accepted")
    except PurgeError:
        pass

    return errors


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def structured_findings(
    blocked_until_real_evidence: list[dict[str, str]],
    checks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for item in blocked_until_real_evidence:
        claim = str(item.get("claim", "purge evidence"))
        findings.append(
            {
                "code": (
                    f"tee_purge_missing_real_evidence_{code_from_text(claim, 'purge_evidence')}"
                ),
                "severity": "blocker",
                "message": (
                    f"{claim} remains blocked by "
                    f"{item.get('missing_dependency', 'missing real evidence')}"
                ),
                "evidence": item.get("proving_command"),
                "next_step": (
                    "Implement the missing purge RTL/formal/FPGA evidence path "
                    "and capture the named proving command before treating the "
                    "software purge model as runtime isolation evidence."
                ),
            }
        )
    for check in checks:
        if check.get("status") == "pass":
            continue
        check_id = str(check.get("id", "model_check"))
        findings.append(
            {
                "code": f"tee_purge_model_check_failed_{code_from_text(check_id, 'check')}",
                "severity": "blocker",
                "message": f"{check_id} is {check.get('status')}",
                "evidence": check.get("evidence"),
                "next_step": (
                    "Repair the purge sequence software model vectors before "
                    "using the scope report as an ordering-contract signal."
                ),
            }
        )
    return findings


def build_report() -> dict[str, Any]:
    model_errors = model_failures()
    checks = [
        {
            "id": "purge_sequence_model_positive_negative_vectors",
            "status": "pass" if not model_errors else "fail",
            "evidence": "scripts/tee/purge_sequence_model.py",
            "detail": model_errors,
        }
    ]
    return {
        "schema": "eliza.tee_purge_sequence_scope.v1",
        "status": "tee_purge_sequence_scope_release_blocked",
        "claim_boundary": (
            "Pure-software purge-sequence ordering model only; not RTL, not an "
            "SVA proof, not silicon, and not side-channel residue evidence."
        ),
        "purge_steps": list(PURGE_STEPS),
        "blocked_until_real_evidence": BLOCKED_UNTIL_REAL_EVIDENCE,
        "checks": checks,
        "findings": structured_findings(BLOCKED_UNTIL_REAL_EVIDENCE, checks),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([c for c in checks if c["status"] == "pass"]),
            "release_claim_allowed": False,
        },
    }


def validate_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("status") != "tee_purge_sequence_scope_release_blocked":
        errors.append("status must remain tee_purge_sequence_scope_release_blocked")
    summary = report.get("summary")
    if not isinstance(summary, dict) or summary.get("release_claim_allowed") is not False:
        errors.append("release_claim_allowed must stay false")
    blocked = report.get("blocked_until_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 4:
        errors.append("scope must enumerate blocked real-evidence items with proving commands")
    else:
        for item in blocked:
            if not isinstance(item, dict) or "proving_command" not in item:
                errors.append("each blocked item must name a proving_command")
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
    else:
        for check in checks:
            if isinstance(check, dict) and check.get("status") != "pass":
                errors.append(f"{check.get('id')}: model vectors must pass")
    findings = report.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured purge-sequence blockers")
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: TEE purge-sequence scope gate (release-blocked): {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
