#!/usr/bin/env python3
"""Static generated AP ABI contract gate.

The generated Chipyard AP can be useful boot collateral, but it must not be
treated as e1 chip Linux/AOSP evidence unless its device tree matches the e1
Linux-capable SoC projection consumed by the kernel and Android HAL paths.

This gate reads the conformed e1 ABI view (``eliza-e1.contract.dts``, emitted by
``scripts/conform_chipyard_ap_dts.py`` from the platform contract), not the
faithful generated ``eliza-e1.dts`` that the Verilator sim boots. The faithful
DTS keeps its real Rocket identity for the generated-Linux contract; this gate
asserts the e1 ABI projection against the separate conformed artifact.
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
BUILD = ROOT / "build/chipyard/eliza_rocket"
GENERATED_DTS = BUILD / "eliza-e1.contract.dts"
GENERATED_SOURCE_DTS = BUILD / "generated-src/chipyard.harness.TestHarness.ElizaRocketConfig.dts"
IMPORT_MANIFEST = BUILD / "ElizaRocketConfig.manifest.json"
PLATFORM_CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
STATIC_E1_DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
REPORT = ROOT / "build/reports/chipyard_ap_abi_contract.json"
SCHEMA = "eliza.chipyard_ap_abi_contract.v1"
CLAIM_BOUNDARY = "static_generated_ap_abi_contract_only_not_boot_evidence"


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def read_json(path: Path) -> Any:
    return json.loads(read_text(path))


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


def int_value(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value, 0)
        except ValueError:
            return None
    return None


def generated_reg_for_node(text: str, node: str) -> tuple[int, int] | None:
    match = re.search(
        rf"{re.escape(node)}\s*\{{(?P<body>.*?)\n\s*\}};",
        text,
        flags=re.DOTALL,
    )
    if not match:
        return None
    reg_match = re.search(
        r"reg\s*=\s*<(?P<base>0x[0-9a-fA-F]+)\s+(?P<size>0x[0-9a-fA-F]+)>", match.group("body")
    )
    if not reg_match:
        return None
    return int(reg_match.group("base"), 16), int(reg_match.group("size"), 16)


def first_serial_region(text: str) -> tuple[str, tuple[int, int]] | None:
    for match in re.finditer(r"(?P<node>serial@[0-9a-fA-F]+)\s*\{", text):
        region = generated_reg_for_node(text, match.group("node"))
        if region is not None:
            return match.group("node"), region
    return None


def expected_regions(contract: dict[str, Any]) -> dict[str, tuple[int | None, int | None]]:
    variant = contract.get("e1_chip_cpu_variant", {})
    devices = variant.get("devices", {}) if isinstance(variant, dict) else {}
    return {
        "uart": (
            int_value(variant.get("uart", {}).get("base")),
            int_value(variant.get("uart", {}).get("size")),
        ),
        "dma": (
            int_value(devices.get("dma", {}).get("base")),
            int_value(devices.get("dma", {}).get("size")),
        ),
        "npu": (
            int_value(devices.get("npu", {}).get("base")),
            int_value(devices.get("npu", {}).get("size")),
        ),
        "display": (
            int_value(devices.get("display", {}).get("base")),
            int_value(devices.get("display", {}).get("size")),
        ),
    }


def clean_regions(
    raw: dict[str, tuple[int | None, int | None]],
) -> dict[str, tuple[int, int] | None]:
    result: dict[str, tuple[int, int] | None] = {}
    for name, (base, size) in raw.items():
        result[name] = (base, size) if base is not None and size is not None else None
    return result


def run_check(args: argparse.Namespace) -> dict[str, object]:
    inputs = (
        GENERATED_DTS,
        GENERATED_SOURCE_DTS,
        IMPORT_MANIFEST,
        PLATFORM_CONTRACT,
        STATIC_E1_DTS,
    )
    findings: list[Finding] = []
    for path in inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required generated AP ABI contract input is missing",
            rel(path),
            "Regenerate/import Chipyard AP artifacts and platform DTS contracts before promoting chip-OS boot evidence.",
        )
    if findings:
        return payload(findings, {})

    generated_dts = read_text(GENERATED_DTS)
    static_e1_dts = read_text(STATIC_E1_DTS)
    manifest = read_json(IMPORT_MANIFEST)
    contract = read_json(PLATFORM_CONTRACT)
    variant = contract.get("e1_chip_cpu_variant", {})
    expected = clean_regions(expected_regions(contract))
    generated_serial = first_serial_region(generated_dts)
    generated_uart = generated_serial[1] if generated_serial else None
    generated_npu_collision = generated_reg_for_node(generated_dts, "serial@10020000")
    generated_plic_match = re.search(r"riscv,ndev\s*=\s*<(?P<ndev>\d+)>", generated_dts)
    generated_timebase_match = re.search(
        r"timebase-frequency\s*=\s*<(?P<timebase>\d+)>", generated_dts
    )
    expected_timebase = int_value(variant.get("timebase_frequency_hz"))
    expected_plic_sources = int_value(variant.get("plic", {}).get("num_sources"))
    generated_timebase = (
        int(generated_timebase_match.group("timebase")) if generated_timebase_match else None
    )
    generated_plic_sources = (
        int(generated_plic_match.group("ndev")) if generated_plic_match else None
    )
    manifest_dts = manifest.get("artifacts", {}).get("dts") if isinstance(manifest, dict) else None

    add_if(
        findings,
        variant.get("target_kind") != "linux_capable_soc_projection"
        or variant.get("has_cpu") is not True,
        "platform_contract_missing_linux_capable_projection",
        "platform contract does not expose a Linux-capable e1 CPU projection",
        f"target_kind={variant.get('target_kind')!r} has_cpu={variant.get('has_cpu')!r}",
        "Keep e1_chip_cpu_variant as the source of truth for AP boot ABI checks.",
    )
    add_if(
        findings,
        "ucb-bar,chipyard" in generated_dts,
        "generated_ap_dts_identifies_chipyard_not_e1",
        "conformed AP ABI DTS identifies as Chipyard/UC Berkeley rather than the e1 chip ABI",
        "found ucb-bar,chipyard compatible/model strings",
        "Regenerate the conformed e1 ABI DTS so the booted target records an explicit e1-compatible ABI boundary.",
    )
    add_if(
        findings,
        "eliza,e1-board" not in generated_dts and "eliza,e1" not in generated_dts,
        "generated_ap_dts_missing_e1_root_compatible",
        "generated AP DTS lacks e1 root compatible strings",
        rel(GENERATED_DTS),
        "Use the e1 Linux-capable DTS contract, or label the Chipyard DTS as reference-only in boot evidence.",
    )
    add_if(
        findings,
        generated_uart != expected["uart"],
        "generated_ap_uart_region_mismatch",
        "generated AP UART region does not match the e1 CPU-variant UART contract",
        f"generated_serial={generated_serial} expected_uart={expected['uart']}",
        "Align UART base/compatible/IRQ with e1_chip_cpu_variant before using the transcript as e1 Linux/AOSP proof.",
    )
    add_if(
        findings,
        generated_npu_collision == expected["npu"],
        "generated_ap_uart_collides_with_e1_npu_region",
        "generated AP exposes a UART at the address reserved for the e1 NPU",
        f"generated_serial@10020000={generated_npu_collision} expected_npu={expected['npu']}",
        "Resolve the MMIO map collision or keep generated Chipyard boot evidence scoped as non-e1 reference evidence.",
    )
    add_if(
        findings,
        "eliza,e1-dma" not in generated_dts
        or "eliza,e1-npu" not in generated_dts
        or "eliza,e1-display" not in generated_dts,
        "generated_ap_dts_missing_e1_devices",
        "generated AP DTS lacks e1 DMA/NPU/display nodes required by Linux and Android driver paths",
        "required compatibles: eliza,e1-dma eliza,e1-npu eliza,e1-display",
        "Bridge the generated AP to e1 peripherals or add a separate e1-compatible AP target before promoting OS evidence.",
    )
    add_if(
        findings,
        generated_timebase != expected_timebase,
        "generated_ap_timebase_mismatch",
        "generated AP timebase does not match the e1 CPU-variant contract",
        f"generated={generated_timebase} expected={expected_timebase}",
        "Align timebase-frequency across generated DTS, OpenSBI, kernel, and platform contract.",
    )
    add_if(
        findings,
        generated_plic_sources != expected_plic_sources,
        "generated_ap_plic_source_count_mismatch",
        "generated AP PLIC source count does not match the e1 CPU-variant interrupt contract",
        f"generated={generated_plic_sources} expected={expected_plic_sources}",
        "Expose the e1 interrupt source map or scope Chipyard AP evidence as a narrower Rocket reference target.",
    )
    add_if(
        findings,
        "ns16550a" in static_e1_dts and "sifive,uart0" in generated_dts,
        "generated_ap_console_driver_mismatch",
        "generated AP console uses SiFive UART while the e1 BSP contract uses ns16550a",
        f"generated={rel(GENERATED_DTS)} static_e1={rel(STATIC_E1_DTS)}",
        "Use one console ABI for boot evidence and kernel configs, or declare separate reference and e1 targets.",
    )
    add_if(
        findings,
        manifest_dts == "build/chipyard/eliza_rocket/eliza-e1.dts"
        and "eliza,e1-board" not in generated_dts,
        "generated_manifest_labels_chipyard_dts_as_eliza_e1",
        "import manifest names the Chipyard DTS as eliza-e1.dts even though its contents are not e1-compatible",
        f"manifest.artifacts.dts={manifest_dts!r}",
        "Rename/scope the generated DTS artifact or make its compatible strings and MMIO map match the e1 contract.",
    )

    evidence = {
        "generated_dts": rel(GENERATED_DTS),
        "generated_source_dts": rel(GENERATED_SOURCE_DTS),
        "static_e1_dts": rel(STATIC_E1_DTS),
        "platform_contract": rel(PLATFORM_CONTRACT),
        "manifest": rel(IMPORT_MANIFEST),
        "generated_uart_region": generated_uart,
        "generated_serial_node": generated_serial[0] if generated_serial else None,
        "expected_regions": {name: value for name, value in expected.items()},
        "generated_timebase_frequency_hz": generated_timebase,
        "expected_timebase_frequency_hz": expected_timebase,
        "generated_plic_sources": generated_plic_sources,
        "expected_plic_sources": expected_plic_sources,
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


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} chipyard.ap_abi_contract")
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
