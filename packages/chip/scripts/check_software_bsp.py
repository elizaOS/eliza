#!/usr/bin/env python3
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
ARTIFACT_MANIFEST = ROOT / "docs/android/bsp-artifact-manifest.json"
LOG_EVIDENCE_MANIFEST = ROOT / "docs/android/bsp-log-evidence-manifest.json"
BOOT_TRANSCRIPT_SCHEMA = ROOT / "docs/android/boot-transcript.schema.json"
EVIDENCE_MANIFEST = ROOT / "docs/evidence/software-bsp-evidence-manifest.json"
LOCAL_EXTERNAL_PREFLIGHT_REPORT = ROOT / "docs/evidence/software-bsp-external-preflight-status.json"
REPORT = ROOT / "build/reports/software_bsp.json"
AOSP_EVIDENCE_MANIFEST = ROOT / "sw/aosp-device/evidence_manifest.json"
NNAPI_PROOF_TEMPLATE = ROOT / "docs/benchmarks/capabilities/e1_npu_nnapi.proof.template.json"
ANDROID_PROOF_TEMPLATE = (
    ROOT / "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json"
)
AOSP_REFERENCE_ONLY_BOUNDARY = "reference_only_not_e1_chip_ap_evidence"
AOSP_VIRTUAL_DEVICE_BOUNDARY = "virtual_device_smoke_only_not_boot_or_compatibility_evidence"
ANDROID_PROOF_TEMPLATE_BOUNDARY = "template_only_not_android_boot_cts_vts_or_nnapi_evidence"
AOSP_REFERENCE_ONLY_PATHS = [
    "docs/evidence/android/cuttlefish_riscv64_smoke.log",
    "docs/evidence/android/qemu_riscv64_smoke.log",
    "docs/evidence/android/renode_e1_soc_smoke.log",
]
CLAIM_BOUNDARY = "scaffold_and_evidence_inventory_only_not_linux_or_aosp_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "aosp_boot_claim_allowed": False,
    "android_runtime_claim_allowed": False,
    "launcher_runtime_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_bsp_claim_allowed": False,
    "cts_vts_claim_allowed": False,
    "gms_claim_allowed": False,
}
DEFAULT_EVIDENCE_METADATA = ["EXTERNAL_TREE=", "COMMAND=", "START_UTC=", "END_UTC=", "RESULT="]
ANDROID_COMPAT_METADATA = [
    "EXTERNAL_TREE=",
    "COMMAND=",
    "START_UTC=",
    "END_UTC=",
    "RESULT=",
    "COMPATIBILITY_CLAIM=none",
]
REQUIRED_NNAPI_TRANSCRIPTS = {
    "adb_devices",
    "nnapi_accelerator_query",
    "benchmark_model_nnapi",
    "dma_trace",
}
REQUIRED_ANDROID_PROOF_STATUSES = {
    "aidl_or_hidl_hal_declared",
    "hal_binary_in_vendorimage",
    "vintf_check",
    "selinux_policy_build",
    "selinux_neverallow",
    "vts_e1_npu",
    "cts_nnapi_smoke",
    "nnapi_accelerator_query",
    "fail_closed_absent_device",
}
REQUIRED_ANDROID_PROOF_ARTIFACTS = {
    "vts_result": "docs/evidence/android/e1-npu/vts-result.json",
    "cts_result": "docs/evidence/android/e1-npu/cts-result.json",
    "selinux_policy_build_log": "docs/evidence/android/eliza_ai_soc_sepolicy_build.log",
    "selinux_neverallow_log": "docs/evidence/android/eliza_ai_soc_selinux_neverallow.log",
    "vintf_check_log": "docs/evidence/android/eliza_ai_soc_checkvintf.log",
    "nnapi_query_log": "docs/evidence/android/e1-npu/nnapi-accelerator-query.log",
    "absent_device_probe_log": "docs/evidence/android/e1-npu/absent-device-probe.log",
}

TARGETS: dict[str, dict[str, Any]] = {
    "buildroot": {
        "readme": ROOT / "docs/sw/buildroot/README.md",
        "required": [
            "docs/android/bsp-artifact-manifest.json",
            "docs/android/bsp-log-evidence-manifest.json",
            "sw/buildroot/external.desc",
            "sw/buildroot/Config.in",
            "sw/buildroot/external.mk",
            "sw/buildroot/scripts/import-buildroot-external.sh",
            "sw/buildroot/configs/eliza_e1_defconfig",
            "sw/buildroot/board/eliza/e1/linux.fragment",
            "sw/buildroot/board/eliza/e1/rootfs_overlay/usr/bin/e1-mmio-smoke",
            "sw/buildroot/package/e1-mmio-smoke/Config.in",
            "sw/buildroot/package/e1-mmio-smoke/e1-mmio-smoke.mk",
            "sw/buildroot/package/e1-mmio-smoke/src/e1-mmio-smoke.c",
            "sw/buildroot/package/e1-npu-ml-smoke/Config.in",
            "sw/buildroot/package/e1-npu-ml-smoke/e1-npu-ml-smoke.mk",
            "sw/buildroot/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c",
        ],
        "contract_terms": [
            "BR2_EXTERNAL_ELIZA_E1_PATH",
            "E1_NPU_BASE",
            "E1_DISPLAY_BASE",
            "E1_DMA_BASE",
        ],
        "evidence": [
            "docs/evidence/buildroot/eliza_e1_defconfig.log",
            "docs/evidence/buildroot/eliza_e1_image_manifest.txt",
            "docs/evidence/buildroot/e1-mmio-smoke.log",
            "docs/evidence/buildroot/e1-npu-ml-smoke.log",
        ],
        "evidence_note": "external Buildroot image build plus e1 MMIO and e1 NPU ML smoke transcripts",
    },
    "linux": {
        "readme": ROOT / "docs/sw/linux/README.md",
        "required": [
            "docs/android/bsp-artifact-manifest.json",
            "docs/android/bsp-log-evidence-manifest.json",
            "sw/linux/drivers/e1/Kconfig",
            "sw/linux/drivers/e1/Makefile",
            "sw/linux/scripts/import-linux-bsp.sh",
            "sw/linux/dts/eliza-e1.dts",
            "sw/linux/drivers/e1/e1_platform_contract.h",
            "sw/linux/drivers/e1/e1-npu.c",
            "sw/linux/drivers/e1/e1-dma.c",
            "sw/linux/tests/e1-mmio-smoke.c",
        ],
        "contract_terms": [
            "CONFIG_ELIZA_E1_NPU",
            "CONFIG_ELIZA_E1_DMA",
            "eliza,e1-npu",
            "eliza,e1-dma",
            "eliza,e1-display",
            '#include "e1_platform_contract.h"',
        ],
        "evidence": [
            "docs/evidence/linux/eliza_e1_kernel_build.log",
            "docs/evidence/linux/eliza_e1_dtb_check.log",
            "docs/evidence/linux/e1-mmio-smoke.log",
        ],
        "evidence_note": "external Linux kernel build, DTB validation, and runtime driver smoke transcript",
    },
    "opensbi": {
        "readme": ROOT / "docs/sw/opensbi/README.md",
        "required": [
            "docs/sw/opensbi/README.md",
            "docs/sw/opensbi/capture-opensbi-evidence.sh",
            "sw/opensbi/scripts/import-opensbi-platform.sh",
            "sw/opensbi/platform/eliza/README.md",
            "sw/opensbi/platform/eliza/config.mk",
            "sw/opensbi/platform/eliza/objects.mk",
            "sw/opensbi/platform/eliza/platform.c",
        ],
        "contract_terms": [
            "sw/platform/e1_platform_contract.json",
            "OpenSBI",
            "fw_dynamic",
            "PLATFORM=eliza",
            "FW_PAYLOAD",
        ],
        "evidence": [
            "docs/evidence/linux/opensbi_eliza_build.log",
            "docs/evidence/linux/opensbi_fw_dynamic_handoff.log",
        ],
        "evidence_note": "external OpenSBI build and fw_dynamic handoff transcript",
    },
    "u-boot": {
        "readme": ROOT / "docs/sw/u-boot/README.md",
        "required": [
            "docs/sw/u-boot/README.md",
            "docs/sw/u-boot/capture-u-boot-evidence.sh",
        ],
        "contract_terms": [
            "sw/platform/e1_platform_contract.json",
            "U-Boot",
            "OpenSBI",
            "ELIZA_UBOOT_CMD",
            "ELIZA_UBOOT_BOOT_CMD",
        ],
        "evidence": [
            "docs/evidence/linux/u_boot_eliza_build.log",
            "docs/evidence/linux/u_boot_opensbi_boot_chain.log",
        ],
        "evidence_note": "external U-Boot build and OpenSBI-to-U-Boot boot-chain transcript",
    },
    "aosp": {
        "readme": ROOT / "docs/sw/aosp-device/README.md",
        "required": [
            "docs/android/bsp-artifact-manifest.json",
            "docs/android/bsp-log-evidence-manifest.json",
            "sw/aosp-device/import-aosp-device.sh",
            "sw/aosp-device/manifests/eliza-ai-soc-local.xml",
            "sw/aosp-device/device/eliza/eliza_ai_soc/AndroidProducts.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/eliza_ai_soc.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/device.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/init.eliza.rc",
            "sw/aosp-device/device/eliza/eliza_ai_soc/fstab.eliza",
            "sw/aosp-device/device/eliza/eliza_ai_soc/manifest.xml",
            "sw/aosp-device/device/eliza/eliza_ai_soc/eliza_e1.xml",
            "sw/aosp-device/device/eliza/eliza_ai_soc/kernel/eliza_ai_soc.fragment",
            "sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts",
            "sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/file_contexts",
            "sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/e1_npu.te",
            "sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu/Android.bp",
            "sw/aosp-device/device/eliza/eliza_ai_soc/hal/hwcomposer/Android.bp",
            "sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_sim/Android.bp",
            "sw/aosp-device/device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk",
            "sw/aosp-device/device/eliza/cuttlefish_e1/manifest.fragment.xml",
            "sw/aosp-device/check-cvd-hal-smoke.sh",
            "docs/android/boot-transcript.schema.json",
        ],
        "contract_terms": ["eliza_ai_soc", "e1_npu", "hwcomposer"],
        "evidence": [
            "docs/evidence/android/eliza_ai_soc_lunch.log",
            "docs/evidence/android/eliza_ai_soc_vendorimage.log",
            "docs/evidence/android/eliza_ai_soc_checkvintf.log",
            "docs/evidence/android/eliza_ai_soc_sepolicy_build.log",
            "docs/evidence/android/eliza_ai_soc_selinux_neverallow.log",
            "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log",
            "docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log",
            "docs/evidence/android/cuttlefish_riscv64_smoke.log",
            "docs/evidence/android/qemu_riscv64_smoke.log",
            "docs/evidence/android/renode_e1_soc_smoke.log",
        ],
        "evidence_note": "external AOSP lunch/vendorimage/VINTF/SELinux/CTS-VTS intake logs plus virtual-device smoke transcripts",
    },
}

