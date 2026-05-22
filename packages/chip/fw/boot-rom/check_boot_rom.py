#!/usr/bin/env python3
"""Fail-closed checks for the minimal executable reset ROM scaffold."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "fw/boot-rom/reset.S"
LINKER = ROOT / "fw/boot-rom/secure/rom.ld"
BUILD = ROOT / "fw/boot-rom/build.sh"
VERIFY = ROOT / "fw/boot-rom/secure/verify.c"
BOOT = ROOT / "fw/boot-rom/secure/boot.c"
ELF = ROOT / "build/boot-rom/e1_secure_boot_rom.elf"
BIN = ROOT / "build/boot-rom/e1_secure_boot_rom.bin"
HEX = ROOT / "build/boot-rom/e1_secure_boot_rom.hex"
RTL = ROOT / "rtl/bootrom/e1_bootrom.sv"


def status(state: str, check: str, detail: str) -> None:
    print(f"STATUS: {state} {check} - {detail}", flush=True)


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def semantic_errors() -> list[str]:
    errors: list[str] = []
    for path in (SRC, LINKER, BUILD, VERIFY, BOOT, RTL):
        require(path.is_file(), f"missing {path.relative_to(ROOT)}", errors)
    if errors:
        return errors

    src = SRC.read_text(encoding="utf-8")
    linker = LINKER.read_text(encoding="utf-8")
    verify = VERIFY.read_text(encoding="utf-8")
    rtl = RTL.read_text(encoding="utf-8")

    require("_start:" in src, "reset.S must define _start", errors)
    require("csrw    mtvec" in src, "reset.S must initialize mtvec", errors)
    require("csrci   mstatus" in src, "reset.S must clear MIE before handoff", errors)
    require(
        "e1_bootrom_trap:" in src and re.search(r"\bwfi\b", src) is not None,
        "reset.S must include a local WFI trap loop",
        errors,
    )
    # The reset vector must hand control to the C verifier and must NOT carry a
    # fixed unauthenticated handoff address. The handoff target is decided only
    # after authentication; a zero return is a hard fail-closed trap.
    require(
        "call    e1_secure_boot_main" in src,
        "reset.S must call the C secure-boot entrypoint",
        errors,
    )
    require(
        "beqz    a0, e1_bootrom_trap" in src,
        "reset.S must fail closed (trap) when the verifier rejects the image",
        errors,
    )
    require(
        "0x0000000080000000" not in src,
        "reset.S must not hardcode an unauthenticated DRAM handoff address",
        errors,
    )
    # The verifier is fail-closed: a distinct error code per reject path and no
    # accept-all / bypass.
    for needle, why in (
        ("VERIFY_ERR_MAGIC", "magic mismatch"),
        ("VERIFY_ERR_PAYLOAD_HASH", "payload hash mismatch"),
        ("VERIFY_ERR_SIGNATURE", "signature failure"),
        ("VERIFY_ERR_PUBKEY_HASH", "key-ladder pubkey hash"),
        ("VERIFY_ERR_ROLLBACK", "rollback downgrade"),
        ("VERIFY_ERR_KEY_REVOKED", "revoked key_id"),
        ("VERIFY_ERR_LIFECYCLE", "lifecycle floor"),
        ("VERIFY_ERR_OTP_PARITY", "OTP parity fault"),
    ):
        require(needle in verify, f"verify.c must define a distinct {why} code", errors)
    require(
        "ed25519_verify" in verify,
        "verify.c must enforce an Ed25519 signature check",
        errors,
    )
    require("ENTRY(_start)" in linker, "rom.ld must use _start as entry", errors)
    require("ORIGIN = 0x00000000" in linker, "rom.ld must place ROM at reset address 0x0", errors)
    require(
        "ASSERT(" in linker, "rom.ld must fail if the ROM exceeds the hardware aperture", errors
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
        # Fail closed: a missing native RISC-V toolchain is a BLOCKED build, not
        # a pass. The chip toolchain is vendored under external/ (see CLAUDE.md
        # "native over Docker"); aggregate boot-readiness must surface this as a
        # blocker rather than treat the unbuilt ROM as ready.
        status(
            "BLOCKED",
            "bootrom.check",
            "semantic checks passed but the executable ROM artifact was not built",
        )
        return 2
    return result.returncode


def artifact_errors() -> list[str]:
    errors: list[str] = []
    for path in (ELF, BIN, HEX):
        require(path.is_file(), f"missing build artifact {path.relative_to(ROOT)}", errors)
    if errors:
        return errors

    data = BIN.read_bytes()
    require(
        0 < len(data) <= 65536,
        "secure boot ROM binary must be non-empty and fit in the 64 KiB aperture",
        errors,
    )
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
        status("FAIL", "bootrom.artifact", "build returned success but produced no ROM ELF")
        return 1

    errors = artifact_errors()
    if errors:
        for error in errors:
            status("FAIL", "bootrom.artifact", error)
        return 1
    status("PASS", "bootrom.artifact", "ELF, binary, and hex artifacts are present and bounded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
