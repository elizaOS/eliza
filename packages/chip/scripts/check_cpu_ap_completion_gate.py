#!/usr/bin/env python3
"""Gate real RV64GC/Linux AP completion claims on generated artifacts and boot evidence."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from typing import Any

from cpu_ap_evidence_lib import (
    GENERATED_MANIFEST,
    PLATFORM_CONTRACT,
    ROOT,
    SELECTED_MANIFEST,
    load_evidence_manifest,
    load_json,
    rel,
    transcript_specs,
)

REPORT = ROOT / "build/reports/cpu_ap_completion_gate.json"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def completion_claimed() -> bool:
    selected = load_json(SELECTED_MANIFEST)
    platform = load_json(PLATFORM_CONTRACT)
    claim_policy = selected.get("claim_policy", {})
    return any(
        (
            selected.get("status") in {"generated", "complete", "linux_complete"},
            claim_policy.get("linux_capable_cpu_claim") is True,
            claim_policy.get("platform_contract_has_cpu_may_flip_to_true") is True,
            platform.get("e1_chip", {}).get("has_cpu") is True,
        )
    )


def run_generated_gate() -> int:
    env = os.environ.copy()
    env["REQUIRE_CHIPYARD_GENERATED"] = "1"
    generated = subprocess.run(
        [sys.executable, "scripts/check_chipyard_generator_manifest.py", "--require-generated"],
        cwd=ROOT,
        env=env,
        check=False,
    )
    if generated.returncode != 0:
        return generated.returncode
    return subprocess.run(
        [sys.executable, "scripts/check_cpu_ap_evidence.py", "--require-evidence"],
        cwd=ROOT,
        check=False,
    ).returncode


def write_report(report: dict[str, Any]) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def missing_cpu_ap_evidence() -> tuple[list[str], list[str], list[str]]:
    errors: list[str] = []
    evidence_manifest = load_evidence_manifest(errors)
    missing_logs: list[str] = []
    next_capture: list[str] = []
    if errors:
        return errors, missing_logs, next_capture
    for spec in transcript_specs(evidence_manifest).values():
        if not isinstance(spec.get("path"), str):
            continue
        if (ROOT / str(spec["path"])).is_file():
            continue
        missing_logs.append(str(spec["path"]))
        if isinstance(spec.get("capture_command"), str):
            next_capture.append(str(spec["capture_command"]))
    return errors, missing_logs, next_capture


def blocked_report(
    *,
    generated_detail: str,
    manifest_errors: list[str],
    missing_logs: list[str],
    next_capture: list[str],
) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    for error in manifest_errors:
        findings.append(
            {
                "code": "cpu_ap_evidence_manifest_invalid",
                "severity": "blocker",
                "message": error,
                "blocker_dependency": "repo_artifact_generation",
                "next_step": "Repair the CPU/AP evidence manifest contract before collecting AP evidence.",
                "next_command": "python3 scripts/check_cpu_ap_evidence.py --require-evidence",
            }
        )
    for log in missing_logs:
        findings.append(
            {
                "code": "cpu_ap_required_transcript_missing",
                "severity": "blocker",
                "message": f"required generated CPU/AP evidence transcript is missing: {log}",
                "blocker_dependency": "live_device_validation",
                "next_step": "Capture the generated Eliza AP transcript from the current Chipyard/Rocket run.",
                "next_command": "python3 scripts/capture_cpu_ap_evidence.py template linux-boot",
            }
        )
    if not findings:
        findings.append(
            {
                "code": "cpu_ap_completion_claim_not_enabled",
                "severity": "blocker",
                "message": (
                    "generated CPU/AP transcripts are present, but the selected manifest and "
                    "platform contract still keep the Linux-capable CPU/AP completion claim disabled"
                ),
                "evidence": generated_detail,
                "blocker_dependency": "live_device_validation",
                "next_step": (
                    "Keep the completion gate blocked until the generated Rocket/RV64GC AP "
                    "claim is intentionally enabled after reviewing the generated artifacts, "
                    "platform contract, and archived transcripts."
                ),
                "next_command": (
                    "python3 scripts/check_cpu_ap_completion_gate.py --require-complete"
                ),
            }
        )
    return {
        "schema": "eliza.cpu_ap_completion_gate.v1",
        "status": "blocked",
        "generated_utc": utc_now(),
        "claim_boundary": (
            "qemu_virt_linux_boot_is_reference_only_not_generated_eliza_cpu_ap_completion"
        ),
        "phone_2028_ap_claim_allowed": False,
        "release_claim_allowed": False,
        "linux_capable_cpu_claim_allowed": False,
        "privileged_boot_claim_allowed": False,
        "generated_cpu_ap_completion_claim_allowed": False,
        "generated_detail": generated_detail,
        "findings": findings,
        "summary": {
            "blockers": len(findings),
            "manifest_errors": len(manifest_errors),
            "missing_required_transcripts": len(missing_logs),
            "next_capture_commands": len(next_capture),
        },
        "blocker_dependency_counts": {
            "repo_artifact_generation": len(manifest_errors),
            "live_device_validation": len(
                [
                    finding
                    for finding in findings
                    if finding.get("blocker_dependency") == "live_device_validation"
                ]
            ),
            "actionable_external_dependency": 0,
        },
        "missing_required_transcripts": missing_logs,
        "next_capture_commands": next_capture,
        "next_step": (
            "Collect generated Eliza Rocket/RV64GC AP transcripts and rerun "
            "python3 scripts/check_cpu_ap_completion_gate.py. QEMU virt Linux boot evidence "
            "does not satisfy this CPU/AP completion claim."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()

    claimed = completion_claimed()
    if claimed or args.require_complete:
        rc = run_generated_gate()
        if rc != 0:
            write_report(
                {
                    "schema": "eliza.cpu_ap_completion_gate.v1",
                    "status": "fail",
                    "generated_utc": utc_now(),
                    "claim_boundary": "claimed_generated_cpu_ap_completion_requires_artifacts_and_evidence",
                    "phone_2028_ap_claim_allowed": False,
                    "release_claim_allowed": False,
                    "linux_capable_cpu_claim_allowed": False,
                    "privileged_boot_claim_allowed": False,
                    "generated_cpu_ap_completion_claim_allowed": False,
                    "summary": {"failures": 1},
                    "next_step": "Run scripts/check_cpu_ap_evidence.py --require-evidence and repair the failing CPU/AP artifact or transcript.",
                }
            )
            print(
                "STATUS: FAIL cpu_ap.completion_gate - real RV64GC/Linux AP claim is not backed by required artifacts"
            )
            return rc
        write_report(
            {
                "schema": "eliza.cpu_ap_completion_gate.v1",
                "status": "pass",
                "generated_utc": utc_now(),
                "claim_boundary": "generated_rocket_rv64gc_ap_artifacts_and_boot_evidence_present",
                "phone_2028_ap_claim_allowed": False,
                "release_claim_allowed": False,
                "linux_capable_cpu_claim_allowed": True,
                "privileged_boot_claim_allowed": True,
                "generated_cpu_ap_completion_claim_allowed": True,
                "summary": {"blockers": 0, "failures": 0},
                "next_step": "none",
            }
        )
        print(
            "STATUS: PASS cpu_ap.completion_gate - generated Rocket RV64GC AP artifacts and boot evidence are present"
        )
        return 0

    generated_detail = (
        f"generated manifest present: {rel(GENERATED_MANIFEST)}"
        if GENERATED_MANIFEST.is_file()
        else f"missing generated manifest: {rel(GENERATED_MANIFEST)}"
    )
    manifest_errors, missing_logs, next_capture = missing_cpu_ap_evidence()
    write_report(
        blocked_report(
            generated_detail=generated_detail,
            manifest_errors=manifest_errors,
            missing_logs=missing_logs,
            next_capture=next_capture,
        )
    )
    print(
        "STATUS: BLOCKED cpu_ap.completion_gate - no real RV64GC/Linux AP completion claim; "
        f"generated Eliza CPU/AP evidence is absent or incomplete ({generated_detail})"
    )
    if manifest_errors:
        print("  CPU/AP evidence manifest problems: " + "; ".join(manifest_errors))
    if missing_logs:
        print("  missing CPU/AP evidence logs: " + ", ".join(missing_logs))
    if next_capture:
        print("  capture commands:")
        for command in next_capture:
            print(f"    {command}")
    print(
        "  next: python3 scripts/check_chipyard_import_preflight.py --require-checkout && "
        "make chipyard-generated-check cpu-ap-evidence-check cpu-ap-completion-gate"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