ALTERNATE_BSP_TARGETS = {"u-boot"}


def selected_bsp_targets() -> list[str]:
    names = [name for name in TARGETS if name not in ALTERNATE_BSP_TARGETS]
    if os.environ.get("ELIZA_INCLUDE_ALTERNATE_UBOOT") == "1":
        names.append("u-boot")
    return names

FORBIDDEN_TRANSCRIPT_MARKERS = [
    "placeholder transcript",
    "synthetic placeholder",
    "blocked",
    "not run",
    "status=FAIL",
    "status: FAIL",
    "eliza-evidence: status=FAIL",
    "openagent-evidence: status=FAIL",
]


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path, errors: list[str]) -> dict:
    if not path.is_file():
        errors.append(f"{path.relative_to(ROOT)} is missing")
        return {}
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(ROOT)} is invalid JSON: {exc}")
        return {}
    if not isinstance(payload, dict):
        errors.append(f"{path.relative_to(ROOT)} must be a JSON object")
        return {}
    return payload


def load_evidence_manifest(errors: list[str] | None = None) -> dict:
    return load_json(EVIDENCE_MANIFEST, errors if errors is not None else [])


def evidence_items_for_target(name: str) -> list[dict[str, Any]]:
    manifest = load_evidence_manifest([])
    return list(manifest.get("targets", {}).get(name, {}).get("evidence", []))


def validate_evidence_file(item: dict[str, Any]) -> list[str]:
    path = ROOT / item["path"]
    problems: list[str] = []
    if not path.is_file():
        return [f"missing {item['path']}"]

    text = path.read_text(errors="ignore")
    if len(text.encode("utf-8")) < int(item.get("min_bytes", 0)):
        problems.append(
            f"{item['path']} is too small for external evidence "
            f"({len(text.encode('utf-8'))} bytes < {item.get('min_bytes', 0)})"
        )

    missing_required = [term for term in item.get("required_strings", []) if term not in text]
    if missing_required:
        problems.append(
            f"{item['path']} missing required transcript markers: " + ", ".join(missing_required)
        )

    for group in item.get("at_least_one", []):
        if not any(term in text for term in group):
            problems.append(
                f"{item['path']} missing at least one transcript marker from: " + ", ".join(group)
            )

    configured_forbidden = item.get("forbidden_strings", [])
    lowered = text.lower()
    forbidden = [
        term
        for term in [*FORBIDDEN_TRANSCRIPT_MARKERS, *configured_forbidden]
        if term.lower() in lowered
    ]
    if forbidden:
        problems.append(
            f"{item['path']} contains forbidden placeholder/failure markers: "
            + ", ".join(dict.fromkeys(forbidden))
        )

    status_match = re.search(r"(?:eliza|openagent)-evidence:\s*status=([A-Z]+)", text)
    if not status_match:
        problems.append(f"{item['path']} missing evidence PASS status marker")
    elif status_match.group(1) != "PASS":
        problems.append(f"{item['path']} reports non-PASS evidence status: {status_match.group(1)}")

    claim_boundary = item.get("claim_boundary", "")
    if claim_boundary in {AOSP_REFERENCE_ONLY_BOUNDARY, AOSP_VIRTUAL_DEVICE_BOUNDARY}:
        markers = {
            f"eliza-evidence: claim_boundary={claim_boundary}",
            f"openagent-evidence: claim_boundary={claim_boundary}",
        }
        if not any(marker in text for marker in markers):
            problems.append(f"{item['path']} missing reference-only claim boundary marker")

    return problems


def validate_manifest_evidence(name: str, *, include_missing: bool = True) -> list[str]:
    problems: list[str] = []
    for item in evidence_items_for_target(name):
        if not include_missing and not (ROOT / item["path"]).is_file():
            continue
        problems.extend(validate_evidence_file(item))
    return problems


def existing_repo_path(path: str) -> Path | None:
    direct = ROOT / path
    if direct.exists():
        return direct
    migrated = ROOT / "docs" / path
    if migrated.exists():
        return migrated
    return None


def check_contract(errors: list[str]) -> None:
    if not CONTRACT.is_file():
        errors.append("sw/platform/e1_platform_contract.json is missing")
        return
    data = json.loads(CONTRACT.read_text())
    if data.get("e1_chip", {}).get("has_cpu") is not False:
        errors.append("e1 platform contract must keep e1_chip.has_cpu=false until a CPU exists")
    if data.get("qemu_virt", {}).get("target_kind") != "software_reference_only":
        errors.append("qemu_virt must be marked software_reference_only")


def check_artifact_manifest(name: str, errors: list[str]) -> None:
    manifest = load_json(ARTIFACT_MANIFEST, errors)
    if not manifest:
        return
    if manifest.get("claim_boundary") != "host_checkable_manifest_only_not_boot_evidence":
        errors.append(
            "docs/android/bsp-artifact-manifest.json must keep a non-boot-evidence claim boundary"
        )
    target = manifest.get("targets", {}).get(name)
    if not target:
        errors.append(f"docs/android/bsp-artifact-manifest.json missing target {name}")
        return
    required_repo_evidence = target.get("required_repo_evidence", [])
    expected = TARGETS[name]["evidence"]
    if sorted(required_repo_evidence) != sorted(expected):
        errors.append(
            f"{name} artifact manifest evidence list does not match check_software_bsp.py"
        )
    if not target.get("required_outputs"):
        errors.append(f"{name} artifact manifest must list external build outputs")
    if not target.get("external_tree"):
        errors.append(f"{name} artifact manifest must identify the external tree boundary")
    if not target.get("source_command"):
        errors.append(
            f"{name} artifact manifest must list the source command for evidence production"
        )
    if "boot" in target.get("minimum_claim_to_clear_block", "").lower() and name not in {
        "aosp",
        "u-boot",
    }:
        errors.append(f"{name} manifest must not imply Android boot evidence")


