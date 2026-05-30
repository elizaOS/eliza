#!/usr/bin/env python3
"""Check the local E1 software/BSP/firmware AI policy.

Governs how an automated agent may touch the software stack (boot ROM,
OpenSBI, U-Boot, Linux BSP, device trees, firmware images) and the
QEMU/Renode/Verilator emulators. The policy is capture-only: a tool may
prepare candidate work behind quarantine roots, but it may never claim a
patch, boot success, BSP readiness, kernel performance, or a vulnerability
finding past the documented ``claim_boundary``. The gate fails closed when
the manifest is missing, schema/claim-boundary drift, any blocked action /
pre-execution field / promotion gate is absent, a referenced E1 context
input is missing, or the artifact quarantine root is not declared.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "docs/spec-db/e1-software-bsp-firmware-ai-policy.yaml"
EXPECTED_SCHEMA = "eliza.software_bsp_firmware_ai_policy.v1"
EXPECTED_CLAIM_BOUNDARY = (
    "software_bsp_firmware_policy_only_no_patch_boot_bsp_perf_or_vulnerability_claim"
)

REQUIRED_BLOCKED_ACTIONS = frozenset(
    {
        "generate_patch",
        "change_bootloader",
        "change_bsp",
        "change_kernel_config",
        "change_linux_driver",
        "change_device_tree",
        "change_firmware",
        "build_external_rootfs",
        "import_external_bsp_tree",
        "download_firmware_dataset",
        "export_e1_design_to_hosted_model",
        "generate_test_binary",
        "run_qemu",
        "run_renode",
        "run_verilator",
        "run_firmware_emulator",
        "run_fuzzer",
        "claim_boot_success",
        "claim_bsp_readiness",
        "claim_kernel_performance",
        "claim_vulnerability",
        "claim_release_or_tapeout_readiness",
    }
)
REQUIRED_EXECUTION_FIELDS = frozenset(
    {
        "exact_tool_revision",
        "command_log",
        "input_source_hashes",
        "output_hashes",
        "dependency_manifest",
        "isa_profile_manifest",
        "platform_contract_check",
        "device_tree_or_dtb_hashes",
        "firmware_image_provenance",
        "qemu_or_renode_transcript",
        "crash_or_mismatch_replay_log",
        "static_analysis_log",
        "license_review",
        "security_review_if_applicable",
        "human_bsp_reviewer",
        "reviewer_disposition",
        "generated_artifact_quarantine_path",
    }
)
REQUIRED_GATES = frozenset(
    {
        "python3 scripts/check_software_bsp_firmware_ai_policy.py",
        "python3 scripts/ai_eda/capture_software_bsp_firmware_targets.py --run-id validation",
        "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
        "make software-bsp-firmware-ai-policy-check",
        "make software-bsp-check",
        "make bootrom-check",
        "make qemu-check",
        "make renode-check",
        "make no-hardware-action-check",
    }
)
REQUIRED_QUARANTINE_ROOT = "build/ai_eda/software_bsp_firmware/"
FALSE_CLAIM_FLAGS = {
    "patch_claim_allowed": False,
    "boot_success_claim_allowed": False,
    "bsp_readiness_claim_allowed": False,
    "kernel_performance_claim_allowed": False,
    "vulnerability_claim_allowed": False,
    "release_or_tapeout_claim_allowed": False,
}


def fail(errors: list[str], message: str) -> None:
    errors.append(f"FAIL: {message}")


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(errors, f"{label} must be a mapping")
        return {}
    return value


def require_list(value: Any, label: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        fail(errors, f"{label} must be a list")
        return []
    return value


def require_set(values: Any, label: str, required: frozenset[str], errors: list[str]) -> None:
    present = set(require_list(values, label, errors))
    missing = sorted(required - present)
    if missing:
        fail(errors, f"{label} missing: {', '.join(missing)}")


def main() -> int:
    errors: list[str] = []
    if not POLICY.is_file():
        fail(errors, f"missing {POLICY.relative_to(ROOT)}")
        print("\n".join(errors))
        return 1

    policy = require_mapping(load_yaml_object(POLICY), "policy", errors)
    if policy.get("schema") != EXPECTED_SCHEMA:
        fail(errors, "unexpected schema")
    if policy.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        fail(errors, "unsafe claim boundary")
    if policy.get("status") != "DRAFT_CAPTURE_ONLY":
        fail(errors, "status must be DRAFT_CAPTURE_ONLY")
    for flag, expected in FALSE_CLAIM_FLAGS.items():
        if policy.get(flag) is not expected:
            fail(errors, f"{flag} must be false")

    require_set(policy.get("blocked_actions"), "blocked_actions", REQUIRED_BLOCKED_ACTIONS, errors)
    require_set(
        policy.get("required_before_execution"),
        "required_before_execution",
        REQUIRED_EXECUTION_FIELDS,
        errors,
    )
    require_set(policy.get("promotion_gates"), "promotion_gates", REQUIRED_GATES, errors)

    for context_input in require_list(policy.get("e1_context_inputs"), "e1_context_inputs", errors):
        if not isinstance(context_input, str):
            fail(errors, "e1_context_inputs[] must be a path string")
            continue
        if not (ROOT / context_input).is_file():
            fail(errors, f"missing E1 context input: {context_input}")

    quarantine_roots = require_list(
        policy.get("artifact_quarantine_roots"), "artifact_quarantine_roots", errors
    )
    if REQUIRED_QUARANTINE_ROOT not in quarantine_roots:
        fail(errors, f"artifact_quarantine_roots must include {REQUIRED_QUARANTINE_ROOT}")

    if errors:
        print("\n".join(errors))
        return 1
    print(
        "STATUS: PASS software_bsp_firmware_ai_policy "
        "docs/spec-db/e1-software-bsp-firmware-ai-policy.yaml"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
