#!/usr/bin/env python3
"""Static Linux BSP contract gate for chip/OS bring-up.

This check blocks when the checked-in Linux BSP still points at stale driver
names, imports a reduced driver tree that does not match the DTS, or carries
legacy Android kernel options that are known to be weak evidence for current
AOSP/Linux bring-up.
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
FRAGMENT = ROOT / "sw/linux/configs/eliza_e1.fragment"
IMPORT_SCRIPT = ROOT / "sw/linux/scripts/import-linux-bsp.sh"
CAPTURE_SCRIPT = ROOT / "sw/linux/scripts/capture-linux-bsp-evidence.sh"
DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
DISPLAY_BINDING = ROOT / "sw/linux/Documentation/devicetree/bindings/eliza/eliza,e1-display.yaml"
DRIVERS_E1 = ROOT / "sw/linux/drivers/e1"
DRIVERS_ELIZA = ROOT / "sw/linux/drivers/eliza"
REPORT = ROOT / "build/reports/linux_bsp_contract.json"
SCHEMA = "eliza.linux_bsp_contract.v1"
CLAIM_BOUNDARY = "static_linux_bsp_contract_only_not_external_kernel_build_or_boot_evidence"

STALE_TOKENS = {
    "OpenPhone": "old BSP branding",
    "OPENPHONE": "old kernel config symbols",
    "drivers/openphone": "old import path",
}
LEGACY_ANDROID_TOKENS = {
    "CONFIG_ASHMEM": "removed from modern Android common kernels",
    "CONFIG_ION": "legacy allocator superseded by dma-buf heaps",
}
REQUIRED_BASE_SYMBOLS = {
    "CONFIG_ELIZA_E1_BSP",
    "CONFIG_ELIZA_E1_NPU",
    "CONFIG_ELIZA_E1_DMA",
}
FULL_DTS_DRIVER_COMPATIBLES = {
    "eliza,e1-dma": "CONFIG_ELIZA_E1_DMA",
    "eliza,e1-npu": "CONFIG_ELIZA_E1_NPU",
    "eliza,e1-display": "CONFIG_ELIZA_E1_DISPLAY",
    "eliza,e1-gpio": "CONFIG_ELIZA_E1_GPIO",
}
DISPLAY_DTS_REQUIRED_TOKENS = {
    'interrupt-names = "IRQ_VSYNC"': "named vsync IRQ",
    "eliza,mode = <0x050002d0>": "720x1280 packed MODE value",
    "eliza,format = <0x34325258>": "XR24 framebuffer format",
    "eliza,fb-base = <0x80000000>": "DRAM framebuffer base",
}
DISPLAY_BINDING_REQUIRED_TOKENS = {
    "eliza,mode": "mode property",
    "eliza,format": "format property",
    "eliza,fb-base": "framebuffer base property",
    "IRQ_VSYNC": "vsync IRQ name",
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


def config_symbols(text: str) -> set[str]:
    return set(re.findall(r"^(CONFIG_[A-Za-z0-9_]+)=", text, flags=re.MULTILINE))


def dts_compatibles(text: str) -> set[str]:
    compatibles: set[str] = set()
    for match in re.finditer(r'compatible\s*=\s*"([^"]+)"(?:\s*,\s*"([^"]+)")*', text):
        compatibles.add(match.group(1))
        rest = match.group(0)
        compatibles.update(re.findall(r'"([^"]+)"', rest))
    return compatibles


def display_node_text(dts: str) -> str:
    match = re.search(r"display@10030000\s*\{(?P<body>.*?)\n\s*\};", dts, re.DOTALL)
    return match.group("body") if match else ""


def run_check(args: argparse.Namespace) -> dict[str, object]:
    inputs = (
        FRAGMENT,
        IMPORT_SCRIPT,
        CAPTURE_SCRIPT,
        DTS,
        DISPLAY_BINDING,
        DRIVERS_E1 / "Kconfig",
    )
    findings: list[Finding] = []
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required Linux BSP contract input is missing",
            rel(path),
            "Restore the Linux BSP config, import/capture scripts, DTS, and driver Kconfig before claiming Linux bring-up readiness.",
        )
    if findings:
        return payload(findings, {})

    fragment = read_text(FRAGMENT)
    import_script = read_text(IMPORT_SCRIPT)
    capture_script = read_text(CAPTURE_SCRIPT)
    dts = read_text(DTS)
    display_binding = read_text(DISPLAY_BINDING)
    e1_kconfig = read_text(DRIVERS_E1 / "Kconfig")
    eliza_kconfig = (
        read_text(DRIVERS_ELIZA / "Kconfig") if (DRIVERS_ELIZA / "Kconfig").is_file() else ""
    )
    symbols = config_symbols(fragment)
    compatibles = dts_compatibles(dts)
    stale_hits = sorted(token for token in STALE_TOKENS if token in fragment)
    legacy_android_hits = sorted(token for token in LEGACY_ANDROID_TOKENS if token in fragment)
    missing_symbols = sorted(REQUIRED_BASE_SYMBOLS - symbols)
    dts_required_symbols = {
        symbol
        for compatible, symbol in FULL_DTS_DRIVER_COMPATIBLES.items()
        if compatible in compatibles
    }
    missing_dts_symbols = sorted(dts_required_symbols - symbols)
    display_node = display_node_text(dts)
    missing_display_tokens = sorted(
        token for token in DISPLAY_DTS_REQUIRED_TOKENS if token not in display_node
    )
    missing_display_binding_tokens = sorted(
        token for token in DISPLAY_BINDING_REQUIRED_TOKENS if token not in display_binding
    )
    import_uses_reduced_tree = (
        "sw/linux/drivers/e1" in import_script or "drivers/e1/" in import_script
    )
    full_driver_tree_exists = DRIVERS_ELIZA.is_dir()
    e1_has_display_gpio = "ELIZA_E1_DISPLAY" in e1_kconfig and "ELIZA_E1_GPIO" in e1_kconfig
    eliza_has_display_gpio = (
        "ELIZA_E1_DISPLAY" in eliza_kconfig and "ELIZA_E1_GPIO" in eliza_kconfig
    )

    add_if(
        findings,
        bool(stale_hits),
        "linux_kernel_fragment_has_stale_openphone_contract",
        "Linux kernel fragment still references the old OpenPhone hello BSP",
        f"tokens={stale_hits} path={rel(FRAGMENT)}",
        "Replace OpenPhone comments/import paths/symbols with the active Eliza e1 BSP contract.",
    )
    add_if(
        findings,
        bool(missing_symbols),
        "linux_kernel_fragment_missing_eliza_base_symbols",
        "Linux kernel fragment does not enable the active Eliza e1 base BSP symbols",
        f"missing={missing_symbols} configured={sorted(symbols)}",
        "Enable CONFIG_ELIZA_E1_BSP, CONFIG_ELIZA_E1_NPU, and CONFIG_ELIZA_E1_DMA in the fragment used by import-linux-bsp.sh.",
    )
    add_if(
        findings,
        bool(missing_dts_symbols),
        "linux_kernel_fragment_missing_dts_driver_symbols",
        "Linux kernel fragment does not enable every driver implied by the checked-in e1 DTS",
        f"missing={missing_dts_symbols} compatibles={sorted(compatibles & set(FULL_DTS_DRIVER_COMPATIBLES))}",
        "Either enable the DTS-backed display/GPIO drivers or mark those DTS nodes disabled/out of scope for this target.",
    )
    add_if(
        findings,
        "eliza,e1-display" in compatibles and bool(missing_display_tokens),
        "linux_display_dts_missing_programming_contract",
        "Display DTS node is active but does not provide the mode/format/framebuffer properties consumed by the Linux display glue",
        f"missing={missing_display_tokens} path={rel(DTS)}",
        "Add interrupt-names, eliza,mode, eliza,format, and eliza,fb-base to the display@10030000 node or disable the node.",
    )
    add_if(
        findings,
        "eliza,e1-display" in compatibles and bool(missing_display_binding_tokens),
        "linux_display_binding_missing_programming_contract",
        "Display devicetree binding does not document every property the Linux display glue consumes",
        f"missing={missing_display_binding_tokens} path={rel(DISPLAY_BINDING)}",
        "Document the display mode, format, framebuffer base, and IRQ naming contract in the binding.",
    )
    add_if(
        findings,
        bool(legacy_android_hits),
        "linux_kernel_fragment_has_legacy_android_options",
        "Linux kernel fragment still carries legacy Android options that are weak evidence for current AOSP userspace",
        f"tokens={legacy_android_hits}",
        "Replace ASHMEM/ION-era config with the current Android common kernel requirements, including binderfs and dma-buf heaps as applicable.",
    )
    add_if(
        findings,
        import_uses_reduced_tree
        and full_driver_tree_exists
        and eliza_has_display_gpio
        and not e1_has_display_gpio,
        "linux_import_uses_reduced_driver_tree_while_full_tree_exists",
        "Linux import script copies sw/linux/drivers/e1, but the fuller sw/linux/drivers/eliza tree contains display/GPIO drivers used by the DTS",
        f"import={rel(IMPORT_SCRIPT)} reduced_tree={rel(DRIVERS_E1)} full_tree={rel(DRIVERS_ELIZA)}",
        "Choose one active driver tree and align import script, Kconfig fragment, DTS nodes, and evidence capture to it.",
    )
    add_if(
        findings,
        "CONFIG_ELIZA_E1_DISPLAY" not in capture_script
        or "CONFIG_ELIZA_E1_GPIO" not in capture_script,
        "linux_capture_does_not_verify_full_dts_driver_set",
        "Linux evidence capture only verifies the reduced NPU/DMA driver set, not every active DTS-backed driver",
        rel(CAPTURE_SCRIPT),
        "Extend kernel-build/dtb/smoke capture to verify display and GPIO drivers, or disable those DTS nodes for the minimum target.",
    )
    add_if(
        findings,
        "openphone-evidence"
        in (ROOT / "docs/evidence/linux/eliza_e1_kernel_build.log.BLOCKED").read_text(
            encoding="utf-8", errors="replace"
        )
        if (ROOT / "docs/evidence/linux/eliza_e1_kernel_build.log.BLOCKED").is_file()
        else False,
        "linux_blocked_evidence_uses_openphone_markers",
        "Linux blocked evidence marker still requires old openphone-evidence strings",
        "docs/evidence/linux/eliza_e1_kernel_build.log.BLOCKED",
        "Regenerate blocked markers/evidence templates with eliza-evidence and CONFIG_ELIZA_E1_* requirements.",
    )

    evidence = {
        "fragment": rel(FRAGMENT),
        "import_script": rel(IMPORT_SCRIPT),
        "capture_script": rel(CAPTURE_SCRIPT),
        "dts": rel(DTS),
        "display_binding": rel(DISPLAY_BINDING),
        "configured_symbols": sorted(symbols),
        "dts_compatibles": sorted(compatibles),
        "drivers_e1": rel(DRIVERS_E1),
        "drivers_eliza": rel(DRIVERS_ELIZA),
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: Mapping[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "claim_boundary": CLAIM_BOUNDARY,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "linux_boot_claim_allowed": False,
        "android_bsp_claim_allowed": False,
        "display_driver_claim_allowed": False,
        "drm_kms_claim_allowed": False,
        "display_runtime_binding_claim_allowed": False,
        "simple_framebuffer_runtime_claim_allowed": False,
        "panel_dcs_init_claim_allowed": False,
        "dsi_host_claim_allowed": False,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} linux.bsp_contract")
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
