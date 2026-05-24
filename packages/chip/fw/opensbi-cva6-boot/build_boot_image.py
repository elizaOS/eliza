#!/usr/bin/env python3
"""Assemble the OpenSBI-on-CVA6 Verilator boot image.

Builds (from source, no fakes) and lays out, at fixed DRAM addresses, the four
components the CVA6-from-DRAM boot top fetches and executes:

  1. boot shim          @ 0x80000000  (sets a0=hartid, a1=dtb, jumps to OpenSBI)
  2. OpenSBI fw_jump.bin @ 0x80001000  (real repo OpenSBI v1.8.1, FW_TEXT_START
                                        relinked here; next-stage S-mode @ the
                                        payload addr, FDT @ the dtb addr)
  3. device-tree blob    @ 0x80040000  (compiled from e1-cva6-boot.dts)
  4. S-mode payload      @ 0x80060000  (fw/opensbi-payloads/e1-smode, relinked
                                        here; prints the S-MODE-OK marker)

The result is a dense 128-bit-per-line `$readmemh` image starting at the DRAM
base (0x80000000), beat index = (addr - base) / 16 — exactly what the
e1_dram_ctrl `+E1_DRAM_PRELOAD_HEX` hook consumes.  Gaps between components are
zero beats (the controller skips zero beats on load).

This is the deterministic stand-in for the secure boot-ROM / loader that places
M-mode firmware into DRAM before the application core is released.  Everything
here is the real software toolchain output; nothing is stubbed.

Usage:
  build_boot_image.py [--out <hex128>] [--report <json>]

Requires (via tools/env.sh):
  - riscv64-unknown-elf-gcc / llvm-objcopy   (shim + S-mode payload)
  - the PIE-capable external/riscv64-linux-gnu cross + libopcodes (OpenSBI)
  - dtc                                       (device-tree blob)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]   # packages/chip
HERE = Path(__file__).resolve().parent
OPENSBI_SRC = ROOT / "external/opensbi/opensbi"
OPENSBI_PLATFORM_SRC = ROOT / "sw/opensbi/platform/eliza"
SMODE_DIR = ROOT / "fw/opensbi-payloads/e1-smode"
LINUX_GNU = ROOT / "external/riscv64-linux-gnu"

# --- fixed memory map (all in DRAM @ 0x80000000) ---
# OpenSBI is linked at the DRAM base (FW_TEXT_START = 0x8000_0000): its
# sbi_domain_init requires fw_start be aligned to the fw_rw offset, which only
# a power-of-two-aligned base such as 0x8000_0000 satisfies.  The CPU therefore
# boots into a tiny entry shim placed ABOVE the OpenSBI image (at SHIM_ADDR);
# the shim sets a0/a1 and jumps down to OpenSBI's _fw_start at 0x8000_0000.
DRAM_BASE     = 0x80000000
OPENSBI_ADDR  = 0x80000000   # FW_TEXT_START (aligned base)
DTB_ADDR      = 0x80040000   # FW_JUMP_FDT_ADDR
SMODE_ADDR    = 0x80060000   # FW_JUMP_ADDR (M->S next stage)
SHIM_ADDR     = 0x80080000   # CVA6 reset vector (entry shim, above OpenSBI)

BEAT_BYTES = 16


def _env() -> dict:
    env = dict(os.environ)
    # OpenSBI needs the PIE-capable Linux GNU cross + its libopcodes.
    gnu_bin = LINUX_GNU / "usr/bin"
    gnu_lib = LINUX_GNU / "usr/lib/x86_64-linux-gnu"
    if gnu_bin.is_dir():
        env["PATH"] = f"{gnu_bin}:{env.get('PATH', '')}"
    if gnu_lib.is_dir():
        env["LD_LIBRARY_PATH"] = f"{gnu_lib}:{env.get('LD_LIBRARY_PATH', '')}"
    return env


def _run(cmd: list[str], cwd: Path, env: dict) -> None:
    subprocess.run(cmd, cwd=str(cwd), env=env, check=True)


def _need(tool: str) -> None:
    if shutil.which(tool) is None:
        raise SystemExit(f"required tool not on PATH: {tool} (source tools/env.sh)")


def build_shim(out_dir: Path, env: dict) -> bytes:
    elf = out_dir / "shim.elf"
    binf = out_dir / "shim.bin"
    _run([
        "riscv64-unknown-elf-gcc",
        "-march=rv64imac_zicsr", "-mabi=lp64", "-mcmodel=medany",
        "-nostdlib", "-nostartfiles", "-ffreestanding", "-fno-pic",
        f"-DOPENSBI_ENTRY={OPENSBI_ADDR:#x}", f"-DDTB_ADDR={DTB_ADDR:#x}",
        "-T", str(HERE / "shim.ld"), "-Wl,--build-id=none",
        "-o", str(elf), str(HERE / "shim.S"),
    ], HERE, env)
    _run(["llvm-objcopy", "-O", "binary", str(elf), str(binf)], HERE, env)
    return binf.read_bytes()


def build_opensbi(env: dict) -> bytes:
    # Stage the eliza platform into the OpenSBI tree (mirrors the README).
    dst = OPENSBI_SRC / "platform/eliza"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(OPENSBI_PLATFORM_SRC, dst)
    build_dir = OPENSBI_SRC / "build"
    if build_dir.exists():
        shutil.rmtree(build_dir)
    _run([
        "make", "-C", str(OPENSBI_SRC),
        "PLATFORM=eliza",
        "CROSS_COMPILE=riscv64-linux-gnu-",
        "FW_PAYLOAD=n", "FW_JUMP=y",
        f"FW_TEXT_START={OPENSBI_ADDR:#x}",
        f"FW_JUMP_ADDR={SMODE_ADDR:#x}",
        f"FW_JUMP_FDT_ADDR={DTB_ADDR:#x}",
        "PLATFORM_RISCV_ISA=rv64gc",
        "-j", str(os.cpu_count() or 4),
    ], OPENSBI_SRC, env)
    binf = build_dir / "platform/eliza/firmware/fw_jump.bin"
    if not binf.exists():
        raise SystemExit(f"OpenSBI fw_jump.bin not produced: {binf}")
    return binf.read_bytes()


def build_dtb(out_dir: Path, env: dict) -> bytes:
    dtb = out_dir / "e1-cva6-boot.dtb"
    _run(["dtc", "-I", "dts", "-O", "dtb",
          "-o", str(dtb), str(HERE / "e1-cva6-boot.dts")], HERE, env)
    return dtb.read_bytes()


def build_smode(env: dict) -> bytes:
    _run(["make", "-C", str(SMODE_DIR), "clean"], SMODE_DIR, env)
    _run(["make", "-C", str(SMODE_DIR),
          "CROSS=riscv64-unknown-elf-", "OBJCOPY=llvm-objcopy",
          f"PAYLOAD_LINK_ADDR={SMODE_ADDR:#x}"], SMODE_DIR, env)
    binf = SMODE_DIR / "e1.bin"
    if not binf.exists():
        raise SystemExit(f"S-mode payload e1.bin not produced: {binf}")
    return binf.read_bytes()


def place(image: bytearray, addr: int, blob: bytes, name: str) -> None:
    off = addr - DRAM_BASE
    end = off + len(blob)
    if off < 0:
        raise SystemExit(f"{name}: address {addr:#x} below DRAM base")
    if end > len(image):
        raise SystemExit(
            f"{name}: ends at {DRAM_BASE + end:#x}, beyond image window "
            f"{DRAM_BASE + len(image):#x}")
    image[off:end] = blob


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build/boot.hex128"))
    ap.add_argument("--report", default=str(HERE / "build/boot_image.json"))
    args = ap.parse_args()

    for t in ("riscv64-unknown-elf-gcc", "llvm-objcopy", "dtc"):
        _need(t)

    env = _env()
    if shutil.which("riscv64-linux-gnu-gcc", path=env["PATH"]) is None:
        raise SystemExit("riscv64-linux-gnu-gcc not found (external/riscv64-linux-gnu)")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    shim = build_shim(out.parent, env)
    opensbi = build_opensbi(env)
    dtb = build_dtb(out.parent, env)
    smode = build_smode(env)

    # Window = up to the end of the shim (the highest component), beat-rounded.
    top = SHIM_ADDR + len(shim)
    window = ((top - DRAM_BASE + BEAT_BYTES - 1) // BEAT_BYTES) * BEAT_BYTES
    image = bytearray(window)

    # Sanity: each component must fit below the next.
    if OPENSBI_ADDR + len(opensbi) > DTB_ADDR:
        raise SystemExit(
            f"OpenSBI ({len(opensbi)} B) overruns DTB region "
            f"({OPENSBI_ADDR:#x}+len > {DTB_ADDR:#x})")
    if DTB_ADDR + len(dtb) > SMODE_ADDR:
        raise SystemExit(
            f"DTB ({len(dtb)} B) overruns S-mode region "
            f"({DTB_ADDR:#x}+len > {SMODE_ADDR:#x})")
    if SMODE_ADDR + len(smode) > SHIM_ADDR:
        raise SystemExit(
            f"S-mode payload ({len(smode)} B) overruns shim region "
            f"({SMODE_ADDR:#x}+len > {SHIM_ADDR:#x})")

    place(image, OPENSBI_ADDR, opensbi, "opensbi")
    place(image, DTB_ADDR, dtb, "dtb")
    place(image, SMODE_ADDR, smode, "smode")
    place(image, SHIM_ADDR, shim, "shim")

    # Emit dense 128-bit-per-line hex (little-endian byte i -> bit 8*i).
    lines = []
    for o in range(0, len(image), BEAT_BYTES):
        beat = image[o:o + BEAT_BYTES]
        lines.append(f"{int.from_bytes(beat, 'little'):032x}\n")
    out.write_text("".join(lines))

    beats = len(image) // BEAT_BYTES
    report = {
        "schema": "eliza.opensbi_boot_image.v1",
        "dram_base": hex(DRAM_BASE),
        "layout": {
            "shim":    {"addr": hex(SHIM_ADDR),    "bytes": len(shim)},
            "opensbi": {"addr": hex(OPENSBI_ADDR), "bytes": len(opensbi)},
            "dtb":     {"addr": hex(DTB_ADDR),     "bytes": len(dtb)},
            "smode":   {"addr": hex(SMODE_ADDR),   "bytes": len(smode)},
        },
        "entry": {"a0_hartid": 0, "a1_dtb": hex(DTB_ADDR),
                  "pc": hex(SHIM_ADDR)},
        "image_beats": beats,
        "image_bytes": len(image),
        "hex128": str(out),
    }
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"\nboot image: {out}  ({beats} beats, {len(image)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
