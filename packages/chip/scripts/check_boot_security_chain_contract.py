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
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PLATFORM_CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
BOOTROM_RTL = ROOT / "rtl/bootrom/e1_bootrom.sv"
RESET_ROM = ROOT / "fw/boot-rom/reset.S"
BOOTROM_CHECKER = ROOT / "fw/boot-rom/check_boot_rom.py"
BOOTROM_RELEASE_EVIDENCE = ROOT / "docs/boot-rom/release-evidence.md"
PMC_SECURE_BOOT = ROOT / "fw/pmc/src/secure_boot.c"
PMC_README = ROOT / "fw/pmc/README.md"
SECURE_BOOT_LIFECYCLE = ROOT / "docs/security/secure-boot-lifecycle-evidence.md"
BOOT_IMAGE_FORMAT = ROOT / "docs/security/boot-image-format.md"
AVB_OTA = ROOT / "docs/security/avb-a-b-ota.md"
KEY_CEREMONY = ROOT / "docs/security/key-ceremony.md"
REPORT = ROOT / "build/reports/boot_security_chain_contract.json"

SCHEMA = "eliza.boot_security_chain_contract.v1"
CLAIM_BOUNDARY = "static_boot_security_chain_contract_only_not_boot_or_secure_boot_evidence"
PLACEHOLDER_TOKENS = ("placeholder", "pre-silicon specification", "not implemented")


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


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
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step))


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
        "secure boot, AVB, rollback, and key ceremony docs are still blocked/specification-only",
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
    check_secure_boot(findings)
    check_security_docs(findings)
    evidence = {
        "platform_contract": rel(PLATFORM_CONTRACT),
        "bootrom_rtl": rel(BOOTROM_RTL),
        "reset_rom": rel(RESET_ROM),
        "pmc_secure_boot": rel(PMC_SECURE_BOOT),
        "security_docs": [
            rel(path) for path in (SECURE_BOOT_LIFECYCLE, BOOT_IMAGE_FORMAT, AVB_OTA, KEY_CEREMONY)
        ],
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: Mapping[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
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
