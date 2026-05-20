#!/usr/bin/env python3
"""Static Linux memory/platform contract and missing-evidence gate.

This checker does not create or accept boot evidence. It verifies that the
checked-in Linux/AOSP device trees match the central platform contract and that
missing Linux/Buildroot/OpenSBI evidence is represented by machine-readable
blocked entries instead of placeholder logs.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
LINUX_DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
AOSP_DTS = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts"
GENERATED_DTSI = ROOT / "sw/platform/generated/e1-platform.dtsi"
MANIFEST = ROOT / "docs/evidence/linux-memory-platform-missing-evidence.json"
REPORT = ROOT / "build/reports/linux_memory_platform_contract.json"


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def h(value: Any) -> int:
    return int(str(value).replace("_", ""), 0)


def cell(value: Any) -> str:
    return f"0x{h(value):08x}"


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//.*", "", text)


def load_contract(errors: list[str]) -> dict[str, Any]:
    if not CONTRACT.is_file():
        errors.append(f"missing {rel(CONTRACT)}")
        return {}
    try:
        data = json.loads(read(CONTRACT))
    except json.JSONDecodeError as exc:
        errors.append(f"{rel(CONTRACT)} invalid JSON: {exc}")
        return {}
    return data if isinstance(data, dict) else {}


def check_dtc(path: Path, errors: list[str]) -> None:
    dtc = shutil.which("dtc")
    if not dtc:
        return
    result = subprocess.run(
        [dtc, "-I", "dts", "-O", "dtb", "-o", "/tmp/eliza-check.dtb", str(path)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    require(
        result.returncode == 0, f"{rel(path)} does not compile with dtc: {result.stdout}", errors
    )


def node_body(text: str, node: str) -> str:
    match = re.search(rf"\b{re.escape(node)}\s*\{{(?P<body>.*?)\n\s*\}};", text, flags=re.S)
    return match.group("body") if match else ""


def check_one_dts(path: Path, variant: dict[str, Any], *, android: bool, errors: list[str]) -> None:
    if not path.is_file():
        errors.append(f"missing {rel(path)}")
        return
    raw = read(path)
    text = strip_comments(raw)
    lower = text.lower()

    dram = variant["dram"]
    uart = variant["uart"]
    plic = variant["plic"]
    clint = variant["clint"]
    irqs = variant["interrupts"]

    required_tokens = [
        "#address-cells = <2>",
        "#size-cells = <2>",
        'riscv,isa = "rv64gc"',
        'mmu-type = "riscv,sv39"',
        "memory@80000000",
        f"reg = <0x0 {cell(dram['base'])} 0x0 {cell(dram['size'])}>",
        "clint@2000000",
        '"riscv,clint0"',
        f"reg = <0x0 {cell(clint['base'])} 0x0 {cell(clint['size'])}>",
        f"interrupts-extended = <&cpu0_intc 3>, <&cpu0_intc {int(irqs['IRQ_TIMER'])}>",
        "interrupt-controller@c000000",
        '"riscv,plic0"',
        f"reg = <0x0 {cell(plic['base'])} 0x0 {cell(plic['size'])}>",
        f"riscv,ndev = <{int(plic['num_sources'])}>",
        "serial@10001000",
        '"ns16550a"',
        f"reg = <0x0 {cell(uart['base'])} 0x0 {cell(uart['size'])}>",
        f"clock-frequency = <{int(uart['clock_frequency_hz'])}>",
        f"interrupts = <{int(uart['irq'])}>",
        "console=ttyS0",
    ]
    for token in required_tokens:
        require(token in raw, f"{rel(path)} missing contract token: {token}", errors)

    for name, dev in variant["devices"].items():
        body = node_body(text, f"{name}@{h(dev['base']):x}")
        require(bool(body), f"{rel(path)} missing {name}@{h(dev['base']):x} node", errors)
        require(
            dev["compatible"] in body,
            f"{rel(path)} {name} compatible must be {dev['compatible']}",
            errors,
        )
        require(
            f"reg = <0x0 {cell(dev['base'])} 0x0 {cell(dev['size'])}>" in body,
            f"{rel(path)} {name} reg must match contract",
            errors,
        )
        require(
            f"interrupts = <{int(dev['irq'])}>" in body,
            f"{rel(path)} {name} IRQ must be {int(dev['irq'])}",
            errors,
        )

    for forbidden in (
        "e1,uart-1.0",
        "e1,npu-1.0",
        "e1,dma-1.0",
        "e1,display-1.0",
        "0x10003000",
        "0x40000000",
        "rv64imac",
        "console=e1UART0",
    ):
        require(
            forbidden.lower() not in lower, f"{rel(path)} contains stale token {forbidden}", errors
        )

    if android:
        for name, dev in variant["devices"].items():
            body = node_body(text, f"{name}@{h(dev['base']):x}")
            require(
                'status = "disabled"' in body,
                f"{rel(path)} Android {name} node must remain disabled until external evidence exists",
                errors,
            )
    else:
        for token in (
            "mmc-pwrseq-simple",
            "brcm,bcm4329-fmac",
            "brcm,bcm43438-bt",
            'status = "disabled"',
        ):
            require(
                token in raw,
                f"{rel(path)} missing disabled WiFi/Bluetooth scaffold token: {token}",
                errors,
            )

    check_dtc(path, errors)


def check_generated_dtsi(variant: dict[str, Any], errors: list[str]) -> None:
    if not GENERATED_DTSI.is_file():
        errors.append(f"missing {rel(GENERATED_DTSI)}")
        return
    text = read(GENERATED_DTSI)
    for token in (
        f"reg = <0x0 {cell(variant['dram']['base'])} 0x0 {cell(variant['dram']['size'])}>",
        f"serial@{h(variant['uart']['base']):x}",
        '"ns16550a"',
        f"riscv,ndev = <{int(variant['plic']['num_sources'])}>",
    ):
        require(token in text, f"{rel(GENERATED_DTSI)} missing generated token: {token}", errors)


def check_evidence_manifest(errors: list[str], blockers: list[str]) -> None:
    if not MANIFEST.is_file():
        errors.append(f"missing {rel(MANIFEST)}")
        return
    try:
        manifest = json.loads(read(MANIFEST))
    except json.JSONDecodeError as exc:
        errors.append(f"{rel(MANIFEST)} invalid JSON: {exc}")
        return
    require(
        manifest.get("claim_boundary")
        == "missing_evidence_manifest_only_not_linux_boot_or_dram_evidence",
        f"{rel(MANIFEST)} claim boundary drifted",
        errors,
    )
    items = manifest.get("required_evidence")
    require(
        isinstance(items, list) and bool(items),
        f"{rel(MANIFEST)} must list required_evidence",
        errors,
    )
    if not isinstance(items, list):
        return
    for item in items:
        if not isinstance(item, dict):
            errors.append(f"{rel(MANIFEST)} has non-object evidence entry")
            continue
        status = str(item.get("status", ""))
        require(
            status.startswith("blocked_"),
            f"{item.get('id', '<unknown>')} status must be blocked_* until evidence exists",
            errors,
        )
        path_value = item.get("path")
        if isinstance(path_value, str):
            evidence = ROOT / path_value
            marker_value = item.get("blocked_marker")
            if evidence.is_file():
                text = read(evidence)
                for forbidden in manifest.get("forbidden_pass_markers", []):
                    require(
                        forbidden.lower() not in text.lower(),
                        f"{path_value} contains forbidden marker {forbidden}",
                        errors,
                    )
            else:
                require(
                    isinstance(marker_value, str) and (ROOT / marker_value).is_file(),
                    f"{path_value} missing and no blocked_marker file exists",
                    errors,
                )
                if isinstance(marker_value, str) and (ROOT / marker_value).is_file():
                    first = read(ROOT / marker_value).splitlines()[0].lower()
                    require(
                        first.startswith("reason:"),
                        f"{marker_value} must start with reason:",
                        errors,
                    )
                blockers.append(
                    f"{item.get('id')}: {item.get('producer', item.get('blocked_reason', 'missing evidence'))}"
                )


def build_report(*, evidence_only: bool = False) -> tuple[dict[str, Any], int]:
    errors: list[str] = []
    blockers: list[str] = []
    contract = load_contract(errors)
    variant = contract.get("e1_chip_cpu_variant", {}) if contract else {}
    if not evidence_only and variant:
        check_one_dts(LINUX_DTS, variant, android=False, errors=errors)
        check_one_dts(AOSP_DTS, variant, android=True, errors=errors)
        check_generated_dtsi(variant, errors)
    check_evidence_manifest(errors, blockers)
    status = "fail" if errors else ("blocked" if blockers else "pass")
    report = {
        "schema": "eliza.linux_memory_platform_contract.status.v1",
        "status": status,
        "claim_boundary": "static_contract_and_missing_evidence_gate_no_boot_evidence_created",
        "errors": errors,
        "blockers": blockers,
        "checked": [
            rel(path) for path in (CONTRACT, LINUX_DTS, AOSP_DTS, GENERATED_DTSI, MANIFEST)
        ],
    }
    return report, (1 if errors else 0)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-only", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    report, rc = build_report(evidence_only=args.evidence_only)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        label = report["status"].upper()
        print(f"STATUS: {label} linux_memory_platform_contract")
        print(f"  report: {rel(REPORT)}")
        for error in report["errors"]:
            print(f"  - ERROR: {error}")
        for blocker in report["blockers"]:
            if report["status"] == "fail":
                print(f"  - EVIDENCE-GAP: {blocker}")
            else:
                print(f"  - BLOCKED: {blocker}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