def check_log_evidence(path: str, errors: list[str], *, strict: bool = True) -> list[str]:
    problems: list[str] = []
    manifest = load_json(LOG_EVIDENCE_MANIFEST, errors)
    if not manifest:
        return problems
    if manifest.get("claim_boundary") != "expected_future_log_markers_only_not_boot_evidence":
        errors.append(
            "docs/android/bsp-log-evidence-manifest.json must keep a non-boot-evidence claim boundary"
        )
    spec = manifest.get("logs", {}).get(path)
    if not spec:
        errors.append(f"docs/android/bsp-log-evidence-manifest.json missing parser spec for {path}")
        return problems
    if not spec.get("producer_command"):
        errors.append(
            f"docs/android/bsp-log-evidence-manifest.json missing producer_command for {path}"
        )
    if not spec.get("required_metadata"):
        errors.append(
            f"docs/android/bsp-log-evidence-manifest.json missing required_metadata for {path}"
        )
    if not spec.get("capture_hint"):
        errors.append(
            f"docs/android/bsp-log-evidence-manifest.json missing capture_hint for {path}"
        )
    if not spec.get("claim_boundary"):
        errors.append(
            f"docs/android/bsp-log-evidence-manifest.json missing claim_boundary for {path}"
        )
    evidence_path = ROOT / path
    if not evidence_path.is_file():
        return problems
    text = evidence_path.read_text(errors="ignore")
    metadata = spec.get("required_metadata", DEFAULT_EVIDENCE_METADATA)
    missing_metadata = [term for term in metadata if term not in text]
    if missing_metadata:
        problems.append(
            f"{path} missing required evidence provenance fields: " + ", ".join(missing_metadata)
        )
    missing_all = [term for term in spec.get("required_all", []) if term not in text]
    if missing_all:
        problems.append(f"{path} missing required log markers: " + ", ".join(missing_all))
    any_terms = spec.get("required_any", [])
    if any_terms and not any(term in text for term in any_terms):
        problems.append(f"{path} missing one of required log markers: " + ", ".join(any_terms))
    forbidden_terms = [term for term in spec.get("forbidden_any", []) if term in text]
    if forbidden_terms:
        problems.append(
            f"{path} contains forbidden failure/placeholder markers: " + ", ".join(forbidden_terms)
        )
    forbidden_claims = [
        term for term in spec.get("forbidden_claims", []) if term.lower() in text.lower()
    ]
    if forbidden_claims:
        problems.append(
            f"{path} contains forbidden broad claim markers: " + ", ".join(forbidden_claims)
        )
    if strict:
        errors.extend(problems)
    return problems


def check_boot_transcript_schema(errors: list[str]) -> None:
    schema = load_json(BOOT_TRANSCRIPT_SCHEMA, errors)
    if not schema:
        return
    if schema.get("$id") != "eliza.android_virtual_device_smoke.schema.v1":
        errors.append("docs/android/boot-transcript.schema.json has unexpected $id")
    properties = schema.get("properties", {})
    environment = properties.get("environment", {})
    expected_envs = {"cuttlefish_riscv64", "qemu_riscv64", "renode_e1_soc"}
    if set(environment.get("enum", [])) != expected_envs:
        errors.append(
            "virtual-device smoke schema must enumerate Cuttlefish, QEMU, and Renode evidence environments"
        )
    boundary = properties.get("claim_boundary", {}).get("const")
    if boundary != "virtual_device_smoke_only_not_boot_or_compatibility_evidence":
        errors.append(
            "virtual-device smoke schema must keep a no-boot/no-compatibility claim boundary"
        )
    required = set(schema.get("required", []))
    for field in ["smoke_log_path", "required_markers", "forbidden_markers", "blockers"]:
        if field not in required:
            errors.append(f"virtual-device smoke schema missing required field {field}")


def active_aosp_hal_names(manifest_text: str) -> list[str]:
    active_text = re.sub(r"<!--.*?-->", "", manifest_text, flags=re.DOTALL)
    names: list[str] = []
    for hal_block in re.findall(r"<hal(?:\s|>).*?</hal>", active_text, flags=re.DOTALL):
        match = re.search(r"<name>\s*([^<\s]+)\s*</name>", hal_block)
        names.append(match.group(1) if match else "<unnamed>")
    return names


def aosp_make_text_without_comments(device_text: str) -> str:
    lines: list[str] = []
    for line in device_text.splitlines():
        lines.append(line.split("#", 1)[0])
    return "\n".join(lines)


def aosp_hal_source_files(device_root: Path, hal_name: str) -> list[Path]:
    if hal_name == "vendor.eliza.e1_npu":
        hal_root = device_root / "hal/e1_npu"
        return [
            hal_root / "Android.bp",
            hal_root / "service.cpp",
            hal_root / "E1Npu.cpp",
            hal_root / "vendor.eliza.e1_npu@1.0-service.rc",
            hal_root / "vendor.eliza.e1_npu@1.0-service.xml",
        ]
    if hal_name == "android.hardware.graphics.composer":
        hal_root = device_root / "hal/hwcomposer"
        return [
            hal_root / "Android.bp",
            hal_root / "service.cpp",
            hal_root / "hwcomposer.cpp",
            hal_root / "android.hardware.graphics.composer@2.4-service.eliza_ai_soc.rc",
            hal_root / "android.hardware.graphics.composer@2.4-service.eliza_ai_soc.xml",
        ]
    return []


def aosp_hal_source_available(device_root: Path, hal_name: str) -> bool:
    source_files = aosp_hal_source_files(device_root, hal_name)
    return bool(source_files) and all(path.is_file() for path in source_files)


