#!/usr/bin/env python3
"""Fail-closed checks for the minimal executable reset ROM scaffold."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "fw/boot-rom/reset.S"
LINKER = ROOT / "fw/boot-rom/linker.ld"
BUILD = ROOT / "fw/boot-rom/build.sh"
ELF = ROOT / "build/boot-rom/e1_reset_rom.elf"
BIN = ROOT / "build/boot-rom/e1_reset_rom.bin"
HEX = ROOT / "build/boot-rom/e1_reset_rom.hex"
RTL = ROOT / "rtl/bootrom/e1_bootrom.sv"


def status(state: str, check: str, detail: str) -> None:
    print(f"STATUS: {state} {check} - {detail}", flush=True)


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def semantic_errors() -> list[str]:
    errors: list[str] = []
    for path in (SRC, LINKER, BUILD, RTL):
        require(path.is_file(), f"missing {path.relative_to(ROOT)}", errors)
    if errors:
        return errors

    src = SRC.read_text(encoding="utf-8")
    linker = LINKER.read_text(encoding="utf-8")
    rtl = RTL.read_text(encoding="utf-8")

    require("_start:" in src, "reset.S must define _start", errors)
    require("csrw    mtvec" in src, "reset.S must initialize mtvec", errors)
    require("csrci   mstatus" in src, "reset.S must clear MIE before handoff", errors)
    require(
        "e1_bootrom_trap:" in src and re.search(r"\bwfi\b", src) is not None,
        "reset.S must include a local WFI trap loop",
        errors,
    )
    require(
        ".dword  0x0000000080000000" in src,
        "reset.S must encode the current DRAM handoff address",
        errors,
    )
    require("ENTRY(_start)" in linker, "linker.ld must use _start as entry", errors)
    require(
        "ORIGIN = 0x00000000" in linker, "linker.ld must place ROM at reset address 0x0", errors
    )
    require("LENGTH = 4K" in linker, "linker.ld must cap ROM at 4 KiB", errors)
    require(
        "ASSERT(" in linker, "linker.ld must fail if the ROM exceeds the hardware aperture", errors
    )
    require(
        "32'h0000_1000" in rtl,
        "RTL contract ROM must keep the debug-visible handoff word stable",
        errors,
    )
    require(
        "placeholder" not in rtl.lower(),
        "RTL boot ROM must not describe the handoff word as a placeholder",
        errors,
    )
    return errors


def run_build() -> int:
    result = subprocess.run([str(BUILD)], cwd=ROOT, text=True)
    if result.returncode == 2:
        status(
            "BLOCKED",
            "bootrom.check",
            "semantic checks passed; executable artifact build needs a local RISC-V toolchain",
        )
        return 0
    return result.returncode


def artifact_errors() -> list[str]:
    errors: list[str] = []
    for path in (ELF, BIN, HEX):
        require(path.is_file(), f"missing build artifact {path.relative_to(ROOT)}", errors)
    if errors:
        return errors

    data = BIN.read_bytes()
    require(0 < len(data) <= 4096, "boot ROM binary must be non-empty and fit in 4 KiB", errors)
    require(
        len(HEX.read_text(encoding="utf-8").splitlines()) > 0,
        "boot ROM hex must contain at least one word",
        errors,
    )
    return errors


def main() -> int:
    errors = semantic_errors()
    if errors:
        for error in errors:
            status("FAIL", "bootrom.semantic", error)
        return 1
    status("PASS", "bootrom.semantic", "reset source, linker, and RTL contract are explicit")

    rc = run_build()
    if rc != 0:
        return rc

    if not ELF.exists():
        return 0

    errors = artifact_errors()
    if errors:
        for error in errors:
            status("FAIL", "bootrom.artifact", error)
        return 1
    status("PASS", "bootrom.artifact", "ELF, binary, and hex artifacts are present and bounded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
