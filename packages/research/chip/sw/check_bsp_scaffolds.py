#!/usr/bin/env python3
"""CLI audit for owned Android/Linux/Buildroot BSP scaffolds.

This script is intentionally repo-local and read-only. It does not replace the
top-level make targets; it gives BSP owners one command that classifies every
checked-in scaffold as either locally executable or externally blocked.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


CHECKS = {
    "linux": {
        "local": "make linux-bsp-check",
        "expected": "linux BSP check passed.",
        "blocker": "external Linux kernel checkout plus integration of drivers/misc/eliza-e1",
        "files": [
            "docs/android/bsp-artifact-manifest.json",
            "docs/android/bsp-log-evidence-manifest.json",
            "docs/sw/linux/README.md",
            "sw/linux/scripts/import-linux-bsp.sh",
            "sw/linux/dts/eliza-e1.dts",
            "sw/linux/drivers/e1/e1_platform_contract.h",
            "sw/linux/drivers/e1/Kconfig",
            "sw/linux/drivers/e1/Makefile",
            "sw/linux/drivers/e1/e1-npu.c",
            "sw/linux/drivers/e1/e1-dma.c",
            "sw/linux/tests/e1-mmio-smoke.c",
        ],
        "terms": [
            "host_checkable_manifest_only_not_boot_evidence",
            "expected_future_log_markers_only_not_boot_evidence",
            "sw/platform/e1_platform_contract.json",
            "E1_NPU_BASE",
            "E1_DMA_BASE",
            "E1_DISPLAY_BASE",
            "eliza,e1-npu",
            "eliza,e1-dma",
            "eliza,e1-display",
        ],
    },
    "buildroot": {
        "local": "make buildroot-check",
        "expected": "buildroot BSP check passed.",
        "blocker": "external Buildroot checkout and external Linux kernel tarball/tree",
        "files": [
            "docs/android/bsp-artifact-manifest.json",
            "docs/android/bsp-log-evidence-manifest.json",
            "docs/sw/buildroot/README.md",
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
        "terms": [
            "host_checkable_manifest_only_not_boot_evidence",
            "expected_future_log_markers_only_not_boot_evidence",
            "sw/platform/e1_platform_contract.json",
            "BR2_EXTERNAL_ELIZA_E1_PATH",
            "BR2_PACKAGE_E1_MMIO_SMOKE",
            "BR2_PACKAGE_E1_NPU_ML_SMOKE",
            "E1_NPU_BASE",
            "E1_DMA_BASE",
            "E1_DISPLAY_BASE",
        ],
    },
    "aosp": {
        "local": "make aosp-bsp-check",
        "expected": "aosp BSP check passed.",
        "blocker": "external AOSP checkout with riscv64/Cuttlefish host dependencies and HAL binaries",
        "files": [
            "docs/android/bsp-artifact-manifest.json",
            "docs/android/bsp-log-evidence-manifest.json",
            "docs/android/boot-transcript.schema.json",
            "docs/sw/aosp-device/README.md",
            "sw/aosp-device/import-aosp-device.sh",
            "sw/aosp-device/manifests/eliza-ai-soc-local.xml",
            "sw/aosp-device/device/eliza/eliza_ai_soc/AndroidProducts.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/eliza_ai_soc.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/device.mk",
            "sw/aosp-device/device/eliza/eliza_ai_soc/init.eliza.rc",
            "sw/aosp-device/device/eliza/eliza_ai_soc/fstab.eliza",
            "sw/aosp-device/device/eliza/eliza_ai_soc/manifest.xml",
            "sw/aosp-device/device/eliza/eliza_ai_soc/kernel/eliza_ai_soc.fragment",
            "sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts",
            "sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/file_contexts",
            "sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/e1_npu.te",
            "docs/sw/aosp-device/device/eliza/eliza_ai_soc/hal/README.md",
        ],
        "terms": [
            "host_checkable_manifest_only_not_boot_evidence",
            "expected_future_log_markers_only_not_boot_evidence",
            "sw/platform/e1_platform_contract.json",
            "eliza_ai_soc",
            "e1_npu",
            "hwcomposer",
            "vendorimage",
            "cuttlefish_riscv64",
            "qemu_riscv64",
            "renode_e1_soc",
        ],
    },
    "boot": {
        "local": "make software-bsp-check",
        "expected": "buildroot BSP check passed.; linux BSP check passed.; aosp BSP check passed.",
        "blocker": "CPU-capable SoC integration with RAM, UART, timer, interrupt controller, OpenSBI handoff",
        "files": [
            "docs/sw/opensbi/README.md",
            "docs/sw/u-boot/README.md",
        ],
        "terms": [
            "sw/platform/e1_platform_contract.json",
            "dependency blocker",
            "expected output",
        ],
    },
    "opensbi": {
        "local": "python3 scripts/check_software_bsp.py opensbi --scaffold-only",
        "expected": "opensbi BSP scaffold check passed; external evidence remains BLOCKED.",
        "blocker": "external OpenSBI checkout plus simulator or board fw_dynamic handoff transcript",
        "files": [
            "docs/sw/opensbi/README.md",
            "docs/sw/opensbi/capture-opensbi-evidence.sh",
            "sw/opensbi/scripts/import-opensbi-platform.sh",
            "sw/opensbi/platform/eliza/README.md",
            "sw/opensbi/platform/eliza/config.mk",
            "sw/opensbi/platform/eliza/objects.mk",
            "sw/opensbi/platform/eliza/platform.c",
        ],
        "terms": [
            "sw/platform/e1_platform_contract.json",
            "OpenSBI",
            "fw_dynamic",
            "PLATFORM=eliza",
            "FW_PAYLOAD",
        ],
    },
    "u-boot": {
        "local": "python3 scripts/check_software_bsp.py u-boot --scaffold-only",
        "expected": "u-boot BSP scaffold check passed; external evidence remains BLOCKED.",
        "blocker": "external U-Boot checkout plus generated AP OpenSBI-to-U-Boot boot-chain transcript",
        "files": [
            "docs/android/bsp-artifact-manifest.json",
            "docs/sw/u-boot/README.md",
            "docs/sw/u-boot/capture-u-boot-evidence.sh",
        ],
        "terms": [
            "host_checkable_manifest_only_not_boot_evidence",
            "sw/platform/e1_platform_contract.json",
            "U-Boot",
            "OpenSBI",
            "ELIZA_UBOOT_CMD",
            "ELIZA_UBOOT_BOOT_CMD",
        ],
    },
}


def read_joined(files: Sequence[str]) -> str:
    return "\n".join(
        (ROOT / path).read_text(errors="ignore") for path in files if (ROOT / path).is_file()
    )


def check(name: str) -> list[str]:
    spec = CHECKS[name]
    errors: list[str] = []

    missing = [path for path in spec["files"] if not (ROOT / path).is_file()]
    if missing:
        errors.append("missing files: " + ", ".join(missing))
        return errors

    text = read_joined(spec["files"]).lower()
    missing_terms = [term for term in spec["terms"] if term.lower() not in text]
    if missing_terms:
        errors.append("missing scaffold terms: " + ", ".join(missing_terms))

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", choices=[*CHECKS.keys(), "all"], nargs="?", default="all")
    args = parser.parse_args()

    names = CHECKS.keys() if args.target == "all" else [args.target]
    failed = False

    for name in names:
        errors = check(name)
        spec = CHECKS[name]
        print(f"{name}: scaffold audit")
        print(f"  local command: {spec['local']}")
        print(f"  expected output: {spec['expected']}")
        print(f"  dependency blocker: {spec['blocker']}")
        if errors:
            failed = True
            for error in errors:
                print(f"  error: {error}")
        else:
            print("  status: clear")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
