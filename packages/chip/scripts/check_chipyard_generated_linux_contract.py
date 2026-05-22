#!/usr/bin/env python3
"""Audit generated Chipyard DTS/regmap/memmap against the Linux launch contract."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from cpu_ap_evidence_lib import load_evidence_manifest, transcript_specs

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build/chipyard/eliza_rocket"
GEN = BUILD / "generated-src"
DTS = BUILD / "eliza-e1.dts"
GEN_DTS = GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.dts"
GEN_FIR = GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.fir"
MEMMAP = GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.memmap.json"
IMPORT_MANIFEST = BUILD / "ElizaRocketConfig.manifest.json"
VERILOG = BUILD / "eliza_rocket_ap.v"
SIMULATOR = BUILD / "simulator"

REGMAPS = {
    "boot_address": GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.0x1000.0.regmap.json",
    "clint": GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.0x2000000.0.regmap.json",
    "plic": GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.0xc000000.0.regmap.json",
    "uart": GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.0x10001000.0.regmap.json",
    "dma": GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.0x10010000.0.regmap.json",
    "npu": GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.0x10020000.0.regmap.json",
    "display": GEN / "chipyard.harness.TestHarness.ElizaRocketConfig.0x10030000.0.regmap.json",
}

ROM_CONNECT_RE = re.compile(r"connect rom\[(\d+)\], UInt<64>\(0h([0-9a-fA-F]+)\)")
DTB_MAGIC = b"\xd0\x0d\xfe\xed"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def load_json(path: Path, failures: list[str], blockers: list[str] | None = None) -> dict:
    if not path.is_file():
        target = blockers if blockers is not None else failures
        target.append(f"missing {rel(path)}")
        return {}
    try:
        data = json.loads(read(path))
    except json.JSONDecodeError as exc:
        failures.append(f"{rel(path)} is invalid JSON: {exc}")
        return {}
    require(isinstance(data, dict), f"{rel(path)} must contain a JSON object", failures)
    return data if isinstance(data, dict) else {}


def mem_region(memmap: dict, name: str) -> tuple[int, int] | None:
    for entry in memmap.get("mapping", []):
        names = entry.get("names", []) if isinstance(entry, dict) else []
        if name not in names:
            continue
        base = entry.get("base", [])
        size = entry.get("size", [])
        if isinstance(base, list) and isinstance(size, list) and base and size:
            return int(base[0]), int(size[0])
    return None


def check_dts(failures: list[str], blockers: list[str]) -> None:
    for path in (DTS, GEN_DTS):
        if not path.is_file():
            blockers.append(f"missing generated DTS: {rel(path)}")
    if not DTS.is_file():
        return

    dts = read(DTS)
    required_tokens = [
        "/dts-v1/",
        "cpu@0",
        'compatible = "sifive,rocket0", "riscv"',
        'mmu-type = "riscv,sv39"',
        "riscv,isa",
        "zicsr",
        "zifencei",
        "memory@80000000",
        "reg = <0x80000000 0x10000000>",
        "clint@2000000",
        'compatible = "riscv,clint0"',
        "interrupt-controller@c000000",
        'compatible = "riscv,plic0"',
        "serial@10001000",
        'compatible = "sifive,uart0"',
        "dma@10010000",
        'compatible = "eliza,e1-dma"',
        "npu@10020000",
        'compatible = "eliza,e1-npu"',
        "display@10030000",
        'compatible = "eliza,e1-display"',
        "stdout-path",
        'stdout-path = "/soc/serial@10001000"',
        'bootargs = "earlycon=sbi console=ttySIF0,3686400n8"',
        "rom@10000",
        "boot-address-reg@1000",
    ]
    for token in required_tokens:
        require(token in dts, f"{rel(DTS)} missing Linux launch token: {token}", failures)
    require(
        re.search(r"timebase-frequency\s*=\s*<500000>", dts) is not None,
        f"{rel(DTS)} must expose the generated timebase-frequency",
        failures,
    )


def check_memmap(failures: list[str], blockers: list[str]) -> None:
    memmap = load_json(MEMMAP, failures, blockers)
    if not memmap:
        return

    expected = {
        "rom@10000": (0x10000, 0x10000),
        "boot-address-reg@1000": (0x1000, 0x1000),
        "clint@2000000": (0x2000000, 0x10000),
        "interrupt-controller@c000000": (0x0C000000, 0x4000000),
        "serial@10001000": (0x10001000, 0x1000),
        "dma@10010000": (0x10010000, 0x1000),
        "npu@10020000": (0x10020000, 0x1000),
        "display@10030000": (0x10030000, 0x1000),
        "memory@80000000": (0x80000000, 0x10000000),
    }
    for name, expected_region in expected.items():
        found = mem_region(memmap, name)
        require(
            found == expected_region,
            f"{rel(MEMMAP)} {name} region is {found}, expected {expected_region}",
            failures,
        )


def check_regmaps(failures: list[str], blockers: list[str]) -> None:
    required_by_regmap = {
        "boot_address": ["bitWidth"],
        "clint": ["msip_0", "mtimecmp_0", "mtime_0"],
        "plic": ["priority_1", "pending_1", "enables_0", "threshold_0", "claim_complete_0"],
        "uart": ["txdata", "rxdata", "txctrl", "rxen", "ie", "ip", "div"],
        "dma": ["0x0", "0x38"],
        "npu": ["0x0", "0xc", "0x10", "0x20", "0x50", "0x80"],
        "display": ["0x0", "0x24"],
    }
    for name, path in REGMAPS.items():
        data = load_json(path, failures, blockers)
        if not data:
            continue
        text = json.dumps(data)
        for token in required_by_regmap[name]:
            require(token in text, f"{rel(path)} missing register marker: {token}", failures)


def bootrom_bytes_from_fir(path: Path) -> bytes:
    words: dict[int, int] = {}
    for match in ROM_CONNECT_RE.finditer(read(path)):
        words[int(match.group(1))] = int(match.group(2), 16)
    if not words:
        return b""
    image = bytearray()
    for index in range(max(words) + 1):
        image.extend(words.get(index, 0).to_bytes(8, byteorder="little", signed=False))
    return bytes(image)


def check_embedded_bootrom_dtb(failures: list[str], blockers: list[str]) -> None:
    if not GEN_FIR.is_file():
        blockers.append(f"missing generated FIR: {rel(GEN_FIR)}")
        return

    image = bootrom_bytes_from_fir(GEN_FIR)
    require(len(image) > 0, f"{rel(GEN_FIR)} has no BootROM ROM contents", failures)
    offset = image.find(DTB_MAGIC)
    require(offset >= 0, f"{rel(GEN_FIR)} BootROM contents do not embed a DTB", failures)
    if offset < 0:
        return

    if offset + 8 > len(image):
        failures.append(f"{rel(GEN_FIR)} embedded DTB header is truncated")
        return
    total_size = int.from_bytes(image[offset + 4 : offset + 8], byteorder="big")
    require(
        total_size >= 512,
        f"{rel(GEN_FIR)} embedded DTB total size is implausibly small: {total_size}",
        failures,
    )
    require(
        offset + total_size <= len(image),
        f"{rel(GEN_FIR)} embedded DTB total size exceeds reconstructed BootROM contents",
        failures,
    )
    dtb = image[offset : offset + total_size]
    for token in (
        b"ucb-bar,chipyard-dev",
        b"/soc/serial@10001000",
        b"dma@10010000",
        b"npu@10020000",
        b"display@10030000",
        b"stdout-path",
        b"/soc/serial@10001000",
        b"earlycon=sbi console=ttySIF0,3686400n8",
        b"sifive,uart0",
        b"eliza,e1-dma",
        b"eliza,e1-npu",
        b"eliza,e1-display",
        b"riscv,clint0",
        b"riscv,plic0",
    ):
        require(
            token in dtb,
            f"{rel(GEN_FIR)} embedded BootROM DTB missing token: {token.decode()}",
            failures,
        )


def check_import_state(failures: list[str], blockers: list[str]) -> None:
    if not VERILOG.is_file():
        blockers.append(f"missing generated Verilog: {rel(VERILOG)}")
    if VERILOG.is_file():
        text = read(VERILOG)
        require(
            "module eliza_rocket_ap" in text,
            f"{rel(VERILOG)} missing eliza_rocket_ap module",
            failures,
        )

    if not IMPORT_MANIFEST.is_file():
        blockers.append(f"missing import manifest {rel(IMPORT_MANIFEST)}")
    if not SIMULATOR.is_dir():
        blockers.append(f"missing generated simulator directory {rel(SIMULATOR)}")
    elif not any(SIMULATOR.iterdir()):
        blockers.append(f"generated simulator directory is empty: {rel(SIMULATOR)}")
    evidence_manifest = load_evidence_manifest(failures)
    for spec in transcript_specs(evidence_manifest).values():
        rel_path = spec.get("path")
        if not isinstance(rel_path, str):
            continue
        transcript = ROOT / rel_path
        if not transcript.is_file():
            capture = spec.get("capture_command")
            if isinstance(capture, str) and capture:
                blockers.append(
                    f"missing executable AP evidence {rel(transcript)}; next: {capture}"
                )
            else:
                blockers.append(f"missing executable AP evidence {rel(transcript)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-boot-evidence", action="store_true")
    args = parser.parse_args()

    failures: list[str] = []
    blockers: list[str] = []
    check_dts(failures, blockers)
    check_memmap(failures, blockers)
    check_regmaps(failures, blockers)
    check_embedded_bootrom_dtb(failures, blockers)
    check_import_state(failures, blockers)

    if failures:
        print("STATUS: FAIL chipyard.generated_linux_contract")
        for failure in failures:
            print(f"  - {failure}")
        if blockers:
            print("  blocked follow-up artifacts/evidence:")
            for blocker in blockers:
                print(f"    - {blocker}")
        return 1

    if blockers:
        print(
            "STATUS: BLOCKED chipyard.generated_linux_contract - generated AP artifacts/evidence are not complete:"
        )
        for blocker in blockers:
            print(f"  - {blocker}")
        print("  capture_preflight: scripts/capture_chipyard_linux_evidence.sh preflight")
        print("  capture_plan: python3 scripts/capture_cpu_ap_evidence.py plan all --format shell")
        print(
            "  smoke_check: python3 scripts/check_chipyard_verilator_linux_smoke.py "
            "(classifies no run, CPU progress-to-payload, OpenSBI boot, and Linux boot)"
        )
        return 1 if args.require_boot_evidence else 0

    print(
        "STATUS: PASS chipyard.generated_linux_contract - generated DTS/memmap/regmaps expose minimum Linux launch nodes"
    )
    print("STATUS: PASS chipyard.generated_linux_boot")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
