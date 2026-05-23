#!/usr/bin/env python3
"""Static AOSP product-composition gate for the chip/OS boot objective.

This gate checks whether the selected chip Android product can plausibly boot
to the Eliza launcher with the OS vendor layer and HAL contracts installed. It
does not build or boot AOSP; it fails closed on product-selection drift that
would make later boot evidence target the wrong image.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
CHIP_AOSP = ROOT / "sw/aosp-device"
CHIP_DEVICE = CHIP_AOSP / "device/eliza/eliza_ai_soc"
OS_VENDOR = WORKSPACE / "os/android/vendor/eliza"

BUILD_SCRIPT = CHIP_AOSP / "build-aosp-riscv64.sh"
BOOT_SCRIPT = ROOT / "scripts/boot_android_simulator.sh"
CAPTURE_SCRIPT = CHIP_AOSP / "capture-aosp-evidence.sh"
LOCAL_MANIFEST = CHIP_AOSP / "local_manifests/eliza.xml"
CHIP_PRODUCT = CHIP_DEVICE / "eliza_ai_soc.mk"
CHIP_DEVICE_MK = CHIP_DEVICE / "device.mk"
CHIP_BOARD = CHIP_DEVICE / "BoardConfig.mk"
CHIP_MANIFEST = CHIP_DEVICE / "manifest.xml"
OS_ANDROID_PRODUCTS = OS_VENDOR / "AndroidProducts.mk"
OS_COMMON = OS_VENDOR / "eliza_common.mk"
OS_OPENAGENT_PRODUCT = OS_VENDOR / "products/eliza_openagent_ai_soc_phone.mk"
REPORT = ROOT / "build/reports/aosp_product_contract.json"

SCHEMA = "eliza.aosp_product_contract.v1"
CLAIM_BOUNDARY = "static_aosp_product_contract_only_not_android_boot_or_launcher_evidence"

ELIZA_FUSED_PRODUCT = "eliza_openagent_ai_soc_phone-trunk_staging-userdebug"
CHIP_SCAFFOLD_PRODUCT = "eliza_ai_soc-trunk_staging-userdebug"
UPSTREAM_CF_PRODUCT = "aosp_cf_riscv64_phone-trunk_staging-userdebug"
OS_ELIZA_CF_PRODUCT = "eliza_cf_riscv64_phone-trunk_staging-userdebug"
REQUIRED_OS_CF_PRODUCTS = {
    "eliza_cf_arm64_phone-trunk_staging-userdebug",
    "eliza_cf_x86_64_phone-trunk_staging-userdebug",
    "eliza_cf_riscv64_phone-trunk_staging-userdebug",
}
REQUIRED_ELIZA_PACKAGES = {
    "Eliza",
    "default-permissions-ai.elizaos.app.xml",
    "privapp-permissions-ai.elizaos.app.xml",
}
REQUIRED_HAL_PACKAGES = {
    "vendor.eliza.e1_npu@1.0-service",
    "android.hardware.graphics.composer@2.4-service.eliza_ai_soc",
}


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def makefile_product_packages(text: str) -> set[str]:
    packages: set[str] = set()
    active = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            active = False
            continue
        if "PRODUCT_PACKAGES" in line and ("+=" in line or "-=" in line):
            active = "+=" in line
            rhs = line.split("+=", 1)[1] if "+=" in line else ""
        elif active:
            rhs = line
        else:
            continue
        continued = rhs.endswith("\\")
        rhs = rhs.rstrip("\\").strip()
        packages.update(part for part in rhs.split() if part)
        active = continued and active
    return packages


def inherit_products(text: str) -> set[str]:
    return set(re.findall(r"inherit-product,\s*([^) \t]+)", text))


def shell_default(text: str, var_name: str) -> str | None:
    match = re.search(rf"^{re.escape(var_name)}=[\"']?([^\"'\n]+)[\"']?", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def shell_env_default(text: str, var_name: str) -> str | None:
    match = re.search(
        rf"^{re.escape(var_name.lower())}=\$\{{{re.escape(var_name)}:-([^}}]+)\}}",
        text,
        re.MULTILINE,
    )
    return match.group(1).strip() if match else None


def local_manifest_dests(path: Path) -> set[str]:
    root = ElementTree.fromstring(read_text(path))
    return {
        element.attrib["dest"]
        for element in root.findall(".//linkfile")
        if "dest" in element.attrib
    }


def manifest_hal_names(path: Path) -> set[str]:
    root = ElementTree.fromstring(read_text(path))
    names: set[str] = set()
    for hal in root.findall("hal"):
        name = hal.findtext("name")
        if name:
            names.add(name.strip())
    return names


def contains_allow_missing_dependencies(text: str) -> bool:
    return bool(re.search(r"^\s*ALLOW_MISSING_DEPENDENCIES\s*:=\s*true\b", text, re.MULTILINE))


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


def run_check(args: argparse.Namespace) -> dict[str, object]:
    inputs = (
        BUILD_SCRIPT,
        BOOT_SCRIPT,
        CAPTURE_SCRIPT,
        LOCAL_MANIFEST,
        CHIP_PRODUCT,
        CHIP_DEVICE_MK,
        CHIP_BOARD,
        CHIP_MANIFEST,
        OS_ANDROID_PRODUCTS,
        OS_COMMON,
        OS_OPENAGENT_PRODUCT,
    )
    findings: list[Finding] = []
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required AOSP product contract input is missing",
            rel(path),
            "Restore the missing chip/OS Android product input before claiming launcher boot readiness.",
        )
    if findings:
        return payload(findings, {})

    build_text = read_text(BUILD_SCRIPT)
    boot_text = read_text(BOOT_SCRIPT)
    capture_text = read_text(CAPTURE_SCRIPT)
    chip_product_text = read_text(CHIP_PRODUCT)
    chip_device_text = read_text(CHIP_DEVICE_MK)
    board_text = read_text(CHIP_BOARD)
    os_products_text = read_text(OS_ANDROID_PRODUCTS)
    os_common_text = read_text(OS_COMMON)
    openagent_text = read_text(OS_OPENAGENT_PRODUCT)

    build_default = shell_default(build_text, "LUNCH_TARGET")
    boot_aosp_product = shell_env_default(boot_text, "AOSP_PRODUCT")
    boot_cuttlefish_product = shell_env_default(boot_text, "AOSP_CUTTLEFISH_PRODUCT")
    capture_aosp_product = shell_env_default(capture_text, "AOSP_PRODUCT")
    capture_cuttlefish_product = shell_env_default(capture_text, "AOSP_CUTTLEFISH_PRODUCT")
    chip_inherits = inherit_products(chip_product_text)
    openagent_inherits = inherit_products(openagent_text)
    chip_packages = makefile_product_packages(chip_device_text)
    os_common_packages = makefile_product_packages(os_common_text)
    chip_inherits_eliza_common = "vendor/eliza/eliza_common.mk" in chip_inherits
    effective_chip_packages = chip_packages | (
        os_common_packages if chip_inherits_eliza_common else set()
    )
    local_dests = local_manifest_dests(LOCAL_MANIFEST)
    chip_manifest_hals = manifest_hal_names(CHIP_MANIFEST)

    os_product_choices = set(
        re.findall(r"^\s*([A-Za-z0-9_]+-trunk_staging-userdebug)\b", os_products_text, re.MULTILINE)
    )
    build_targets = {
        value
        for value in (
            build_default,
            boot_aosp_product,
            boot_cuttlefish_product,
            capture_aosp_product,
            capture_cuttlefish_product,
        )
        if value
    }

    add_if(
        findings,
        build_default != ELIZA_FUSED_PRODUCT,
        "aosp_build_default_not_fused_eliza_chip_product",
        "chip AOSP build script defaults to a product that does not fuse the Eliza vendor layer with the chip device tree",
        f"LUNCH_TARGET={build_default!r}",
        f"Use {ELIZA_FUSED_PRODUCT} for chip-emulator launcher claims, or record a separate reference-Cuttlefish claim boundary.",
    )
    add_if(
        findings,
        ELIZA_FUSED_PRODUCT not in build_targets,
        "aosp_boot_flow_not_selecting_fused_product",
        "chip Android boot/build defaults do not select the fused Eliza OpenAgent AI SoC product",
        json.dumps(
            {
                "build_default": build_default,
                "boot_aosp_product": boot_aosp_product,
                "boot_cuttlefish_product": boot_cuttlefish_product,
            },
            sort_keys=True,
        ),
        "Make the boot evidence flow select the fused product or explicitly block launcher claims for scaffold/reference products.",
    )
    add_if(
        findings,
        capture_aosp_product != ELIZA_FUSED_PRODUCT,
        "aosp_capture_default_not_fused_eliza_product",
        "AOSP evidence capture defaults to a product different from the fused Eliza chip-emulator product",
        f"capture_aosp_product={capture_aosp_product!r}",
        "Make capture-aosp-evidence.sh default to the same fused product used by build/boot flows before accepting its logs as launcher or chip-emulator evidence.",
    )
    add_if(
        findings,
        capture_cuttlefish_product != OS_ELIZA_CF_PRODUCT,
        "aosp_capture_cuttlefish_default_not_eliza_product",
        "AOSP evidence capture Cuttlefish default is an upstream reference product rather than the Eliza Cuttlefish product",
        f"capture_cuttlefish_product={capture_cuttlefish_product!r}",
        "Use the Eliza Cuttlefish product for reference Cuttlefish smoke, and keep upstream aosp_cf evidence explicitly out of Eliza launcher readiness claims.",
    )
    add_if(
        findings,
        "vendor/eliza/eliza_common.mk" not in chip_inherits,
        "chip_product_missing_eliza_vendor_layer",
        "chip eliza_ai_soc product does not inherit vendor/eliza/eliza_common.mk",
        f"inherits={sorted(chip_inherits)}",
        "Use the fused OS product for launcher claims or make the chip product inherit the Eliza vendor layer.",
    )
    add_if(
        findings,
        bool(REQUIRED_ELIZA_PACKAGES - effective_chip_packages),
        "chip_product_missing_eliza_privapp_packages",
        "chip eliza_ai_soc product does not install the Eliza privileged app and permission XML packages",
        f"missing={sorted(REQUIRED_ELIZA_PACKAGES - effective_chip_packages)} effective_packages={sorted(effective_chip_packages)}",
        "Install the Eliza APK, default-permissions XML, and privapp permissions in the selected chip Android product.",
    )
    add_if(
        findings,
        "vendor/eliza/AndroidProducts.mk" not in local_dests
        and "vendor/eliza/eliza_common.mk" not in local_dests,
        "local_manifest_does_not_project_os_vendor_layer",
        "chip local-manifest overlay projects the chip device tree but not the OS vendor/eliza product layer",
        f"projected_dest_count={len(local_dests)}",
        "Project vendor/eliza into the AOSP tree for fused-product builds, or require a separately installed OS vendor checkout.",
    )
    add_if(
        findings,
        ELIZA_FUSED_PRODUCT.replace("-trunk_staging-userdebug", "") not in os_products_text,
        "os_fused_product_not_declared",
        "OS vendor product list does not declare the fused Eliza OpenAgent AI SoC product",
        rel(OS_ANDROID_PRODUCTS),
        "Declare a fused chip-emulator product before using it in chip Android evidence.",
    )
    add_if(
        findings,
        bool(REQUIRED_OS_CF_PRODUCTS - os_product_choices),
        "os_cuttlefish_arch_products_missing",
        "OS vendor product list does not declare all required arm64, x86_64, and riscv64 Cuttlefish products",
        f"missing={sorted(REQUIRED_OS_CF_PRODUCTS - os_product_choices)} choices={sorted(os_product_choices)}",
        "Declare first-class elizaOS Cuttlefish products for arm64, x86_64, and riscv64 before claiming multi-ABI AOSP fork support.",
    )
    add_if(
        findings,
        not {
            "device/eliza/eliza_ai_soc/eliza_ai_soc.mk",
            "vendor/eliza/eliza_common.mk",
        }.issubset(openagent_inherits),
        "os_fused_product_missing_required_inherits",
        "fused OS product does not inherit both the chip device tree and Eliza common product layer",
        f"inherits={sorted(openagent_inherits)}",
        "Keep the fused product inheriting chip BSP first and Eliza common product afterward.",
    )
    add_if(
        findings,
        contains_allow_missing_dependencies(board_text),
        "aosp_allow_missing_dependencies_enabled",
        "chip AOSP BoardConfig enables ALLOW_MISSING_DEPENDENCIES",
        rel(CHIP_BOARD),
        "Remove or narrowly scope ALLOW_MISSING_DEPENDENCIES before claiming the selected product is boot-ready.",
    )
    add_if(
        findings,
        bool(REQUIRED_HAL_PACKAGES - chip_packages),
        "chip_product_missing_active_hal_packages",
        "chip AOSP product does not include active e1 NPU and hwcomposer service packages",
        f"missing={sorted(REQUIRED_HAL_PACKAGES - chip_packages)}",
        "Add HAL service packages only with matching source/prebuilts, VINTF fragments, SELinux policy, and smoke evidence.",
    )
    add_if(
        findings,
        not chip_manifest_hals,
        "chip_vintf_manifest_has_no_active_hals",
        "chip AOSP VINTF manifest has no active HAL entries",
        rel(CHIP_MANIFEST),
        "Declare active HALs only when the selected product installs and starts matching service binaries.",
    )
    add_if(
        findings,
        not REQUIRED_ELIZA_PACKAGES.issubset(os_common_packages),
        "os_common_missing_eliza_packages",
        "OS Eliza common product layer is missing required Eliza packages",
        f"missing={sorted(REQUIRED_ELIZA_PACKAGES - os_common_packages)}",
        "Keep Eliza APK and permission XMLs in the shared OS product layer.",
    )

    evidence = {
        "build_default_lunch_target": build_default,
        "boot_aosp_product": boot_aosp_product,
        "boot_cuttlefish_product": boot_cuttlefish_product,
        "capture_aosp_product": capture_aosp_product,
        "capture_cuttlefish_product": capture_cuttlefish_product,
        "os_product_choices": sorted(os_product_choices),
        "chip_product_inherits": sorted(chip_inherits),
        "os_openagent_inherits": sorted(openagent_inherits),
        "chip_product_packages": sorted(chip_packages),
        "effective_chip_product_packages": sorted(effective_chip_packages),
        "os_common_packages": sorted(os_common_packages),
        "local_manifest_dest_count": len(local_dests),
        "chip_vintf_hals": sorted(chip_manifest_hals),
        "claim_products": {
            "fused_chip_emulator": ELIZA_FUSED_PRODUCT,
            "chip_scaffold": CHIP_SCAFFOLD_PRODUCT,
            "upstream_reference_cuttlefish": UPSTREAM_CF_PRODUCT,
            "os_eliza_reference_cuttlefish": OS_ELIZA_CF_PRODUCT,
            "required_os_cuttlefish_products": sorted(REQUIRED_OS_CF_PRODUCTS),
        },
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} aosp.product_contract")
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