def check_aosp_product_glue(errors: list[str]) -> None:
    device_root = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc"
    product = device_root / "AndroidProducts.mk"
    product_mk = device_root / "eliza_ai_soc.mk"
    board = device_root / "BoardConfig.mk"
    manifest = device_root / "manifest.xml"
    e1_vintf_fragment = device_root / "hal/e1_npu/vendor.eliza.e1_npu@1.0-service.xml"
    matrix = device_root / "device_framework_matrix.xml"
    text = product.read_text(errors="ignore") if product.is_file() else ""
    product_mk_text = product_mk.read_text(errors="ignore") if product_mk.is_file() else ""
    lunch_choices = {
        "eliza_ai_soc-userdebug",
        "eliza_ai_soc-trunk_staging-userdebug",
    }
    if "COMMON_LUNCH_CHOICES" not in text or not any(choice in text for choice in lunch_choices):
        errors.append("AOSP AndroidProducts.mk must expose an eliza_ai_soc userdebug lunch choice")
    board_text = board.read_text(errors="ignore") if board.is_file() else ""
    for term in [
        "TARGET_ARCH := riscv64",
        "BOARD_VENDOR_SEPOLICY_DIRS",
        "ELIZA_KERNEL_CONFIG_FRAGMENT",
        "ELIZA_DTS",
    ]:
        if term not in board_text:
            errors.append(f"AOSP BoardConfig.mk missing {term}")
    if manifest.is_file():
        manifest_text = manifest.read_text(errors="ignore")
        for term in ["<manifest"]:
            if term not in manifest_text:
                errors.append(f"AOSP VINTF manifest missing XML marker {term}")
        if "</manifest>" not in manifest_text and "/>" not in manifest_text:
            errors.append("AOSP VINTF manifest is missing closing </manifest> marker")
        if "android.hardware.graphics.composer" in active_aosp_hal_names(manifest_text):
            errors.append(
                "AOSP VINTF manifest must not declare the deprecated local composer@2.4 HAL; "
                "graphics comes from inherited Cuttlefish composer3 packages"
            )
        active_hals_without_sources = [
            name
            for name in active_aosp_hal_names(manifest_text)
            if not aosp_hal_source_available(device_root, name)
        ]
        if active_hals_without_sources:
            errors.append(
                "AOSP VINTF manifest must not declare active HAL entries until source "
                "or prebuilts exist: " + ", ".join(active_hals_without_sources)
            )
    if "device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk" not in product_mk_text:
        errors.append(
            "AOSP eliza_ai_soc.mk must inherit the Cuttlefish riscv64 phone product for modern composer3 graphics"
        )
    if e1_vintf_fragment.is_file():
        e1_fragment_text = e1_vintf_fragment.read_text(errors="ignore")
        if "vendor.eliza.e1_npu" not in e1_fragment_text or "IE1Npu" not in e1_fragment_text:
            errors.append(
                "AOSP e1 NPU VINTF fragment missing vendor.eliza.e1_npu IE1Npu declaration"
            )
    else:
        errors.append("AOSP e1 NPU per-service VINTF fragment is missing")
    if matrix.is_file():
        matrix_text = matrix.read_text(errors="ignore")
        if "vendor.eliza.e1_npu" not in matrix_text or "IE1Npu" not in matrix_text:
            errors.append("AOSP device framework matrix missing optional vendor.eliza.e1_npu entry")
    else:
        errors.append("AOSP device framework compatibility matrix is missing")
    device = device_root / "device.mk"
    device_text = device.read_text(errors="ignore") if device.is_file() else ""
    active_device_text = aosp_make_text_without_comments(device_text)
    hal_package_sources = {
        "e1_npu.default": "vendor.eliza.e1_npu",
        "vendor.eliza.e1_npu@1.0-service": "vendor.eliza.e1_npu",
    }
    deprecated_hwc_packages = [
        package
        for package in (
            "android.hardware.graphics.composer@2.4-service.eliza_ai_soc",
            "hwcomposer.eliza_ai_soc",
        )
        if package in active_device_text
    ]
    if deprecated_hwc_packages:
        errors.append(
            "AOSP device.mk must not list deprecated local composer@2.4 packages: "
            + ", ".join(deprecated_hwc_packages)
        )
    hal_packages_without_sources = [
        package
        for package, hal_name in hal_package_sources.items()
        if package in active_device_text and not aosp_hal_source_available(device_root, hal_name)
    ]
    if hal_packages_without_sources:
        errors.append(
            "AOSP device.mk must not list HAL packages until source or prebuilts exist: "
            + ", ".join(hal_packages_without_sources)
        )
    forbidden_feature_terms = [
        "android.hardware.camera",
        "android.hardware.audio",
        "android.hardware.bluetooth",
        "android.hardware.location.gps",
        "android.hardware.nfc",
        "android.hardware.telephony",
        "android.hardware.sensor",
        "handheld_core_hardware.xml",
        "android.software.cts",
        "gms",
    ]
    lowered_device_text = device_text.lower()
    for term in forbidden_feature_terms:
        if term in lowered_device_text:
            errors.append(
                f"AOSP device.mk must not declare Android product feature claim without evidence: {term}"
            )


def check_android_proof_templates(errors: list[str]) -> None:
    nnapi_template = load_json(NNAPI_PROOF_TEMPLATE, errors)
    if nnapi_template:
        if nnapi_template.get("schema") != "eliza.e1_npu_nnapi_capability.v1":
            errors.append("NNAPI proof template has unexpected schema")
        dma = nnapi_template.get("dma", {})
        if not isinstance(dma, dict) or "trace_bytes" not in dma:
            errors.append("NNAPI proof template must bind dma.trace_bytes to the DMA transcript")
        transcripts = nnapi_template.get("transcripts", {})
        if not isinstance(transcripts, dict):
            errors.append("NNAPI proof template transcripts must be an object")
            transcripts = {}
        missing_transcripts = REQUIRED_NNAPI_TRANSCRIPTS - set(transcripts)
        if missing_transcripts:
            errors.append(
                "NNAPI proof template missing transcript entries: "
                + ", ".join(sorted(missing_transcripts))
            )
        for name in sorted(REQUIRED_NNAPI_TRANSCRIPTS & set(transcripts)):
            entry = transcripts[name]
            if not isinstance(entry, dict):
                errors.append(
                    f"NNAPI proof template transcripts.{name} must include path, sha256, and bytes"
                )
                continue
            path = entry.get("path")
            if not isinstance(path, str) or not path or Path(path).is_absolute():
                errors.append(f"NNAPI proof template transcripts.{name}.path must be repo-relative")
            sha = entry.get("sha256")
            if not isinstance(sha, str) or "64-character lowercase sha256" not in sha:
                errors.append(f"NNAPI proof template transcripts.{name}.sha256 must require sha256")
            bytes_value = entry.get("bytes")
            if not isinstance(bytes_value, int) or isinstance(bytes_value, bool):
                errors.append(f"NNAPI proof template transcripts.{name}.bytes must be an integer")

    android_template = load_json(ANDROID_PROOF_TEMPLATE, errors)
    if not android_template:
        return
    if android_template.get("schema") != "eliza.e1_npu_android_proof_manifest.v1":
        errors.append("Android proof manifest template has unexpected schema")
    if android_template.get("claim_boundary") != ANDROID_PROOF_TEMPLATE_BOUNDARY:
        errors.append(
            "Android proof manifest template must keep the template-only no-boot/no-CTS/VTS/no-NNAPI boundary"
        )
    if android_template.get("status") != "blocked":
        errors.append("Android proof manifest template status must remain blocked")
    proof_gate = android_template.get("proof_gate", {})
    if not isinstance(proof_gate, dict):
        errors.append("Android proof manifest template proof_gate must be an object")
    else:
        for field in ("android_boot_claim", "compatibility_claim"):
            if proof_gate.get(field) != "none":
                errors.append(f"Android proof manifest template {field} must be none")
        if proof_gate.get("nnapi_acceleration_claim") != (
            "none_without_all_required_artifacts_passed"
        ):
            errors.append("Android proof manifest template must fail closed on NNAPI acceleration")
    statuses = android_template.get("required_statuses", {})
    if not isinstance(statuses, dict):
        errors.append("Android proof manifest required_statuses must be an object")
        statuses = {}
    missing_statuses = REQUIRED_ANDROID_PROOF_STATUSES - set(statuses)
    if missing_statuses:
        errors.append(
            "Android proof manifest template missing status gates: "
            + ", ".join(sorted(missing_statuses))
        )
    for status_name, status in statuses.items():
        if status != "blocked":
            errors.append(f"Android proof manifest status {status_name} must remain blocked")
    artifacts = android_template.get("artifacts", {})
    if not isinstance(artifacts, dict):
        errors.append("Android proof manifest artifacts must be an object")
        artifacts = {}
    missing_artifacts = set(REQUIRED_ANDROID_PROOF_ARTIFACTS) - set(artifacts)
    if missing_artifacts:
        errors.append(
            "Android proof manifest template missing artifacts: "
            + ", ".join(sorted(missing_artifacts))
        )
    for artifact_name, expected_path in REQUIRED_ANDROID_PROOF_ARTIFACTS.items():
        artifact = artifacts.get(artifact_name)
        if not isinstance(artifact, dict):
            continue
        path = artifact.get("path")
        if path != expected_path:
            errors.append(
                f"Android proof manifest artifact {artifact_name}.path must be {expected_path}"
            )
        sha = artifact.get("sha256")
        if not isinstance(sha, str) or "64-character lowercase sha256" not in sha:
            errors.append(
                f"Android proof manifest artifact {artifact_name}.sha256 must require sha256"
            )


