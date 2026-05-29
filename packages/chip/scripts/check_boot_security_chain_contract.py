#!/usr/bin/env python3
"""Static boot ROM and secure boot-chain contract gate.

This check covers reset, boot ROM, and secure-boot surfaces that can otherwise
fall between the boot-artifact gates and the phone security lifecycle scope.
It blocks when the current tree still has an identity-only ROM, a reset stub
without authenticated handoff evidence, or accept-all secure-boot firmware.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PLATFORM_CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
BOOTROM_RTL = ROOT / "rtl/bootrom/e1_bootrom.sv"
RESET_ROM = ROOT / "fw/boot-rom/reset.S"
BOOTROM_CHECKER = ROOT / "fw/boot-rom/check_boot_rom.py"
BOOTROM_RELEASE_EVIDENCE = ROOT / "docs/boot-rom/release-evidence.md"
BOOTROM_SIM_REPORT = ROOT / "build/reports/gate-bootrom-sim-transcript-check.json"
BOOTROM_SIM_TRANSCRIPT = ROOT / "docs/boot-rom/transcripts/e1_secure_bootrom_qemu_rv64.txt"
BOOTROM_POSITIVE_HANDOFF_REPORT = (
    ROOT / "build/reports/gate-bootrom-positive-handoff-check.json"
)
BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT = (
    ROOT / "docs/boot-rom/transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt"
)
PMC_SECURE_BOOT = ROOT / "fw/pmc/src/secure_boot.c"
PMC_README = ROOT / "fw/pmc/README.md"
SECURE_BOOT_LIFECYCLE = ROOT / "docs/security/secure-boot-lifecycle-evidence.md"
BOOT_IMAGE_FORMAT = ROOT / "docs/security/boot-image-format.md"
AVB_OTA = ROOT / "docs/security/avb-a-b-ota.md"
KEY_CEREMONY = ROOT / "docs/security/key-ceremony.md"
REPORT = ROOT / "build/reports/boot_security_chain_contract.json"

SCHEMA = "eliza.boot_security_chain_contract.v1"
CLAIM_BOUNDARY = "static_boot_security_chain_contract_only_not_boot_or_secure_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "boot_claim_allowed": False,
    "secure_boot_claim_allowed": False,
    "provisioned_root_claim_allowed": False,
    "signed_image_handoff_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "silicon_secure_boot_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
PLACEHOLDER_TOKENS = ("placeholder", "pre-silicon specification", "not implemented")
REQUIRED_BOOTROM_SIM_MARKERS = {
    "reset_vector_fetch",
    "mtvec_setup",
    "verifier_call",
    "fail_closed_trap",
    "verifier_entrypoint_executed",
}
REQUIRED_POSITIVE_HANDOFF_MARKERS = {
    "reset_vector_fetch",
    "verifier_entrypoint_executed",
    "authenticated_image_verified",
    "handoff_target_loaded_from_manifest",
    "opensbi_entry_reached",
}
BOOTROM_SIM_FALSE_CLAIM_FLAGS = (
    "phone_claim_allowed",
    "release_claim_allowed",
    "provisioned_root_claim_allowed",
    "signed_image_handoff_claim_allowed",
    "linux_boot_claim_allowed",
    "android_boot_claim_allowed",
    "silicon_secure_boot_claim_allowed",
)


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str
    blocker_dependency: str = "repo_artifact_generation"
    next_command: str = ""


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
    blocker_dependency: str = "repo_artifact_generation",
    next_command: str = "",
) -> None:
    if condition:
        findings.append(
            Finding(
                code,
                "blocker",
                message,
                evidence,
                next_step,
                blocker_dependency,
                next_command,
            )
        )


def finding_dependency_and_command(code: str) -> tuple[str, str]:
    if code.startswith("bootrom_positive_handoff"):
        return (
            "repo_artifact_generation",
            "scripts/capture_bootrom_positive_handoff.sh preflight && "
            "scripts/capture_bootrom_positive_handoff.sh run && "
            "python3 scripts/check_boot_security_chain_contract.py",
        )
    if code.startswith("bootrom_sim_transcript"):
        return (
            "repo_artifact_generation",
            "python3 scripts/check_bootrom_sim_transcript.py && "
            "python3 scripts/check_boot_security_chain_contract.py",
        )
    if code.startswith("bootrom_") or code.startswith("reset_rom_") or code.startswith("rtl_"):
        return (
            "repo_artifact_generation",
            "python3 fw/boot-rom/check_boot_rom.py && "
            "python3 scripts/check_bootrom_sim_transcript.py && "
            "python3 scripts/check_boot_security_chain_contract.py",
        )
    if code.startswith("platform_contract"):
        return (
            "repo_artifact_generation",
            "python3 scripts/check_platform_contract.py && "
            "python3 scripts/check_boot_security_chain_contract.py",
        )
    if code.startswith("pmc_secure_boot") or code.startswith("security_boot_docs"):
        return (
            "actionable_external_dependency",
            "collect key ceremony, provisioning, verifier implementation, and negative-test evidence; "
            "then rerun python3 scripts/check_boot_security_chain_contract.py",
        )
    return (
        "repo_artifact_generation",
        "python3 scripts/check_boot_security_chain_contract.py",
    )


def load_contract(findings: list[Finding]) -> dict[str, Any]:
    if not PLATFORM_CONTRACT.is_file():
        findings.append(
            Finding(
                "missing_input",
                "blocker",
                "platform contract is missing",
                rel(PLATFORM_CONTRACT),
                "Restore the platform contract before claiming reset or boot handoff readiness.",
            )
        )
        return {}
    try:
        data = json.loads(read_text(PLATFORM_CONTRACT))
    except json.JSONDecodeError as exc:
        findings.append(
            Finding(
                "invalid_platform_contract",
                "blocker",
                "platform contract JSON is invalid",
                f"{rel(PLATFORM_CONTRACT)}: {exc}",
                "Fix the platform contract JSON so boot ROM and AP handoff fields can be audited.",
            )
        )
        return {}
    return data if isinstance(data, dict) else {}


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(read_text(path))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def required_inputs(findings: list[Finding]) -> None:
    for path in (
        BOOTROM_RTL,
        RESET_ROM,
        BOOTROM_CHECKER,
        BOOTROM_RELEASE_EVIDENCE,
        PMC_SECURE_BOOT,
        PMC_README,
        SECURE_BOOT_LIFECYCLE,
        BOOT_IMAGE_FORMAT,
        AVB_OTA,
        KEY_CEREMONY,
    ):
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required boot security-chain input is missing",
            rel(path),
            "Restore boot ROM, secure-boot firmware, and security evidence files before claiming boot-chain readiness.",
        )


def contract_boot_words(contract: Mapping[str, Any]) -> list[dict[str, Any]]:
    e1_chip = contract.get("e1_chip")
    if not isinstance(e1_chip, Mapping):
        return []
    boot_rom = e1_chip.get("boot_rom")
    if not isinstance(boot_rom, Mapping):
        return []
    words = boot_rom.get("words")
    return [word for word in words if isinstance(word, dict)] if isinstance(words, list) else []


def cpu_variant(contract: Mapping[str, Any]) -> Mapping[str, Any] | None:
    variant = contract.get("e1_chip_cpu_variant")
    return variant if isinstance(variant, Mapping) else None


def executable_bootrom_is_wired() -> bool:
    if not BOOTROM_RTL.is_file():
        return False
    text = read_text(BOOTROM_RTL)
    return "$readmemh" in text and "e1_secure_boot_rom.hex" in text


def check_platform_contract(findings: list[Finding], contract: Mapping[str, Any]) -> None:
    e1_chip = contract.get("e1_chip")
    if not isinstance(e1_chip, Mapping):
        findings.append(
            Finding(
                "platform_contract_missing_e1_chip",
                "blocker",
                "platform contract has no e1_chip boot target",
                rel(PLATFORM_CONTRACT),
                "Declare the selected CPU-capable chip/AP boot target in the platform contract.",
            )
        )
        return

    variant = cpu_variant(contract)
    add_if(
        findings,
        not (isinstance(variant, Mapping) and variant.get("has_cpu") is True),
        "platform_contract_has_no_cpu_boot_target",
        "platform contract has no selected CPU-capable AP boot target",
        (
            f"{rel(PLATFORM_CONTRACT)} e1_chip.has_cpu={e1_chip.get('has_cpu')!r} "
            f"e1_chip_cpu_variant.has_cpu="
            f"{variant.get('has_cpu') if isinstance(variant, Mapping) else None!r}"
        ),
        "Promote a selected CPU-capable AP target into the contract before claiming Linux/AOSP boot on chip.",
    )

    placeholder_words = [
        word.get("name")
        for word in contract_boot_words(contract)
        if "placeholder" in str(word.get("name", "")).lower()
    ]
    boot = variant.get("boot") if isinstance(variant, Mapping) else {}
    reset_vector = boot.get("reset_vector") if isinstance(boot, Mapping) else None
    placeholder_is_variant_reset = any(
        str(word.get("value", "")).lower() == str(reset_vector).lower()
        for word in contract_boot_words(contract)
        if "placeholder" in str(word.get("name", "")).lower()
    )
    add_if(
        findings,
        bool(placeholder_words)
        and not (placeholder_is_variant_reset and executable_bootrom_is_wired()),
        "platform_contract_boot_vector_placeholder",
        "platform contract boot ROM still exposes a placeholder boot vector without executable ROM wiring",
        (
            f"words={placeholder_words} reset_vector={reset_vector!r} "
            f"executable_bootrom_wired={executable_bootrom_is_wired()} "
            f"path={rel(PLATFORM_CONTRACT)}"
        ),
        "Replace placeholder boot words with the selected reset ROM handoff contract and simulator evidence.",
    )


def check_rtl_bootrom(findings: list[Finding]) -> None:
    if not BOOTROM_RTL.is_file():
        return
    text = read_text(BOOTROM_RTL)
    identity_words = all(token in text for token in ("4F50_534F", "4348_4950", "0000_1000"))
    loads_generated_rom = "$readmemh" in text or "e1_reset_rom.hex" in text
    add_if(
        findings,
        identity_words and not loads_generated_rom,
        "rtl_bootrom_identity_only_not_executable_reset_rom",
        "RTL boot ROM exposes identity/version words instead of the generated executable reset ROM",
        rel(BOOTROM_RTL),
        "Wire the executable reset ROM hex into the selected AP/SoC path and prove the reset vector executes it.",
    )


def check_reset_rom(findings: list[Finding]) -> None:
    if not RESET_ROM.is_file():
        return
    text = read_text(RESET_ROM)
    lower = text.lower()
    non_claims = [
        token
        for token in (
            "does not authenticate",
            "initialize dram",
            "provide sbi",
            "prove an opensbi/linux handoff",
        )
        if token in lower
    ]
    fixed_handoff = "0x0000000080000000" in text
    add_if(
        findings,
        bool(non_claims) or fixed_handoff,
        "reset_rom_handoff_not_authenticated_or_proven",
        "reset ROM is a fixed-address handoff stub without authentication, DRAM init, SBI, or boot transcript proof",
        f"non_claims={non_claims} fixed_handoff={fixed_handoff} path={rel(RESET_ROM)}",
        "Add authenticated image parsing or explicitly scoped development handoff, then capture reset-to-OpenSBI/Linux evidence from the chip/AP emulator.",
    )


def check_bootrom_workflow(findings: list[Finding]) -> None:
    checker = read_text(BOOTROM_CHECKER) if BOOTROM_CHECKER.is_file() else ""
    release_doc = read_text(BOOTROM_RELEASE_EVIDENCE) if BOOTROM_RELEASE_EVIDENCE.is_file() else ""
    add_if(
        findings,
        "return 0" in checker and "needs a local RISC-V toolchain" in checker,
        "bootrom_checker_masks_toolchain_blocked_as_success",
        "boot ROM checker can exit successfully when artifact build is blocked by missing RISC-V toolchain",
        rel(BOOTROM_CHECKER),
        "Report missing boot ROM toolchain/artifacts as BLOCKED in aggregate boot-readiness checks.",
    )
    add_if(
        findings,
        re.search(r"does\s+not\s+claim", release_doc.lower()) is not None
        and ("simulator" in release_doc.lower() or "hardware transcript" in release_doc.lower()),
        "bootrom_release_evidence_not_wired_or_exercised",
        "boot ROM release evidence is explicitly artifact-only and lacks simulator reset/handoff proof",
        rel(BOOTROM_RELEASE_EVIDENCE),
        "Capture reset-vector, trap-loop, and next-stage handoff transcripts from the selected AP/chip emulator.",
    )
    add_if(
        findings,
        "scripts/check_bootrom_sim_transcript.py" not in release_doc
        or (
            rel(BOOTROM_SIM_TRANSCRIPT) not in release_doc
            and "transcripts/e1_secure_bootrom_qemu_rv64.txt" not in release_doc
        ),
        "bootrom_release_evidence_missing_transcript_gate",
        "boot ROM release evidence does not cite the checked simulator transcript gate and artifact",
        rel(BOOTROM_RELEASE_EVIDENCE),
        "Document the transcript gate, transcript artifact, and claim boundary used for executable ROM reset evidence.",
    )

    report = load_json(BOOTROM_SIM_REPORT)
    if report is None:
        findings.append(
            Finding(
                "bootrom_sim_transcript_report_missing",
                "blocker",
                "boot ROM simulator transcript report is missing",
                rel(BOOTROM_SIM_REPORT),
                "Run scripts/check_bootrom_sim_transcript.py and keep the passing report with boot-readiness evidence.",
            )
        )
        return
    if not report:
        findings.append(
            Finding(
                "bootrom_sim_transcript_report_invalid",
                "blocker",
                "boot ROM simulator transcript report is invalid JSON or has the wrong shape",
                rel(BOOTROM_SIM_REPORT),
                "Regenerate the transcript report with scripts/check_bootrom_sim_transcript.py.",
            )
        )
        return

    status = str(report.get("status", "")).lower()
    add_if(
        findings,
        status != "pass",
        "bootrom_sim_transcript_not_passing",
        "boot ROM simulator transcript gate is not passing",
        f"status={report.get('status')!r} blocker={report.get('blocker_reason')!r} path={rel(BOOTROM_SIM_REPORT)}",
        "Fix or regenerate the executable ROM transcript before claiming reset-vector execution evidence.",
    )
    check_rows = report.get("checks")
    check_rows = check_rows if isinstance(check_rows, list) else []
    passing_markers = {
        str(row.get("id"))
        for row in check_rows
        if isinstance(row, Mapping) and str(row.get("status", "")).lower() == "pass"
    }
    missing_markers = sorted(REQUIRED_BOOTROM_SIM_MARKERS - passing_markers)
    add_if(
        findings,
        bool(missing_markers),
        "bootrom_sim_transcript_missing_required_markers",
        "boot ROM simulator transcript report lacks required reset, verifier, or fail-closed markers",
        f"missing={missing_markers} path={rel(BOOTROM_SIM_REPORT)}",
        "Regenerate the transcript and preserve reset-vector, mtvec, verifier-call, verifier-entrypoint, and fail-closed trap checks.",
    )

    leaking_flags = [flag for flag in BOOTROM_SIM_FALSE_CLAIM_FLAGS if report.get(flag) is not False]
    add_if(
        findings,
        bool(leaking_flags),
        "bootrom_sim_transcript_report_allows_release_claims",
        "boot ROM simulator transcript report does not explicitly deny release, phone, handoff, boot, or silicon claims",
        f"leaking_flags={leaking_flags} path={rel(BOOTROM_SIM_REPORT)}",
        "Regenerate the report with scripts/check_bootrom_sim_transcript.py so fail-closed simulator evidence cannot be promoted to handoff, OS boot, release, or silicon claims.",
    )


def check_positive_handoff(findings: list[Finding]) -> None:
    """Require the distinct positive authenticated handoff transcript.

    The fail-closed simulator transcript proves unauthenticated images do not
    boot. It cannot prove the other half of the boot contract: a provisioned
    test root plus a signed first-stage image authenticates and transfers
    control to OpenSBI. Keep that evidence separate so negative evidence cannot
    accidentally satisfy firmware/OS readiness.
    """

    report = load_json(BOOTROM_POSITIVE_HANDOFF_REPORT)
    if report is None:
        findings.append(
            Finding(
                "bootrom_positive_handoff_report_missing",
                "blocker",
                "positive authenticated boot ROM handoff report is missing",
                rel(BOOTROM_POSITIVE_HANDOFF_REPORT),
                "Capture a provisioned-root, signed-image transcript that reaches OpenSBI, then run scripts/check_bootrom_positive_handoff.py.",
            )
        )
        return
    if not report:
        findings.append(
            Finding(
                "bootrom_positive_handoff_report_invalid",
                "blocker",
                "positive authenticated boot ROM handoff report is invalid JSON or has the wrong shape",
                rel(BOOTROM_POSITIVE_HANDOFF_REPORT),
                "Regenerate the positive handoff report from a checked authenticated OpenSBI handoff transcript.",
            )
        )
        return

    status = str(report.get("status", "")).lower()
    add_if(
        findings,
        status != "pass",
        "bootrom_positive_handoff_not_passing",
        "positive authenticated boot ROM handoff gate is not passing",
        f"status={report.get('status')!r} blocker={report.get('blocker_reason')!r} path={rel(BOOTROM_POSITIVE_HANDOFF_REPORT)}",
        "Fix or regenerate the signed-image transcript, then rerun scripts/check_bootrom_positive_handoff.py before claiming authenticated firmware handoff evidence.",
    )

    claim_flags = (
        "phone_claim_allowed",
        "release_claim_allowed",
        "linux_boot_claim_allowed",
        "android_boot_claim_allowed",
        "silicon_secure_boot_claim_allowed",
    )
    leaking_flags = [flag for flag in claim_flags if report.get(flag) is not False]
    add_if(
        findings,
        bool(leaking_flags),
        "bootrom_positive_handoff_report_allows_release_claims",
        "positive handoff report does not explicitly deny release, phone, Linux/Android boot, or silicon secure-boot claims",
        f"leaking_flags={leaking_flags} path={rel(BOOTROM_POSITIVE_HANDOFF_REPORT)}",
        "Regenerate the report with scripts/check_bootrom_positive_handoff.py so simulator handoff evidence cannot be promoted to release or silicon claims.",
    )

    evidence_paths = report.get("evidence_paths")
    evidence_paths = evidence_paths if isinstance(evidence_paths, list) else []
    add_if(
        findings,
        rel(BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT) not in {str(path) for path in evidence_paths},
        "bootrom_positive_handoff_transcript_not_cited",
        "positive handoff report does not cite the checked transcript artifact",
        f"evidence_paths={evidence_paths!r} expected={rel(BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT)}",
        "Regenerate the report with scripts/check_bootrom_positive_handoff.py so evidence_paths cites the repo-relative positive handoff transcript.",
    )

    check_rows = report.get("checks")
    check_rows = check_rows if isinstance(check_rows, list) else []
    passing_markers = {
        str(row.get("id"))
        for row in check_rows
        if isinstance(row, Mapping) and str(row.get("status", "")).lower() == "pass"
    }
    missing_markers = sorted(REQUIRED_POSITIVE_HANDOFF_MARKERS - passing_markers)
    add_if(
        findings,
        bool(missing_markers),
        "bootrom_positive_handoff_missing_required_markers",
        "positive handoff report lacks required authenticated handoff markers",
        f"missing={missing_markers} path={rel(BOOTROM_POSITIVE_HANDOFF_REPORT)}",
        "Regenerate the positive transcript and rerun scripts/check_bootrom_positive_handoff.py, preserving reset, verifier, authenticated-image, manifest-target, and OpenSBI-entry checks.",
    )


def check_secure_boot(findings: list[Finding]) -> None:
    secure_boot = read_text(PMC_SECURE_BOOT) if PMC_SECURE_BOOT.is_file() else ""
    pmc_readme = read_text(PMC_README) if PMC_README.is_file() else ""
    placeholder_accepts_all = bool(
        "placeholder" in secure_boot.lower()
        or re.search(r"pmc_secure_boot_verify[^{]*\{[^}]*return\s+0\s*;", secure_boot, re.S)
    )
    add_if(
        findings,
        placeholder_accepts_all,
        "pmc_secure_boot_placeholder_accepts_all",
        "PMC secure-boot verifier is a placeholder that returns success without authenticating the image",
        rel(PMC_SECURE_BOOT),
        "Implement fail-closed signature/hash/rollback checks or keep secure boot out of readiness claims.",
    )
    add_if(
        findings,
        "secure-boot key provisioning not closed" in pmc_readme.lower()
        or "hmac/ecdsa placeholder" in pmc_readme.lower(),
        "pmc_secure_boot_release_blockers_open",
        "PMC firmware documentation still lists secure-boot key provisioning and verifier implementation as release blockers",
        rel(PMC_README),
        "Close key provisioning, fuse/OTP, and verifier implementation before claiming secure or verified boot.",
    )


def check_security_docs(findings: list[Finding]) -> None:
    docs = (SECURE_BOOT_LIFECYCLE, BOOT_IMAGE_FORMAT, AVB_OTA, KEY_CEREMONY)
    placeholder_docs: list[str] = []
    for path in docs:
        if not path.is_file():
            continue
        lower = read_text(path).lower()
        if any(token in lower for token in PLACEHOLDER_TOKENS) or "status: blocked" in lower:
            placeholder_docs.append(rel(path))
    add_if(
        findings,
        bool(placeholder_docs),
        "security_boot_docs_are_pre_silicon_or_blocked",
        "one or more boot-security lifecycle documents are still blocked/specification-only",
        f"paths={placeholder_docs}",
        "Promote the security chain only after implementation, negative tests, provisioning records, and boot transcripts exist.",
    )


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    del args
    findings: list[Finding] = []
    contract = load_contract(findings)
    required_inputs(findings)
    if contract:
        check_platform_contract(findings, contract)
    check_rtl_bootrom(findings)
    check_reset_rom(findings)
    check_bootrom_workflow(findings)
    check_positive_handoff(findings)
    check_secure_boot(findings)
    check_security_docs(findings)
    evidence = {
        "platform_contract": rel(PLATFORM_CONTRACT),
        "bootrom_rtl": rel(BOOTROM_RTL),
        "reset_rom": rel(RESET_ROM),
        "bootrom_sim_report": rel(BOOTROM_SIM_REPORT),
        "bootrom_sim_transcript": rel(BOOTROM_SIM_TRANSCRIPT),
        "bootrom_positive_handoff_report": rel(BOOTROM_POSITIVE_HANDOFF_REPORT),
        "bootrom_positive_handoff_transcript": rel(BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT),
        "pmc_secure_boot": rel(PMC_SECURE_BOOT),
        "security_docs": [
            rel(path) for path in (SECURE_BOOT_LIFECYCLE, BOOT_IMAGE_FORMAT, AVB_OTA, KEY_CEREMONY)
        ],
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: Mapping[str, object]) -> dict[str, Any]:
    normalized_findings: list[Finding] = []
    for finding in findings:
        if finding.next_command:
            normalized_findings.append(finding)
            continue
        dependency, command = finding_dependency_and_command(finding.code)
        normalized_findings.append(
            Finding(
                finding.code,
                finding.severity,
                finding.message,
                finding.evidence,
                finding.next_step,
                dependency,
                command,
            )
        )
    findings = normalized_findings
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    dependency_counts = {
        "repo_artifact_generation": sum(
            1 for finding in blockers if finding.blocker_dependency == "repo_artifact_generation"
        ),
        "live_device_validation": sum(
            1 for finding in blockers if finding.blocker_dependency == "live_device_validation"
        ),
        "actionable_external_dependency": sum(
            1
            for finding in blockers
            if finding.blocker_dependency == "actionable_external_dependency"
        ),
    }
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": {
            "blockers": len(blockers),
            "findings": len(findings),
            "blocker_dependency_counts": dependency_counts,
            "next_command_count": len(
                {finding.next_command for finding in blockers if finding.next_command}
            ),
        },
        "blocker_dependency_counts": dependency_counts,
        "next_command_plan": [
            {
                "code": finding.code,
                "blocker_dependency": finding.blocker_dependency,
                "command": finding.next_command,
                "next_step": finding.next_step,
                "claim_boundary": "operator_or_repo_commands_only_not_boot_security_evidence",
            }
            for finding in blockers
            if finding.next_command
        ],
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: Mapping[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: Mapping[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} boot.security_chain_contract")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"report path (default: {REPORT.relative_to(ROOT)})",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = run_check(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        print_summary(report)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
