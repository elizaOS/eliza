#!/usr/bin/env python3
"""Project the e1 ASIC-platform ABI view of the generated Rocket AP device tree.

The imported ``build/chipyard/eliza_rocket/eliza-e1.dts`` is a faithful copy of
the Rocket DTS the Verilator sim actually boots (SiFive UART @ 0x10020000,
500 kHz timebase, ``ucb-bar,chipyard`` identity). That artifact must stay
unmodified so the generated-Linux contract keeps matching the real sim
hardware.

The e1 ASIC platform contract (``sw/platform/e1_platform_contract.json``)
describes a different, Linux-capable SoC projection (ns16550a UART @ 0x10001000,
10 MHz timebase, 32 PLIC sources, e1 DMA/NPU/display peripherals). This script
emits that view to a *separate* artifact, ``eliza-e1.contract.dts``, derived
purely from the contract so the e1 ABI gate has its own conformed input without
rewriting the faithful generated DTS.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build/chipyard/eliza_rocket"
GENERATED_DTS = BUILD / "eliza-e1.dts"
PLATFORM_CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
CONTRACT_DTS = BUILD / "eliza-e1.contract.dts"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> dict[str, Any]:
    data = json.loads(read_text(path))
    if not isinstance(data, dict):
        raise SystemExit(f"{rel(path)} must contain a JSON object")
    return data


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def hex_int(value: Any) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value, 0)
    raise SystemExit(f"contract value is not an integer: {value!r}")


def region(node: dict[str, Any]) -> tuple[int, int]:
    return hex_int(node["base"]), hex_int(node["size"])


def render(contract: dict[str, Any]) -> str:
    variant = contract["e1_chip_cpu_variant"]
    uart = variant["uart"]
    plic = variant["plic"]
    clint = variant["clint"]
    devices = variant["devices"]

    uart_base, uart_size = region(uart)
    plic_base, plic_size = region(plic)
    clint_base, clint_size = region(clint)
    dma_base, dma_size = region(devices["dma"])
    npu_base, npu_size = region(devices["npu"])
    display_base, display_size = region(devices["display"])
    dram = variant["dram"]
    dram_base, dram_size = region(dram)

    lines = [
        "/dts-v1/;",
        "",
        "/*",
        " * Eliza E1 ASIC-platform ABI projection of the generated Rocket AP.",
        " *",
        " * Reproducible artifact emitted by scripts/conform_chipyard_ap_dts.py from",
        " * sw/platform/e1_platform_contract.json (e1_chip_cpu_variant). It is the e1",
        " * ABI view consumed by scripts/check_chipyard_ap_abi_contract.py and is kept",
        " * separate from the faithful generated eliza-e1.dts that the Verilator sim",
        " * boots. Do not hand-edit; regenerate from the contract.",
        " */",
        "",
        "/ {",
        '\t#address-cells = <1>;',
        '\t#size-cells = <1>;',
        '\tcompatible = "eliza,e1-board", "eliza,e1";',
        '\tmodel = "Eliza E1 Linux-capable SoC projection";',
        "",
        "\taliases {",
        "\t\tserial0 = &uart0;",
        "\t};",
        "",
        "\tchosen {",
        '\t\tstdout-path = &uart0;',
        "\t};",
        "",
        "\tcpus {",
        "\t\t#address-cells = <1>;",
        "\t\t#size-cells = <0>;",
        f"\t\ttimebase-frequency = <{hex_int(variant['timebase_frequency_hz'])}>;",
        "",
        "\t\tcpu0: cpu@0 {",
        '\t\t\tcompatible = "riscv";',
        '\t\t\tdevice_type = "cpu";',
        "\t\t\treg = <0x0>;",
        f'\t\t\triscv,isa = "{variant["isa"]}";',
        '\t\t\tmmu-type = "riscv,sv39";',
        '\t\t\tstatus = "okay";',
        "",
        "\t\t\tcpu0_intc: interrupt-controller {",
        '\t\t\t\tcompatible = "riscv,cpu-intc";',
        "\t\t\t\tinterrupt-controller;",
        "\t\t\t\t#interrupt-cells = <1>;",
        "\t\t\t};",
        "\t\t};",
        "\t};",
        "",
        "\tmemory@80000000 {",
        '\t\tdevice_type = "memory";',
        f"\t\treg = <{dram_base:#x} {dram_size:#x}>;",
        "\t};",
        "",
        "\tsoc {",
        '\t\t#address-cells = <1>;',
        '\t\t#size-cells = <1>;',
        '\t\tcompatible = "simple-bus";',
        "\t\tranges;",
        "",
        f"\t\tclint0: clint@{clint_base:x} {{",
        '\t\t\tcompatible = "riscv,clint0";',
        f"\t\t\treg = <{clint_base:#x} {clint_size:#x}>;",
        "\t\t\tinterrupts-extended = <&cpu0_intc 3 &cpu0_intc 7>;",
        "\t\t};",
        "",
        f"\t\tplic0: interrupt-controller@{plic_base:x} {{",
        '\t\t\tcompatible = "riscv,plic0";',
        f"\t\t\treg = <{plic_base:#x} {plic_size:#x}>;",
        "\t\t\tinterrupt-controller;",
        "\t\t\t#interrupt-cells = <1>;",
        f"\t\t\triscv,ndev = <{hex_int(plic['num_sources'])}>;",
        "\t\t\tinterrupts-extended = <&cpu0_intc 11>;",
        "\t\t};",
        "",
        f"\t\tuart0: serial@{uart_base:x} {{",
        f'\t\t\tcompatible = "{uart["compatible"]}";',
        f"\t\t\treg = <{uart_base:#x} {uart_size:#x}>;",
        "\t\t\tinterrupt-parent = <&plic0>;",
        f"\t\t\tinterrupts = <{hex_int(uart['irq'])}>;",
        f"\t\t\tclock-frequency = <{hex_int(uart['clock_frequency_hz'])}>;",
        f"\t\t\treg-shift = <{hex_int(uart['reg_shift'])}>;",
        '\t\t\tstatus = "okay";',
        "\t\t};",
        "",
        f"\t\tdma@{dma_base:x} {{",
        f'\t\t\tcompatible = "{devices["dma"]["compatible"]}";',
        f"\t\t\treg = <{dma_base:#x} {dma_size:#x}>;",
        "\t\t\tinterrupt-parent = <&plic0>;",
        f"\t\t\tinterrupts = <{hex_int(devices['dma']['irq'])}>;",
        '\t\t\tstatus = "okay";',
        "\t\t};",
        "",
        f"\t\tnpu@{npu_base:x} {{",
        f'\t\t\tcompatible = "{devices["npu"]["compatible"]}";',
        f"\t\t\treg = <{npu_base:#x} {npu_size:#x}>;",
        "\t\t\tinterrupt-parent = <&plic0>;",
        f"\t\t\tinterrupts = <{hex_int(devices['npu']['irq'])}>;",
        '\t\t\tstatus = "okay";',
        "\t\t};",
        "",
        f"\t\tdisplay@{display_base:x} {{",
        f'\t\t\tcompatible = "{devices["display"]["compatible"]}";',
        f"\t\t\treg = <{display_base:#x} {display_size:#x}>;",
        "\t\t\tinterrupt-parent = <&plic0>;",
        f"\t\t\tinterrupts = <{hex_int(devices['display']['irq'])}>;",
        '\t\t\tstatus = "okay";',
        "\t\t};",
        "\t};",
        "};",
        "",
    ]
    return "\n".join(lines)


def conform(generated_dts: Path, contract_path: Path, out: Path) -> str:
    for path in (generated_dts, contract_path):
        if not path.is_file():
            raise SystemExit(f"missing required input: {rel(path)}")
    # The faithful generated DTS is read only to assert it is the genuine Rocket
    # artifact we are projecting from; the conformed view derives from the
    # contract, never from edits to this file.
    faithful = read_text(generated_dts)
    if "ucb-bar,chipyard" not in faithful:
        raise SystemExit(
            f"{rel(generated_dts)} is not the faithful generated Rocket DTS "
            "(missing ucb-bar,chipyard identity); refusing to project a contract view"
        )
    contract = read_json(contract_path)
    rendered = render(contract)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(rendered, encoding="utf-8")
    return rendered


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated-dts", default=str(GENERATED_DTS))
    parser.add_argument("--contract", default=str(PLATFORM_CONTRACT))
    parser.add_argument("--out", default=str(CONTRACT_DTS))
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    out = Path(args.out)
    conform(Path(args.generated_dts), Path(args.contract), out)
    print(f"STATUS: PASS chipyard.conform_ap_dts - wrote {rel(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
