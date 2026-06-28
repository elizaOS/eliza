#!/usr/bin/env python3
"""Validate the Eliza RISC-V confidential-domain contract."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT = REPO_ROOT / "packages/chip/docs/spec-db/tee-confidential-domain-contract.json"


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def require_items(
    actual: object,
    required: set[str],
    field: str,
    errors: list[str],
) -> None:
    require(isinstance(actual, list), f"{field} must be a list", errors)
    if not isinstance(actual, list):
        return
    missing = sorted(required.difference(str(item) for item in actual))
    require(not missing, f"{field} missing required items: {', '.join(missing)}", errors)


def validate(contract: dict[str, object]) -> list[str]:
    errors: list[str] = []
    require(contract.get("schemaVersion") == 1, "schemaVersion must be 1", errors)
    require(
        contract.get("profile") == "eliza-riscv-confidential-domain-v0",
        "profile must be eliza-riscv-confidential-domain-v0",
        errors,
    )

    root = contract.get("rootOfTrust")
    require(isinstance(root, dict), "rootOfTrust must be an object", errors)
    if isinstance(root, dict):
        require_items(
            root.get("requiredBlocks"),
            {
                "rom_ctrl",
                "lc_ctrl",
                "otp_ctrl",
                "keymgr",
                "entropy_src",
                "csrng",
                "edn",
                "alert_handler",
            },
            "rootOfTrust.requiredBlocks",
            errors,
        )
        require(root.get("diceRequired") is True, "DICE must be required", errors)
        require(
            root.get("debugUnlockDestroysProductionSecrets") is True,
            "debug unlock must destroy production secrets",
            errors,
        )

    hart = contract.get("hartIsolation")
    require(isinstance(hart, dict), "hartIsolation must be an object", errors)
    if isinstance(hart, dict):
        require_items(
            hart.get("requiredExtensions"),
            {"Smepmp"},
            "hartIsolation.requiredExtensions",
            errors,
        )
        require(
            hart.get("smtAllowedForConfidentialDomains") is False,
            "SMT must not be allowed for confidential domains",
            errors,
        )

    memory = contract.get("memory")
    require(isinstance(memory, dict), "memory must be an object", errors)
    if isinstance(memory, dict):
        require_items(
            memory.get("pageStates"),
            {
                "free",
                "private",
                "shared",
                "measured",
                "device-assigned",
                "scrub-pending",
            },
            "memory.pageStates",
            errors,
        )
        require(
            memory.get("externalMemoryEncryptionRequiredForWholeOsTeeClaim") is True,
            "external memory encryption must gate whole-OS TEE claims",
            errors,
        )
        require(
            memory.get("integrityRequiredForWholeOsTeeClaim") is True,
            "memory integrity must gate whole-OS TEE claims",
            errors,
        )

    io = contract.get("io")
    require(isinstance(io, dict), "io must be an object", errors)
    if isinstance(io, dict):
        require(io.get("denyByDefault") is True, "IO must deny by default", errors)
        require_items(
            io.get("requiredDmaSourceIds"),
            {
                "usb",
                "emmc-ufs",
                "display",
                "isp",
                "npu-dma",
                "network",
                "debug-transport",
            },
            "io.requiredDmaSourceIds",
            errors,
        )

    attestation = contract.get("attestation")
    require(isinstance(attestation, dict), "attestation must be an object", errors)
    if isinstance(attestation, dict):
        require_items(
            attestation.get("requiredMeasurements"),
            {
                "rom",
                "lifecycle",
                "bl1",
                "bl2",
                "monitor",
                "os",
                "deviceTree",
                "agent",
                "policy",
            },
            "attestation.requiredMeasurements",
            errors,
        )
        require(
            attestation.get("normalizedEvidenceType") == "TeeEvidence",
            "attestation.normalizedEvidenceType must be TeeEvidence",
            errors,
        )

    side_channels = contract.get("sideChannels")
    require(isinstance(side_channels, dict), "sideChannels must be an object", errors)
    if isinstance(side_channels, dict):
        require_items(
            side_channels.get("domainSwitchStateHandling"),
            {"cache", "tlb", "bpu", "prefetcher"},
            "sideChannels.domainSwitchStateHandling",
            errors,
        )
        require(
            side_channels.get("pmuDisabledOrVirtualizedInConfidentialMode") is True,
            "PMU must be disabled or virtualized in confidential mode",
            errors,
        )
        require(
            side_channels.get("constantTimeCryptoRequired") is True,
            "constant-time crypto must be required",
            errors,
        )

    require_items(
        contract.get("deferredBareMetalGates"),
        {
            "confidential-linux-boot",
            "dma-isolation-test",
            "memory-encryption-integrity-test",
            "npu-queue-isolation-test",
            "physical-tamper-validation",
        },
        "deferredBareMetalGates",
        errors,
    )

    return errors


def main(argv: list[str]) -> int:
    contract_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_CONTRACT
    contract = json.loads(contract_path.read_text())
    errors = validate(contract)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"TEE confidential-domain contract valid: {contract_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