def check_target(name: str) -> tuple[list[str], list[str]]:
    spec = TARGETS[name]
    errors: list[str] = []
    blockers: list[str] = []
    check_contract(errors)
    check_artifact_manifest(name, errors)

    readme = spec["readme"]
    if not readme.is_file():
        migrated_readme = ROOT / "docs" / readme.relative_to(ROOT)
        if migrated_readme.is_file():
            readme = migrated_readme
    if not readme.is_file():
        errors.append(f"{readme.relative_to(ROOT)} is missing")
        return errors, blockers

    text = readme.read_text(errors="ignore")
    if "placeholder" in text.lower():
        errors.append(f"{readme.relative_to(ROOT)} still describes a placeholder-only target")
    if "sw/platform/e1_platform_contract.json" not in text:
        errors.append(
            f"{readme.relative_to(ROOT)} does not reference the central platform contract"
        )

    missing = [path for path in spec["required"] if existing_repo_path(path) is None]
    if missing:
        errors.append(
            f"{name} BSP is not implemented; missing required artifacts: " + ", ".join(missing)
        )

    present_text = "\n".join(
        path.read_text(errors="ignore")
        for path in (existing_repo_path(spec_path) for spec_path in spec["required"])
        if path and path.is_file()
    )
    if present_text:
        missing_terms = [term for term in spec["contract_terms"] if term not in present_text]
        if missing_terms:
            errors.append(
                f"{name} BSP artifacts do not expose expected contract terms: "
                + ", ".join(missing_terms)
            )

    if name == "aosp":
        check_boot_transcript_schema(errors)
        check_aosp_product_glue(errors)
        check_android_proof_templates(errors)

    missing_evidence = [path for path in spec.get("evidence", []) if not (ROOT / path).is_file()]
    for path in spec.get("evidence", []):
        blockers.extend(check_log_evidence(path, errors, strict=False))
    blockers.extend(validate_manifest_evidence(name, include_missing=False))
    if missing_evidence:
        manifest = load_json(LOG_EVIDENCE_MANIFEST, [])
        missing_with_codes = []
        for path in missing_evidence:
            blocker_code = (
                manifest.get("logs", {})
                .get(path, {})
                .get("blocker_code", "missing_external_evidence")
            )
            missing_with_codes.append(f"{path}({blocker_code})")
        blockers.append(
            f"{name} BSP BLOCKED: missing evidence for {spec['evidence_note']}: "
            + ", ".join(missing_with_codes)
        )
    elif blockers:
        blockers.insert(
            0,
            f"{name} BSP BLOCKED: external evidence for {spec['evidence_note']} "
            "does not satisfy required transcript markers",
        )

    return errors, blockers


def target_report(name: str) -> dict:
    errors, blockers = check_target(name)
    manifest_items = evidence_items_for_target(name)
    missing_evidence = [item for item in manifest_items if not (ROOT / item["path"]).is_file()]
    invalid_evidence = [
        {"path": item["path"], "problems": validate_evidence_file(item)}
        for item in manifest_items
        if (ROOT / item["path"]).is_file() and validate_evidence_file(item)
    ]
    log_manifest = load_json(LOG_EVIDENCE_MANIFEST, [])
    missing = []
    for item in missing_evidence:
        path = item["path"]
        spec = log_manifest.get("logs", {}).get(path, {})
        missing.append(
            {
                "path": path,
                "blocker_code": spec.get("blocker_code", "missing_external_evidence"),
                "artifact": item.get("artifact", ""),
                "capture_command": item.get("capture_command", spec.get("producer_command", "")),
                "validation_command": item.get(
                    "validation_command",
                    f"python3 scripts/check_software_bsp.py {name} --require-evidence",
                ),
                "claim_boundary": item.get("claim_boundary", spec.get("claim_boundary", "")),
            }
        )
    return {
        "target": name,
        "scaffold_status": "FAIL" if errors else "PASS",
        "evidence_status": (
            "BLOCKED" if missing_evidence else ("FAIL" if invalid_evidence or errors else "PASS")
        ),
        "errors": errors,
        "blockers": blockers,
        "missing_evidence": missing,
        "invalid_evidence": invalid_evidence,
    }


def blocker_code(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:12]) or fallback


def evidence_requirements_for_target(name: str) -> list[dict[str, Any]]:
    requirements: list[dict[str, Any]] = []
    for item in evidence_items_for_target(name):
        requirements.append(
            {
                "path": item.get("path", ""),
                "artifact": item.get("artifact", ""),
                "capture_command": item.get("capture_command", ""),
                "validation_command": item.get(
                    "validation_command",
                    f"python3 scripts/check_software_bsp.py {name} --require-evidence",
                ),
                "claim_boundary": item.get("claim_boundary", ""),
                "required_strings": item.get("required_strings", []),
                "at_least_one": item.get("at_least_one", []),
                "min_bytes": item.get("min_bytes", 0),
            }
        )
    return requirements


