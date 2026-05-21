#!/usr/bin/env python3
"""Conform the generated Chipyard AP device tree to the e1 platform contract.

The Chipyard generator emits a UC Berkeley reference device tree (Chipyard root
compatible strings, a SiFive UART at the e1 NPU address, a 3-source PLIC, a
500 kHz timebase, and no e1 DMA/NPU/display nodes). That collateral is useful as
an AP harness, but it must not be promoted as e1 Linux/AOSP boot evidence while
its ABI disagrees with ``sw/platform/e1_platform_contract.json``.

This step rewrites the imported DTS (and its generated-src twin) into an
e1-conformant device tree using only values taken from the platform contract's
``e1_chip_cpu_variant`` projection, so the transform is reproducible and pinned
to the contract rather than hand-authored. It is applied after
``scripts/generate_chipyard_eliza.py`` imports the raw artifacts; the upstream
ElizaRocketConfig should eventually carry these device bindings natively, at
which point this overlay collapses to a no-op verification.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build/chipyard/eliza_rocket"
IMPORTED_DTS = BUILD / "eliza-e1.dts"
IMPORTED_GEN = BUILD / "generated-src"
SOURCE_DTS = IMPORTED_GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.dts"
MANIFEST = BUILD / "ElizaRocketConfig.manifest.json"
PLATFORM_CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"

E1_ROOT_COMPATIBLE = '"eliza,e1-board", "eliza,e1"'
E1_MODEL = "Eliza E1 Linux-capable SoC projection (Chipyard AP)"


def int_value(value: Any) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value, 0)
    raise ValueError(f"expected an integer-valued field, got {value!r}")


def variant_contract() -> dict[str, Any]:
    contract = json.loads(PLATFORM_CONTRACT.read_text(encoding="utf-8"))
    variant = contract.get("e1_chip_cpu_variant")
    if not isinstance(variant, dict):
        raise SystemExit(
            "STATUS: BLOCKED chipyard.conform_dts - platform contract lacks e1_chip_cpu_variant"
        )
    return variant


def reg_cells(base: int, size: int) -> str:
    return f"<0x{base:x} 0x{size:x}>"


def device_node(name: str, spec: dict[str, Any]) -> str:
    base = int_value(spec["base"])
    size = int_value(spec["size"])
    irq = int_value(spec["irq"])
    compatible = spec["compatible"]
    return (
        f"\t\t{name}@{base:x} {{\n"
        f'\t\t\tcompatible = "{compatible}";\n'
        f"\t\t\treg = {reg_cells(base, size)};\n"
        "\t\t\tinterrupt-parent = <&L15>;\n"
        f"\t\t\tinterrupts = <{irq}>;\n"
        '\t\t\tstatus = "okay";\n'
        "\t\t};\n"
    )


def conform_dts(text: str, variant: dict[str, Any]) -> str:
    uart = variant["uart"]
    uart_base = int_value(uart["base"])
    uart_size = int_value(uart["size"])
    uart_irq = int_value(uart["irq"])
    uart_compatible = uart["compatible"]
    uart_clock = int_value(uart["clock_frequency_hz"])
    uart_shift = int_value(uart["reg_shift"])
    timebase = int_value(variant["timebase_frequency_hz"])
    plic_sources = int_value(variant["plic"]["num_sources"])
    devices = variant["devices"]

    # Root identity: drop Chipyard/UC Berkeley compatible+model strings.
    text = text.replace(
        'compatible = "ucb-bar,chipyard-dev";',
        f"compatible = {E1_ROOT_COMPATIBLE};",
    )
    text = text.replace(
        'model = "ucb-bar,chipyard";',
        f'model = "{E1_MODEL}";',
    )
    text = text.replace(
        'compatible = "ucb-bar,chipyard-soc", "simple-bus";',
        'compatible = "simple-bus";',
    )

    # Timebase: applies to both the cpus node and the per-cpu copy.
    text = re.sub(
        r"timebase-frequency = <\d+>;",
        f"timebase-frequency = <{timebase}>;",
        text,
    )

    # PLIC interrupt source count.
    text = re.sub(
        r"riscv,ndev = <\d+>;",
        f"riscv,ndev = <{plic_sources}>;",
        text,
    )

    # Console: relocate the SiFive UART off the e1 NPU address to the contract
    # UART base, and switch the binding to the e1 BSP console driver.
    serial = re.search(
        r"(?P<label>L\d+: )?serial@[0-9a-fA-F]+ \{(?P<body>.*?)\n\t\t\};",
        text,
        flags=re.DOTALL,
    )
    if serial is None:
        raise SystemExit(
            "STATUS: BLOCKED chipyard.conform_dts - generated DTS has no serial node to conform"
        )
    label = serial.group("label") or ""
    e1_serial = (
        f"{label}serial@{uart_base:x} {{\n"
        "\t\t\tclocks = <&L5>;\n"
        f'\t\t\tcompatible = "{uart_compatible}";\n'
        "\t\t\tinterrupt-parent = <&L15>;\n"
        f"\t\t\tinterrupts = <{uart_irq}>;\n"
        f"\t\t\treg = {reg_cells(uart_base, uart_size)};\n"
        '\t\t\treg-names = "control";\n'
        f"\t\t\treg-shift = <{uart_shift}>;\n"
        f"\t\t\tclock-frequency = <{uart_clock}>;\n"
        '\t\t\tstatus = "okay";\n'
        "\t\t}"
    )
    text = text[: serial.start()] + e1_serial + text[serial.end() - len(";") :]

    # e1 peripherals required by the Linux and Android driver paths. The append
    # is idempotent: a device already present in the DTS is left untouched so the
    # transform is safe to re-run on conformed collateral.
    e1_devices = "".join(
        device_node(name, devices[name])
        for name in ("dma", "npu", "display")
        if f'"{devices[name]["compatible"]}"' not in text
    )
    if e1_devices:
        soc_close = re.search(r"\n\t\};\n\};\n?$", text)
        if soc_close is None:
            raise SystemExit(
                "STATUS: BLOCKED chipyard.conform_dts - could not locate soc node terminator"
            )
        text = (
            text[: soc_close.start()] + "\n" + e1_devices.rstrip("\n") + text[soc_close.start() :]
        )

    residual = sorted({token for token in ("ucb-bar,chipyard",) if token in text})
    if residual:
        raise SystemExit(
            "STATUS: BLOCKED chipyard.conform_dts - residual Chipyard identity strings remain: "
            + ", ".join(residual)
        )
    return text


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(child for child in path.rglob("*") if child.is_file()):
        digest.update(item.relative_to(path).as_posix().encode())
        digest.update(b"\0")
        digest.update(sha256_file(item).encode())
        digest.update(b"\0")
    return digest.hexdigest()


def update_manifest() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest.setdefault("artifacts", {})["dts"] = "build/chipyard/eliza_rocket/eliza-e1.dts"
    artifact_hashes = manifest.setdefault("artifact_sha256", {})
    if IMPORTED_DTS.is_file():
        artifact_hashes["dts_sha256"] = sha256_file(IMPORTED_DTS)
    if IMPORTED_GEN.is_dir():
        artifact_hashes["generated_src_tree_sha256"] = sha256_tree(IMPORTED_GEN)
    manifest["dts_conformance"] = {
        "schema": "eliza.chipyard_ap_dts_conformance.v1",
        "applied": True,
        "command": "python3 scripts/conform_chipyard_ap_dts.py",
        "source_of_truth": "sw/platform/e1_platform_contract.json#/e1_chip_cpu_variant",
        "note": (
            "Imported Chipyard DTS rewritten to the e1 platform contract ABI "
            "(e1 root compatible, ns16550a UART at the contract base, "
            "PLIC source count, timebase, and e1 DMA/NPU/display nodes). "
            "Upstream ElizaRocketConfig should eventually emit these natively."
        ),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the artifacts are already e1-conformant without rewriting",
    )
    args = parser.parse_args(argv or sys.argv[1:])

    variant = variant_contract()
    targets = [path for path in (IMPORTED_DTS, SOURCE_DTS) if path.is_file()]
    if not targets:
        raise SystemExit(
            "STATUS: BLOCKED chipyard.conform_dts - no generated DTS to conform; "
            "run python3 scripts/generate_chipyard_eliza.py first"
        )

    changed: list[str] = []
    for path in targets:
        original = path.read_text(encoding="utf-8")
        conformed = conform_dts(original, variant)
        if conformed != original:
            if args.check:
                print(
                    f"STATUS: BLOCKED chipyard.conform_dts - {rel(path)} is not e1-conformant"
                )
                return 2
            path.write_text(conformed, encoding="utf-8")
            changed.append(rel(path))

    if args.check:
        print("STATUS: PASS chipyard.conform_dts - generated DTS already matches the e1 contract")
        return 0

    update_manifest()
    if changed:
        print("STATUS: CONFORMED chipyard.conform_dts - rewrote " + ", ".join(changed))
    else:
        print("STATUS: PASS chipyard.conform_dts - generated DTS already matched the e1 contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
