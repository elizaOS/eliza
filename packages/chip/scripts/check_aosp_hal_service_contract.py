#!/usr/bin/env python3
"""Static AOSP HAL service contract gate.

The chip Android target must not declare a HAL as live unless the selected
product installs the service, init can start it, SELinux has the required
contexts, and the service agrees with the Linux driver ABI.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
import re
import sys
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
DEVICE = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc"
ELIZA_PRODUCT_MK = DEVICE / "eliza_ai_soc.mk"
DEVICE_MK = DEVICE / "device.mk"
BOARD_CONFIG = DEVICE / "BoardConfig.mk"
INIT_RC = DEVICE / "init.eliza.rc"
DEVICE_MANIFEST = DEVICE / "manifest.xml"
E1_MANIFEST = DEVICE / "eliza_e1.xml"
HAL_DIR = DEVICE / "hal/e1_npu"
HAL_BP = HAL_DIR / "Android.bp"
HAL_RC = HAL_DIR / "vendor.eliza.e1_npu@1.0-service.rc"
HAL_IMPL = HAL_DIR / "E1Npu.h"
HAL_IMPL_CC = HAL_DIR / "E1Npu.cpp"
HAL_UAPI = HAL_DIR / "E1NpuUapi.h"
HAL_INTERFACE = HAL_DIR / "1.0/IE1Npu.hal"
HAL_INTERFACE_BP = HAL_DIR / "1.0/Android.bp"
HWC_DIR = DEVICE / "hal/hwcomposer"
HWC_BP = HWC_DIR / "Android.bp"
HWC_IMPL = HWC_DIR / "hwcomposer.cpp"
SIM_HAL_BP = DEVICE / "hal/e1_npu_sim/Android.bp"
SIM_HAL_IMPL = DEVICE / "hal/e1_npu_sim/E1NpuSim.h"
SIM_HAL_RC = DEVICE / "hal/e1_npu_sim/vendor.eliza.e1_npu@1.0-service.sim.rc"
SEPOLICY = DEVICE / "sepolicy"
FILE_CONTEXTS = SEPOLICY / "file_contexts"
E1_NPU_TE = SEPOLICY / "e1_npu.te"
LINUX_CONTRACT_HEADER = ROOT / "sw/linux/drivers/e1/e1_platform_contract.h"
LINUX_NPU_UAPI_HEADER = ROOT / "sw/linux/drivers/e1/e1-npu-uapi.h"
REPORT = ROOT / "build/reports/aosp_hal_service_contract.json"
SCHEMA = "eliza.aosp_hal_service_contract.v1"
CLAIM_BOUNDARY = "static_aosp_hal_service_contract_only_not_vintf_or_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "vintf_claim_allowed": False,
    "lshal_runtime_claim_allowed": False,
    "npu_driver_liveness_claim_allowed": False,
    "display_hwc_runtime_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
}
E1_NPU_SERVICE_PACKAGE = "vendor.eliza.e1_npu@1.0-service"
HWC_SERVICE_PACKAGE = "android.hardware.graphics.composer@2.4-service.eliza_ai_soc"
MODERN_CUTTLEFISH_GRAPHICS_PACKAGES = (
    "com.android.hardware.graphics.composer.drm_hwcomposer",
    "com.android.hardware.graphics.composer.ranchu",
)
E1_NPU_HAL = "vendor.eliza.e1_npu"


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
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


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


def product_packages(text: str) -> set[str]:
    packages: set[str] = set()
    active = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            active = False
            continue
        if "PRODUCT_PACKAGES" in line and "+=" in line:
            active = True
            rhs = line.split("+=", 1)[1]
        elif active:
            rhs = line
        else:
            continue
        continued = rhs.endswith("\\")
        rhs = rhs.rstrip("\\").strip()
        packages.update(part for part in rhs.split() if part)
        active = continued
    return packages


def manifest_hals(path: Path) -> set[str]:
    root = ElementTree.fromstring(read_text(path))
    names: set[str] = set()
    for hal in root.findall("hal"):
        name = hal.findtext("name")
        if name:
            names.add(name.strip())
    return names


def macro_value(text: str, name: str) -> str | None:
    match = re.search(rf"^#define\s+{re.escape(name)}\s+(0x[0-9a-fA-F]+|\d+)u?", text, re.MULTILINE)
    return match.group(1) if match else None


def cxx_const_offset(text: str, name: str) -> str | None:
    match = re.search(rf"\b{name}\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*;", text)
    return match.group(1) if match else None


def int_from_literal(value: str | None) -> int | None:
    if value is None:
        return None
    return int(value, 0)


def run_check(args: argparse.Namespace) -> dict[str, object]:
    inputs = (
        ELIZA_PRODUCT_MK,
        DEVICE_MK,
        BOARD_CONFIG,
        INIT_RC,
        DEVICE_MANIFEST,
        E1_MANIFEST,
        HAL_BP,
        HAL_RC,
        HAL_IMPL,
        HAL_IMPL_CC,
        HAL_UAPI,
        HAL_INTERFACE,
        HAL_INTERFACE_BP,
        HWC_BP,
        HWC_IMPL,
        SIM_HAL_BP,
        SIM_HAL_IMPL,
        SIM_HAL_RC,
        FILE_CONTEXTS,
        E1_NPU_TE,
        LINUX_CONTRACT_HEADER,
        LINUX_NPU_UAPI_HEADER,
    )
    findings: list[Finding] = []
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required AOSP HAL service contract input is missing",
            rel(path),
            "Restore the AOSP device, HAL, SELinux, and Linux ABI inputs before claiming Android HAL readiness.",
        )
    if findings:
        return payload(findings, {})

    device_mk = read_text(DEVICE_MK)
    product_mk = read_text(ELIZA_PRODUCT_MK)
    board = read_text(BOARD_CONFIG)
    init_rc = read_text(INIT_RC)
    hal_bp = read_text(HAL_BP)
    hal_rc = read_text(HAL_RC)
    hal_impl = read_text(HAL_IMPL)
    hal_impl_cc = read_text(HAL_IMPL_CC)
    hal_uapi = read_text(HAL_UAPI)
    hal_interface = read_text(HAL_INTERFACE)
    hwc_bp = read_text(HWC_BP)
    hwc_impl = read_text(HWC_IMPL)
    sim_hal_bp = read_text(SIM_HAL_BP)
    sim_hal_impl = read_text(SIM_HAL_IMPL)
    sim_hal_rc = read_text(SIM_HAL_RC)
    file_contexts = read_text(FILE_CONTEXTS)
    te = read_text(E1_NPU_TE)
    contract = read_text(LINUX_CONTRACT_HEADER)
    linux_npu_uapi = read_text(LINUX_NPU_UAPI_HEADER)
    interface_bp = read_text(HAL_INTERFACE_BP)
    e1_hal_sources = "\n".join((hal_bp, hal_impl, hal_impl_cc, hal_uapi, hal_interface))
    hwc_sources = "\n".join((hwc_bp, hwc_impl))
    sim_hal_sources = "\n".join((sim_hal_bp, sim_hal_impl, sim_hal_rc))
    packages = product_packages(device_mk)
    inherits_cuttlefish_phone = (
        "device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk" in product_mk
    )
    manifest_hals_declared = manifest_hals(DEVICE_MANIFEST) | manifest_hals(E1_MANIFEST)
    service_declared = E1_NPU_HAL in manifest_hals_declared
    contract_result_offset = int_from_literal(macro_value(contract, "E1_NPU_RESULT_OFFSET"))
    hal_result_offset = int_from_literal(cxx_const_offset(hal_impl, "kResultOffset"))
    runtime_requirements: list[str] = []

    add_if(
        findings,
        service_declared and E1_NPU_SERVICE_PACKAGE not in packages,
        "aosp_e1_npu_vintf_declared_but_service_not_packaged",
        "e1 NPU HAL is declared in VINTF but the chip product does not install its service package",
        f"hals={sorted(manifest_hals_declared)} packages={sorted(packages)}",
        "Add vendor.eliza.e1_npu@1.0-service to the selected product only when it builds, installs, and starts successfully.",
    )
    add_if(
        findings,
        HWC_SERVICE_PACKAGE in packages or "hwcomposer.eliza_ai_soc" in packages,
        "aosp_hwcomposer_deprecated_hidl_service_packaged",
        "chip product packages the deprecated local HIDL composer@2.4 service rejected by FCM 202604",
        f"packages={sorted(packages)}",
        "Use the inherited Cuttlefish composer3 APEX packages for the riscv64 virtual device, or replace the local display path with a composer3/AIDL HAL before declaring it.",
    )
    add_if(
        findings,
        not inherits_cuttlefish_phone and HWC_SERVICE_PACKAGE not in packages,
        "aosp_modern_graphics_composer_source_missing",
        "chip product does not inherit a modern graphics composer source and does not package a local composer",
        rel(ELIZA_PRODUCT_MK),
        "Inherit the Cuttlefish riscv64 phone product or add a non-deprecated composer3 graphics path before claiming Android GUI readiness.",
    )
    add_if(
        findings,
        "DEVICE_MANIFEST_FILE += device/eliza/eliza_ai_soc/eliza_e1.xml" in board
        and E1_NPU_SERVICE_PACKAGE not in packages,
        "aosp_board_includes_e1_vintf_without_package",
        "BoardConfig includes the e1 NPU VINTF fragment while PRODUCT_PACKAGES omits the matching service",
        rel(BOARD_CONFIG),
        "Keep VINTF fragments and PRODUCT_PACKAGES in lockstep so checkvintf/lshal evidence maps to a real binary.",
    )
    add_if(
        findings,
        "setprop vendor.e1_npu.ready 0" in init_rc
        and "setprop vendor.e1_npu.ready 1" not in init_rc,
        "aosp_init_never_enables_e1_npu_hal",
        "init sets vendor.e1_npu.ready=0 but never flips it to 1 for the real HAL",
        rel(INIT_RC),
        "Gate service startup on a real kernel node/probe and emit evidence that vendor.e1_npu.ready reaches 1.",
    )
    add_if(
        findings,
        re.search(r"^\s*disabled\s*$", hal_rc, re.MULTILINE) is not None,
        "aosp_e1_npu_service_disabled_by_default",
        "e1 NPU HAL rc marks the service disabled",
        rel(HAL_RC),
        "Start the HAL through a verified readiness trigger and capture init/lshal evidence, or remove the active VINTF declaration.",
    )
    add_if(
        findings,
        re.search(r"^\s*oneshot\s*$", hal_rc, re.MULTILINE) is not None,
        "aosp_e1_npu_service_oneshot",
        "e1 NPU HAL rc marks a binder HAL service as oneshot",
        rel(HAL_RC),
        "Run binder HALs persistently and prove they remain registered after boot.",
    )
    add_if(
        findings,
        "property_contexts" not in board and not (SEPOLICY / "property_contexts").is_file(),
        "aosp_e1_npu_ready_property_context_missing",
        "vendor.e1_npu.ready is used to gate HAL startup but has no checked-in property_contexts mapping",
        f"board={rel(BOARD_CONFIG)} sepolicy={rel(SEPOLICY)}",
        "Add vendor property context/type rules or avoid property-gated HAL startup.",
    )
    add_if(
        findings,
        "hwservice_contexts" not in board and not (SEPOLICY / "hwservice_contexts").is_file(),
        "aosp_e1_npu_hwservice_context_missing",
        "e1 NPU HIDL service has no checked-in hwservice_contexts mapping",
        f"board={rel(BOARD_CONFIG)} sepolicy={rel(SEPOLICY)}",
        "Add hwservice_contexts and allow rules for vendor.eliza.e1_npu@1.0::IE1Npu/default.",
    )
    add_if(
        findings,
        "hal_server_domain" not in te,
        "aosp_e1_npu_selinux_lacks_hal_server_domain",
        "SELinux policy defines a custom domain but does not attach it to a HAL server domain",
        rel(E1_NPU_TE),
        "Use standard HAL domain macros and validate with neverallow/VTS evidence.",
    )
    add_if(
        findings,
        contract_result_offset != hal_result_offset,
        "aosp_e1_npu_hal_result_offset_mismatch",
        "e1 NPU HAL reads a different result offset than the Linux driver/platform contract",
        f"linux_E1_NPU_RESULT_OFFSET={contract_result_offset} hal_kResultOffset={hal_result_offset}",
        "Generate HAL constants from the same platform contract header used by the Linux driver.",
    )
    uapi_sync_tokens = (
        "struct e1_npu_contract",
        "struct e1_npu_cmd",
        "struct e1_npu_gemm_s8",
        "E1_NPU_IOC_RUN_CMD",
        "E1_NPU_IOC_RUN_GEMM_S8",
        "E1_NPU_IOC_GET_CONTRACT",
        "E1_NPU_OP_RELU4_S8 10u",
        "E1_NPU_SCRATCH_BYTES 64u",
    )
    add_if(
        findings,
        not all(token in hal_uapi and token in linux_npu_uapi for token in uapi_sync_tokens),
        "aosp_e1_npu_hal_uapi_not_synced_with_linux",
        "e1 NPU HAL local userspace ABI copy does not match the Linux driver UAPI tokens needed by smoke()",
        f"{rel(HAL_UAPI)}, {rel(LINUX_NPU_UAPI_HEADER)}",
        "Keep E1NpuUapi.h synchronized with sw/linux/drivers/e1/e1-npu-uapi.h or import the generated kernel UAPI header directly.",
    )
    add_if(
        findings,
        not (
            "hidl_interface" in interface_bp
            and 'name: "vendor.eliza.e1_npu@1.0"' in interface_bp
            and '"IE1Npu.hal"' in interface_bp
            and '"types.hal"' in interface_bp
            and 'root: "vendor.eliza.e1_npu"' in interface_bp
        ),
        "aosp_e1_npu_hidl_interface_not_packaged",
        "e1 NPU HIDL interface package is not generated from the checked-in IE1Npu.hal/types.hal sources",
        rel(HAL_INTERFACE_BP),
        "Add the HIDL interface package/import path to the external AOSP tree and gate hidl-gen/build evidence.",
    )
    hal_kernel_smoke = (
        'static constexpr const char* kDevicePath = "/dev/e1-npu"' in hal_impl
        and "O_RDWR | O_CLOEXEC" in hal_impl_cc
        and "Status::NOT_SUPPORTED" in hal_impl_cc
        and "E1_NPU_IOC_GET_CONTRACT" in hal_impl_cc
        and "E1_NPU_IOC_RUN_CMD" in hal_impl_cc
        and "E1_NPU_IOC_RUN_GEMM_S8" in hal_impl_cc
        and "E1_NPU_OP_RELU4_S8" in hal_impl_cc
        and "0x800700fcu" in hal_impl_cc
        and "0x00070000u" in hal_impl_cc
        and "kExpectedGemm[4] = {-44, 8, 139, -54}" in hal_impl_cc
        and "contract.npu_base" in hal_impl_cc
        and "E1_NPU_SCRATCH_BYTES 64u" in hal_uapi
        and "E1_NPU_IOC_GET_CONTRACT" in hal_uapi
        and "E1_NPU_IOC_RUN_GEMM_S8" in hal_uapi
        and "::read(fd.get(), &identity, sizeof(identity))" not in hal_impl_cc
        and "kSimulatedIdentity" not in e1_hal_sources
    )
    add_if(
        findings,
        not hal_kernel_smoke,
        "aosp_e1_npu_hal_not_fail_closed_to_kernel_node",
        "e1 NPU HAL does not prove a fail-closed fixed-vector ioctl smoke path to /dev/e1-npu",
        f"{rel(HAL_IMPL)}, {rel(HAL_IMPL_CC)}, {rel(HAL_UAPI)}",
        "Keep the HAL backed by /dev/e1-npu, return NOT_SUPPORTED when the node is absent, run the contract/RELU/GEMM ioctls, and avoid simulator constants in the real HAL.",
    )
    if "smoke() generates" in hal_interface:
        runtime_requirements.append(
            "Booted selected chip target must capture IE1Npu/default lshal registration and smoke() fixed-vector contract/RELU/GEMM ioctl pass against /dev/e1-npu before NPU liveness is unblocked."
        )
    if inherits_cuttlefish_phone:
        runtime_requirements.append(
            "Display readiness uses the inherited Cuttlefish composer3 APEX packages; booted evidence must prove SurfaceFlinger selects the expected composer3 service on the chip/riscv64 target."
        )
    if HWC_SERVICE_PACKAGE in packages and "getFunction = nullptr" in hwc_sources:
        runtime_requirements.append(
            "Display readiness remains blocked until booted SurfaceFlinger/HWC evidence proves the selected product renders through the intended graphics path."
        )
    add_if(
        findings,
        not (
            'name: "vendor.eliza.e1_npu@1.0-service.sim"' in sim_hal_bp
            and "service vendor.e1_npu_sim /vendor/bin/hw/vendor.eliza.e1_npu@1.0-service.sim"
            in sim_hal_rc
            and "kSimulatedIdentity" in sim_hal_impl
            and E1_NPU_SERVICE_PACKAGE in packages
            and "vendor.eliza.e1_npu@1.0-service.sim" not in packages
        ),
        "aosp_cuttlefish_sim_hal_not_separated_from_real_product",
        "Cuttlefish simulator HAL is not clearly separated from the real chip product package/startup path",
        f"{rel(SIM_HAL_BP)}, {rel(SIM_HAL_IMPL)}",
        "Keep the simulator binary/package distinct and require evidence to identify whether lshal was captured from sim or chip target.",
    )
    if "software-simulator" in sim_hal_sources:
        runtime_requirements.append(
            "Cuttlefish simulator HAL evidence must be labeled simulator-only and must not satisfy chip /dev/e1-npu liveness."
        )
    add_if(
        findings,
        "/dev/e1-npu" in init_rc and "/dev/e1-npu" not in file_contexts,
        "aosp_e1_npu_device_context_missing",
        "init manages /dev/e1-npu but file_contexts does not label it",
        rel(FILE_CONTEXTS),
        "Label /dev/e1-npu and capture denial-free logcat after boot.",
    )

    evidence = {
        "product_mk": rel(ELIZA_PRODUCT_MK),
        "device_mk": rel(DEVICE_MK),
        "board_config": rel(BOARD_CONFIG),
        "init_rc": rel(INIT_RC),
        "manifest_hals": sorted(manifest_hals_declared),
        "product_packages": sorted(packages),
        "linux_result_offset": contract_result_offset,
        "linux_npu_uapi": rel(LINUX_NPU_UAPI_HEADER),
        "hal_result_offset": hal_result_offset,
        "hal_uapi": rel(HAL_UAPI),
        "hal_rc": rel(HAL_RC),
        "hal_interface": rel(HAL_INTERFACE),
        "inherits_cuttlefish_phone": inherits_cuttlefish_phone,
        "inherited_graphics_packages": list(MODERN_CUTTLEFISH_GRAPHICS_PACKAGES),
        "deprecated_hwcomposer": rel(HWC_IMPL),
        "sim_hal": rel(SIM_HAL_IMPL),
        "sepolicy": rel(SEPOLICY),
        "runtime_requirements": runtime_requirements,
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: Mapping[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **FALSE_CLAIM_FLAGS,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} aosp.hal_service_contract")
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