def build_scaffold_report(
    *,
    target: str,
    scaffold_only: bool,
    require_evidence: bool,
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    for result in results:
        name = str(result["target"])
        for error in result["errors"]:
            findings.append(
                {
                    "code": blocker_code(f"{name} {error}", "software_bsp_scaffold_error"),
                    "severity": "fail",
                    "target": name,
                    "message": error,
                    "evidence": f"python3 scripts/check_software_bsp.py {name}",
                    "next_step": "Fix the missing or stale repo-local BSP scaffold artifact.",
                    "next_command": f"python3 scripts/check_software_bsp.py {name} --scaffold-only",
                }
            )
        if require_evidence or not scaffold_only:
            for blocker in result["blockers"]:
                findings.append(
                    {
                        "code": blocker_code(
                            f"{name} {blocker}", "software_bsp_external_evidence_blocked"
                        ),
                        "severity": "blocker",
                        "target": name,
                        "message": blocker,
                        "evidence": f"python3 scripts/check_software_bsp.py {name} --require-evidence",
                        "next_step": "Render the exact capture plan and evidence contract for this target, then capture the listed external transcripts and rerun the require-evidence gate.",
                        "next_command": f"python3 scripts/check_software_bsp.py capture-plan {name}",
                        "evidence_requirements_command": f"python3 scripts/check_software_bsp.py {name} --evidence-plan",
                        "evidence_requirements": evidence_requirements_for_target(name),
                    }
                )
    if any(finding["severity"] == "fail" for finding in findings):
        status = "fail"
    elif findings:
        status = "blocked"
    else:
        status = "pass"
    return {
        "schema": "eliza.software_bsp.v1",
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "generated_utc": datetime.now(UTC).isoformat(),
        "target": target,
        "scaffold_only": scaffold_only,
        "require_evidence": require_evidence,
        "summary": {
            "targets_checked": len(results),
            "targets_with_errors": sum(1 for result in results if result["errors"]),
            "targets_with_blockers": sum(1 for result in results if result["blockers"]),
            "findings": len(findings),
        },
        "targets": results,
        "findings": findings,
    }


def write_scaffold_report(report: dict[str, Any], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_status(name: str) -> int:
    report = target_report(name)
    print(f"{name}: software BSP evidence status")
    print(f"  scaffold: {report['scaffold_status']}")
    print(f"  evidence: {report['evidence_status']}")
    for error in report["errors"]:
        print(f"  [SCAFFOLD-ERROR] {error}")
    for item in evidence_items_for_target(name):
        path = ROOT / item["path"]
        state = "PRESENT" if path.is_file() else "MISSING"
        print(f"  [{state}] {item.get('artifact', item['path'])}")
        print(f"    path: {item['path']}")
        print(f"    capture: {item.get('capture_command', '')}")
        print(
            "    validate: "
            + item.get(
                "validation_command",
                f"python3 scripts/check_software_bsp.py {name} --require-evidence",
            )
        )
        if not path.is_file():
            print(f"    blocker: missing {item['path']}")
        else:
            for problem in validate_evidence_file(item):
                print(f"    problem: {problem}")
    if report["evidence_status"] != "PASS":
        return 2
    return 0 if report["scaffold_status"] == "PASS" else 1


def capture_plan_commands(
    name: str,
    *,
    buildroot: str | None,
    linux: str | None,
    opensbi: str | None,
    u_boot: str | None,
    aosp: str | None,
    target_host: str | None,
    opensbi_handoff_cmd: str | None,
    qemu_smoke_cmd: str | None,
    renode_smoke_cmd: str | None,
) -> list[str]:
    target = target_host or "TARGET"
    if name == "buildroot":
        tree = buildroot or "/path/to/buildroot"
        return [
            f"sw/buildroot/scripts/import-buildroot-external.sh --check {tree}",
            f"sw/buildroot/scripts/capture-buildroot-evidence.sh {tree} defconfig",
            f"sw/buildroot/scripts/capture-buildroot-evidence.sh {tree} image-manifest",
            "E1_SMOKE_CMD='ssh "
            + target
            + " /usr/bin/e1-mmio-smoke' "
            + f"sw/buildroot/scripts/capture-buildroot-evidence.sh {tree} smoke",
            "E1_NPU_ML_SMOKE_CMD='ssh "
            + target
            + " /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu' "
            + f"sw/buildroot/scripts/capture-buildroot-evidence.sh {tree} ml-smoke",
            "python3 scripts/check_software_bsp.py buildroot --require-evidence",
        ]
    if name == "linux":
        tree = linux or "/path/to/linux"
        return [
            f"sw/linux/scripts/import-linux-bsp.sh --check {tree}",
            f"sw/linux/scripts/capture-linux-bsp-evidence.sh {tree} kernel-build",
            f"sw/linux/scripts/capture-linux-bsp-evidence.sh {tree} dtb-check",
            "E1_SMOKE_CMD='ssh "
            + target
            + " /tmp/e1-mmio-smoke' "
            + f"sw/linux/scripts/capture-linux-bsp-evidence.sh {tree} smoke",
            "python3 scripts/check_software_bsp.py linux --require-evidence",
        ]
    if name == "opensbi":
        tree = opensbi or "/path/to/opensbi"
        handoff = opensbi_handoff_cmd or "/exact/qemu-or-renode fw_dynamic handoff command"
        return [
            f"sw/opensbi/scripts/import-opensbi-platform.sh --check {tree}",
            f"ELIZA_OPENSBI_CMD='make PLATFORM=generic FW_DYNAMIC=y' docs/sw/opensbi/capture-opensbi-evidence.sh {tree} build",
            f"ELIZA_OPENSBI_HANDOFF_CMD={handoff!r} docs/sw/opensbi/capture-opensbi-evidence.sh {tree} handoff",
            "python3 scripts/check_software_bsp.py opensbi --require-evidence",
        ]
    if name == "u-boot":
        tree = u_boot or "/path/to/u-boot"
        return [
            f"ELIZA_UBOOT_CMD='make eliza_defconfig && make' docs/sw/u-boot/capture-u-boot-evidence.sh {tree} build",
            f"ELIZA_UBOOT_BOOT_CMD='/path/to/qemu-or-renode boot command' docs/sw/u-boot/capture-u-boot-evidence.sh {tree} boot-chain",
            "python3 scripts/check_software_bsp.py u-boot --require-evidence",
        ]
    if name == "aosp":
        tree = aosp or "/path/to/aosp"
        commands = [
            f"sw/aosp-device/import-aosp-device.sh --check {tree}",
            f"sw/aosp-device/capture-aosp-evidence.sh {tree} lunch",
            f"sw/aosp-device/capture-aosp-evidence.sh {tree} vendorimage",
            f"sw/aosp-device/capture-aosp-evidence.sh {tree} checkvintf",
            f"sw/aosp-device/capture-aosp-evidence.sh {tree} sepolicy-build",
            f"sw/aosp-device/capture-aosp-evidence.sh {tree} selinux-neverallow",
            f"sw/aosp-device/capture-aosp-evidence.sh {tree} cts-vts-plan",
            f"sw/aosp-device/capture-aosp-evidence.sh {tree} cuttlefish-smoke",
        ]
        if qemu_smoke_cmd:
            commands.append(
                f"AOSP_QEMU_SMOKE_COMMAND={qemu_smoke_cmd!r} "
                + f"sw/aosp-device/capture-aosp-evidence.sh {tree} qemu-smoke"
            )
        else:
            commands.append(
                "AOSP_QEMU_SMOKE_COMMAND='/exact/qemu-system-riscv64 smoke command' "
                + f"sw/aosp-device/capture-aosp-evidence.sh {tree} qemu-smoke"
            )
        if renode_smoke_cmd:
            commands.append(
                f"AOSP_RENODE_SMOKE_COMMAND={renode_smoke_cmd!r} "
                + f"sw/aosp-device/capture-aosp-evidence.sh {tree} renode-smoke"
            )
        else:
            commands.append(
                "AOSP_RENODE_SMOKE_COMMAND='/exact/renode smoke command' "
                + f"sw/aosp-device/capture-aosp-evidence.sh {tree} renode-smoke"
            )
        commands.append("python3 scripts/check_software_bsp.py aosp --require-evidence")
        return commands
    raise ValueError(name)


def print_capture_plan(args: argparse.Namespace) -> None:
    names = selected_bsp_targets() if args.target == "all" else [args.target]
    for name in names:
        print(f"{name}: capture/import plan")
        for command in capture_plan_commands(
            name,
            buildroot=args.buildroot,
            linux=args.linux,
            opensbi=args.opensbi,
            u_boot=args.u_boot,
            aosp=args.aosp,
            target_host=args.target_host,
            opensbi_handoff_cmd=args.opensbi_handoff_cmd,
            qemu_smoke_cmd=args.qemu_smoke_cmd,
            renode_smoke_cmd=args.renode_smoke_cmd,
        ):
            print(f"  {command}")


def print_evidence_plan(name: str) -> None:
    manifest_errors: list[str] = []
    manifest = load_json(LOG_EVIDENCE_MANIFEST, manifest_errors)
    spec = TARGETS[name]
    print(f"{name}: external evidence intake plan")
    print(f"  blocker: {spec['evidence_note']}")
    if manifest_errors:
        for error in manifest_errors:
            print(f"  error: {error}")
        return
    for path in spec.get("evidence", []):
        log_spec = manifest.get("logs", {}).get(path, {})
        print(f"  evidence: {path}")
        print(f"    producer: {log_spec.get('producer_command', 'MISSING')}")
        print(f"    claim boundary: {log_spec.get('claim_boundary', 'MISSING')}")
        print(f"    capture: {log_spec.get('capture_hint', 'MISSING')}")
        metadata = log_spec.get("required_metadata", DEFAULT_EVIDENCE_METADATA)
        print(f"    required metadata: {', '.join(metadata)}")
        if log_spec.get("required_all"):
            print(f"    required all: {', '.join(log_spec['required_all'])}")
        if log_spec.get("required_any"):
            print(f"    required any: {', '.join(log_spec['required_any'])}")
        if log_spec.get("forbidden_any"):
            print(f"    forbidden any: {', '.join(log_spec['forbidden_any'])}")


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def provenance_safe_text(value: str) -> str:
    safe = value.replace(str(ROOT), "<repo>")
    home = os.environ.get("HOME")
    if home:
        safe = safe.replace(home, "<home>")
    safe = safe.replace("/var/tmp/", "<var-tmp>/")
    safe = safe.replace("/tmp/", "<tmp>/")
    return safe


def provenance_safe_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: provenance_safe_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [provenance_safe_value(child) for child in value]
    if isinstance(value, str):
        return provenance_safe_text(value)
    return value


def shell_arg(path: str | Path) -> str:
    return shlex.quote(str(path))


def default_tree(name: str) -> Path | None:
    candidates = {
        "linux": ROOT / "external/linux",
        "opensbi": ROOT / "external/opensbi",
    }
    candidate = candidates.get(name)
    if candidate and candidate.exists():
        return candidate
    return None


def path_from_arg(value: str | None, name: str) -> Path | None:
    if value:
        return Path(value).expanduser().resolve()
    return default_tree(name)


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def any_command_exists(names: list[str]) -> bool:
    return any(command_exists(name) for name in names)


def gnu_make_check() -> tuple[bool, str]:
    make = shutil.which("gmake") or shutil.which("make")
    if not make:
        return False, "missing make/gmake"
    try:
        result = subprocess.run(
            [make, "--version"],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as exc:
        return False, f"{make} --version failed: {exc}"
    first = result.stdout.splitlines()[0] if result.stdout else make
    match = re.search(r"GNU Make\s+(\d+)\.(\d+)", first)
    if not match:
        return False, f"{first} (GNU Make >= 3.82 required)"
    version = (int(match.group(1)), int(match.group(2)))
    return version >= (3, 82), first


def linux_preflight(tree: Path | None, target_host: str | None) -> dict[str, Any]:
    blockers: list[str] = []
    checks: list[dict[str, Any]] = []
    tree_text = str(tree) if tree else "/path/to/linux"

    def check(path: Path, description: str) -> None:
        ok = path.exists()
        checks.append(
            {"name": description, "path": str(path), "status": "PASS" if ok else "BLOCKED"}
        )
        if not ok:
            blockers.append(f"missing {description}: {path}")

    if tree is None:
        blockers.append("LINUX_TREE not supplied and external/linux was not found")
    else:
        check(tree / "Kconfig", "Linux Kconfig")
        check(tree / "drivers", "Linux drivers directory")
        check(tree / "arch", "Linux arch directory")
        check(tree / "drivers/misc/eliza-e1/Kconfig", "imported Eliza Linux driver Kconfig")
        check(tree / "arch/riscv/boot/dts/eliza/eliza-e1.dts", "imported Eliza DTS")
        check(
            tree / "Documentation/devicetree/bindings/eliza/eliza,e1-npu.yaml",
            "imported Eliza DT schema",
        )
        check(tree / ".config", "external Linux .config")
        if (tree / ".config").is_file():
            config_text = (tree / ".config").read_text(errors="ignore")
            for symbol in ["CONFIG_ELIZA_E1_NPU", "CONFIG_ELIZA_E1_DMA"]:
                ok = symbol in config_text
                checks.append(
                    {"name": f"{symbol} configured", "status": "PASS" if ok else "BLOCKED"}
                )
                if not ok:
                    blockers.append(
                        f"external Linux .config missing {symbol}; run eliza_e1.config olddefconfig after import"
                    )

    cross_compile = os.environ.get("CROSS_COMPILE", "riscv64-linux-gnu-")
    compiler = f"{cross_compile}gcc"
    compiler_ok = command_exists(compiler)
    checks.append(
        {
            "name": "RISC-V Linux cross compiler on PATH",
            "command": compiler,
            "status": "PASS" if compiler_ok else "BLOCKED",
        }
    )
    if not compiler_ok:
        blockers.append(
            f"missing executable {compiler}; set CROSS_COMPILE to a usable RISC-V Linux toolchain prefix"
        )
    make_ok, make_detail = gnu_make_check()
    checks.append(
        {
            "name": "GNU Make version",
            "detail": make_detail,
            "status": "PASS" if make_ok else "BLOCKED",
        }
    )
    if not make_ok:
        blockers.append(f"{make_detail}; Linux requires GNU Make >= 3.82")

    return {
        "target": "linux",
        "tree": tree_text,
        "status": "BLOCKED" if blockers else "READY_TO_CAPTURE",
        "checks": checks,
        "blockers": blockers,
        "commands": capture_plan_commands(
            "linux",
            buildroot=None,
            linux=tree_text,
            opensbi=None,
            u_boot=None,
            aosp=None,
            target_host=target_host,
            opensbi_handoff_cmd=None,
            qemu_smoke_cmd=None,
            renode_smoke_cmd=None,
        ),
    }


def buildroot_preflight(tree: Path | None, target_host: str | None) -> dict[str, Any]:
    blockers: list[str] = []
    checks: list[dict[str, Any]] = []
    tree_text = str(tree) if tree else "/path/to/buildroot"

    if tree is None:
        blockers.append(
            "BUILDROOT_TREE not supplied and no local Buildroot checkout was discovered"
        )
    else:
        for rel_path, description in [
            ("Makefile", "Buildroot Makefile"),
            ("configs", "Buildroot configs directory"),
        ]:
            path = tree / rel_path
            ok = path.exists()
            checks.append(
                {"name": description, "path": str(path), "status": "PASS" if ok else "BLOCKED"}
            )
            if not ok:
                blockers.append(f"missing {description}: {path}")
        images = tree / "output/images"
        ok = images.is_dir()
        checks.append(
            {
                "name": "Buildroot output/images directory",
                "path": str(images),
                "status": "PASS" if ok else "BLOCKED",
            }
        )
        if not ok:
            blockers.append(
                "Buildroot output/images is absent; run the external Buildroot image build before image-manifest capture"
            )

    linux_tarball = ROOT / "sw/linux-external.tar.xz"
    ok = linux_tarball.is_file()
    checks.append(
        {
            "name": "external Linux tarball for Buildroot",
            "path": str(linux_tarball),
            "status": "PASS" if ok else "BLOCKED",
        }
    )
    if not ok:
        blockers.append(
            f"missing {linux_tarball}; Buildroot defconfig cannot consume a BSP kernel source archive"
        )
    make_ok, make_detail = gnu_make_check()
    checks.append(
        {
            "name": "GNU Make version",
            "detail": make_detail,
            "status": "PASS" if make_ok else "BLOCKED",
        }
    )
    if not make_ok:
        blockers.append(f"{make_detail}; Buildroot requires GNU Make >= 3.82")

    return {
        "target": "buildroot",
        "tree": tree_text,
        "status": "BLOCKED" if blockers else "READY_TO_CAPTURE",
        "checks": checks,
        "blockers": blockers,
        "commands": capture_plan_commands(
            "buildroot",
            buildroot=tree_text,
            linux=None,
            opensbi=None,
            u_boot=None,
            aosp=None,
            target_host=target_host,
            opensbi_handoff_cmd=None,
            qemu_smoke_cmd=None,
            renode_smoke_cmd=None,
        ),
    }


def opensbi_preflight(tree: Path | None, handoff_cmd: str | None) -> dict[str, Any]:
    blockers: list[str] = []
    checks: list[dict[str, Any]] = []
    tree_text = str(tree) if tree else "/path/to/opensbi"

    if tree is None:
        blockers.append("OPENSBI_TREE not supplied and external/opensbi was not found")
    else:
        for rel_path, description in [
            ("Makefile", "OpenSBI Makefile"),
            ("lib", "OpenSBI lib directory"),
            ("firmware/fw_dynamic.S", "OpenSBI fw_dynamic source"),
        ]:
            path = tree / rel_path
            ok = path.exists()
            checks.append(
                {"name": description, "path": str(path), "status": "PASS" if ok else "BLOCKED"}
            )
            if not ok:
                blockers.append(f"missing {description}: {path}")
        imported_platform = tree / "platform/eliza/config.mk"
        checks.append(
            {
                "name": "optional imported Eliza OpenSBI platform",
                "path": str(imported_platform),
                "status": "PASS" if imported_platform.is_file() else "BLOCKED",
            }
        )
        if not imported_platform.is_file():
            blockers.append(
                "Eliza OpenSBI platform is not imported; copy sw/opensbi/platform/eliza to platform/eliza if building PLATFORM=eliza"
            )

    compiler_ok = any_command_exists(["riscv64-unknown-elf-gcc", "riscv64-linux-gnu-gcc"])
    checks.append(
        {
            "name": "RISC-V OpenSBI cross compiler on PATH",
            "status": "PASS" if compiler_ok else "BLOCKED",
        }
    )
    if not compiler_ok:
        blockers.append("missing riscv64-unknown-elf-gcc or riscv64-linux-gnu-gcc on PATH")
    make_ok, make_detail = gnu_make_check()
    checks.append(
        {
            "name": "GNU Make version",
            "detail": make_detail,
            "status": "PASS" if make_ok else "BLOCKED",
        }
    )
    if not make_ok:
        blockers.append(f"{make_detail}; OpenSBI requires GNU Make >= 3.82")
    if not handoff_cmd:
        blockers.append(
            "ELIZA_OPENSBI_HANDOFF_CMD is not supplied; handoff capture needs the exact QEMU/Renode/board command"
        )

    return {
        "target": "opensbi",
        "tree": tree_text,
        "status": "BLOCKED" if blockers else "READY_TO_CAPTURE",
        "checks": checks,
        "blockers": blockers,
        "commands": capture_plan_commands(
            "opensbi",
            buildroot=None,
            linux=None,
            opensbi=tree_text,
            u_boot=None,
            aosp=None,
            target_host=None,
            opensbi_handoff_cmd=handoff_cmd,
            qemu_smoke_cmd=None,
            renode_smoke_cmd=None,
        ),
    }


def external_preflight_report(args: argparse.Namespace) -> dict[str, Any]:
    names = selected_bsp_targets() if args.target == "all" else [args.target]
    targets: list[dict[str, Any]] = []
    for name in names:
        if name == "linux":
            targets.append(linux_preflight(path_from_arg(args.linux, "linux"), args.target_host))
        elif name == "buildroot":
            buildroot = Path(args.buildroot).expanduser().resolve() if args.buildroot else None
            targets.append(buildroot_preflight(buildroot, args.target_host))
        elif name == "opensbi":
            targets.append(
                opensbi_preflight(path_from_arg(args.opensbi, "opensbi"), args.opensbi_handoff_cmd)
            )
        else:
            targets.append(
                {
                    "target": name,
                    "status": "BLOCKED",
                    "blockers": [
                        f"external-preflight does not auto-discover {name}; use capture-plan for exact commands"
                    ],
                    "commands": capture_plan_commands(
                        name,
                        buildroot=args.buildroot,
                        linux=args.linux,
                        opensbi=args.opensbi,
                        u_boot=args.u_boot,
                        aosp=args.aosp,
                        target_host=args.target_host,
                        opensbi_handoff_cmd=args.opensbi_handoff_cmd,
                        qemu_smoke_cmd=args.qemu_smoke_cmd,
                        renode_smoke_cmd=args.renode_smoke_cmd,
                    ),
                }
            )
    status = (
        "READY_TO_CAPTURE" if all(t["status"] == "READY_TO_CAPTURE" for t in targets) else "BLOCKED"
    )
    return {
        "schema": "eliza.software_bsp_external_preflight.v1",
        "generated_utc": utc_now(),
        "claim_boundary": "environment_preflight_only_not_external_build_boot_or_runtime_evidence",
        "status": status,
        "host": {
            "platform": sys.platform,
            "cwd": str(ROOT),
        },
        "targets": targets,
    }


def run_external_preflight(args: argparse.Namespace) -> int:
    report = external_preflight_report(args)
    output_report = provenance_safe_value(report)
    if args.write_report:
        output = Path(args.output).expanduser() if args.output else LOCAL_EXTERNAL_PREFLIGHT_REPORT
        if not output.is_absolute():
            output = ROOT / output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(output_report, indent=2, sort_keys=True) + "\n")
        print(f"wrote {rel(output)}")
    if args.json:
        print(json.dumps(output_report, indent=2, sort_keys=True))
    else:
        print(f"external BSP preflight: {report['status']}")
        for target in output_report["targets"]:
            print(f"{target['target']}: {target['status']}")
            for blocker in target.get("blockers", []):
                print(f"  [BLOCKED] {blocker}")
            for command in target.get("commands", []):
                print(f"  command: {command}")
    return 0 if report["status"] == "READY_TO_CAPTURE" else 2


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "external-preflight":
        parser = argparse.ArgumentParser()
        parser.add_argument("command", choices=["external-preflight"])
        parser.add_argument("target", choices=[*TARGETS.keys(), "all"], nargs="?", default="all")
        parser.add_argument("--buildroot")
        parser.add_argument("--linux")
        parser.add_argument("--opensbi")
        parser.add_argument("--u-boot", dest="u_boot")
        parser.add_argument("--aosp")
        parser.add_argument("--target-host")
        parser.add_argument("--opensbi-handoff-cmd")
        parser.add_argument("--qemu-smoke-cmd")
        parser.add_argument("--renode-smoke-cmd")
        parser.add_argument("--write-report", action="store_true")
        parser.add_argument(
            "--output",
            default=str(LOCAL_EXTERNAL_PREFLIGHT_REPORT.relative_to(ROOT)),
            help="Repo-relative or absolute JSON report path.",
        )
        parser.add_argument("--json", action="store_true")
        args = parser.parse_args()
        return run_external_preflight(args)

    if len(sys.argv) > 1 and sys.argv[1] == "status":
        parser = argparse.ArgumentParser()
        parser.add_argument("command", choices=["status"])
        parser.add_argument("target", choices=[*TARGETS.keys(), "all"])
        parser.add_argument("--json", action="store_true")
        args = parser.parse_args()
        names = selected_bsp_targets() if args.target == "all" else [args.target]
        if args.json:
            reports = [target_report(name) for name in names]
            print(
                json.dumps(
                    {"schema": "eliza.software_bsp_status.v1", "targets": reports},
                    indent=2,
                    sort_keys=True,
                )
            )
            return 2 if any(report["evidence_status"] != "PASS" for report in reports) else 0
        statuses = [print_status(name) for name in names]
        return max(statuses) if statuses else 0

    if len(sys.argv) > 1 and sys.argv[1] == "capture-plan":
        parser = argparse.ArgumentParser()
        parser.add_argument("command", choices=["capture-plan"])
        parser.add_argument("target", choices=[*TARGETS.keys(), "all"])
        parser.add_argument("--buildroot")
        parser.add_argument("--linux")
        parser.add_argument("--opensbi")
        parser.add_argument("--u-boot", dest="u_boot")
        parser.add_argument("--aosp")
        parser.add_argument("--target-host")
        parser.add_argument("--opensbi-handoff-cmd")
        parser.add_argument("--qemu-smoke-cmd")
        parser.add_argument("--renode-smoke-cmd")
        args = parser.parse_args()
        print_capture_plan(args)
        return 0

    parser = argparse.ArgumentParser()
    parser.add_argument("target", choices=[*TARGETS.keys(), "all"])
    parser.add_argument(
        "--scaffold-only",
        action="store_true",
        help="Check only repo-local scaffold files and ignore external build/boot evidence.",
    )
    parser.add_argument(
        "--require-evidence",
        action="store_true",
        help="Return nonzero when external build/boot evidence logs are missing.",
    )
    parser.add_argument(
        "--evidence-plan",
        action="store_true",
        help="Print the expected external evidence files, commands, provenance fields, and parser markers.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable scaffold/evidence status and blockers.",
    )
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help="Write the structured BSP scaffold/evidence report to this path.",
    )
    args = parser.parse_args()

    names = selected_bsp_targets() if args.target == "all" else [args.target]
    if args.json:
        reports = [target_report(name) for name in names]
        print(
            json.dumps(
                {"schema": "eliza.software_bsp_status.v1", "targets": reports},
                indent=2,
                sort_keys=True,
            )
        )
        evidence_required = args.require_evidence and not args.scaffold_only
        return (
            1
            if any(
                report["errors"]
                or (
                    evidence_required and (report["missing_evidence"] or report["invalid_evidence"])
                )
                for report in reports
            )
            else 0
        )

    if args.evidence_plan:
        for name in names:
            print_evidence_plan(name)
        return 0

    failed = False
    results: list[dict[str, Any]] = []
    for name in names:
        errors, blockers = check_target(name)
        scaffold = subprocess.run(
            [sys.executable, "sw/check_bsp_scaffolds.py", name],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if scaffold.stdout:
            print(scaffold.stdout, end="")
        if scaffold.stderr:
            print(scaffold.stderr, end="", file=sys.stderr)
        if scaffold.returncode:
            errors.append(f"{name} scaffold audit failed")
        results.append(
            {
                "target": name,
                "scaffold_status": "FAIL" if errors else "PASS",
                "evidence_status": "BLOCKED" if blockers else "PASS",
                "errors": errors,
                "blockers": blockers,
            }
        )
        evidence_required = args.require_evidence and not args.scaffold_only
        if errors or (blockers and evidence_required):
            failed = True
            print(f"{name} BSP check failed:")
            for error in errors:
                print(f"  - {error}")
            if evidence_required:
                for blocker in blockers:
                    print(f"  - {blocker}")
        else:
            if blockers:
                print(f"{name} BSP scaffold check passed; external evidence remains BLOCKED.")
            else:
                print(f"{name} BSP scaffold and evidence checks passed.")
        if blockers:
            if args.scaffold_only:
                print(f"{name} BSP external evidence pending")
            else:
                print(f"{name} BSP external evidence blocked:")
                for blocker in blockers:
                    print(f"  - {blocker}")
            for item in evidence_items_for_target(name):
                if not (ROOT / item["path"]).is_file():
                    print(f"  - missing {item['path']}")
                    print(f"    capture: {item.get('capture_command', '')}")
                    print(
                        "    validate: "
                        + item.get(
                            "validation_command",
                            f"python3 scripts/check_software_bsp.py {name} --require-evidence",
                        )
                    )

    write_scaffold_report(
        build_scaffold_report(
            target=args.target,
            scaffold_only=args.scaffold_only,
            require_evidence=args.require_evidence,
            results=results,
        ),
        Path(args.report),
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
