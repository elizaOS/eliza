#!/usr/bin/env python3
"""Assemble the OpenSBI -> Linux boot image for the E1 CVA6 Verilator boot.

Lays out, at fixed DRAM addresses, the components the CVA6-from-DRAM boot top
(e1_cva6_dram_boot_top) fetches and executes for a Linux boot:

  1. OpenSBI fw_jump.bin @ 0x80000000  (real repo OpenSBI v1.8.1, FW_TEXT_START;
                                        next stage = the Linux kernel in S-mode)
  2. device-tree blob    @ 0x80040000  (e1-cva6-linux.dts, with /chosen bootargs
                                        + linux,initrd-start/-end patched in)
  3. Linux Image         @ 0x80200000  (real riscv64 Image; text_offset 0x200000)
  4. initramfs cpio      @ <aligned, after the kernel>  (tiny /init payload)
  5. boot shim           @ <top>        (CVA6 reset vector; sets a0/a1, jumps to
                                        OpenSBI _fw_start at 0x80000000)

OpenSBI is built FW_JUMP=y with FW_JUMP_ADDR = the kernel base and
FW_JUMP_FDT_ADDR = the DTB base, so after M-mode init it drops to S-mode at the
kernel with a0=hartid, a1=dtb — exactly what the Linux Image entry expects.

Output: a dense 128-bit-per-line `$readmemh` image from the DRAM base; beat
index = (addr - base) / 16, consumed by e1_dram_ctrl's +E1_DRAM_PRELOAD_HEX
hook.  Gaps are zero beats (the controller skips zero beats on load).

Everything is real toolchain output (OpenSBI from source, the prebuilt repo
kernel Image, a freestanding init); nothing is stubbed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]   # packages/chip
HERE = Path(__file__).resolve().parent
OPENSBI_SRC = ROOT / "external/opensbi/opensbi"
OPENSBI_PLATFORM_SRC = ROOT / "sw/opensbi/platform/eliza"
LINUX_GNU = ROOT / "external/riscv64-linux-gnu"

# --- fixed memory map (all in DRAM @ 0x80000000) ---
DRAM_BASE     = 0x80000000
OPENSBI_ADDR  = 0x80000000   # FW_TEXT_START (aligned base)
DTB_ADDR      = 0x80040000   # FW_JUMP_FDT_ADDR
KERNEL_ADDR   = 0x80200000   # FW_JUMP_ADDR (kernel text_offset 0x200000)

BEAT_BYTES = 16
MiB = 1024 * 1024


def _env() -> dict:
    env = dict(os.environ)
    gnu_bin = LINUX_GNU / "usr/bin"
    gnu_lib = LINUX_GNU / "usr/lib/x86_64-linux-gnu"
    if gnu_bin.is_dir():
        env["PATH"] = f"{gnu_bin}:{env.get('PATH', '')}"
    if gnu_lib.is_dir():
        env["LD_LIBRARY_PATH"] = f"{gnu_lib}:{env.get('LD_LIBRARY_PATH', '')}"
    return env


def _run(cmd: list[str], cwd: Path, env: dict) -> None:
    subprocess.run(cmd, cwd=str(cwd), env=env, check=True)


def _need(tool: str, env: dict) -> None:
    if shutil.which(tool, path=env["PATH"]) is None:
        raise SystemExit(f"required tool not on PATH: {tool} (source tools/env.sh)")


def build_opensbi(env: dict) -> bytes:
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
        f"FW_JUMP_ADDR={KERNEL_ADDR:#x}",
        f"FW_JUMP_FDT_ADDR={DTB_ADDR:#x}",
        "PLATFORM_RISCV_ISA=rv64gc",
        "-j", str(os.cpu_count() or 4),
    ], OPENSBI_SRC, env)
    binf = build_dir / "platform/eliza/firmware/fw_jump.bin"
    if not binf.exists():
        raise SystemExit(f"OpenSBI fw_jump.bin not produced: {binf}")
    return binf.read_bytes()


def build_dtb(out_dir: Path, env: dict, initrd_start: int, initrd_end: int) -> bytes:
    # Substitute the resolved initrd window into the DTS template, then compile.
    src = (HERE / "e1-cva6-linux.dts").read_text()
    subs = {
        "__INITRD_START_HI__": f"0x{initrd_start >> 32:x}",
        "__INITRD_START_LO__": f"0x{initrd_start & 0xFFFFFFFF:x}",
        "__INITRD_END_HI__":   f"0x{initrd_end >> 32:x}",
        "__INITRD_END_LO__":   f"0x{initrd_end & 0xFFFFFFFF:x}",
    }
    for k, v in subs.items():
        src = src.replace(k, v)
    dts = out_dir / "e1-cva6-linux.resolved.dts"
    dts.write_text(src)
    dtb = out_dir / "e1-cva6-linux.dtb"
    _run(["dtc", "-I", "dts", "-O", "dtb", "-o", str(dtb), str(dts)], HERE, env)
    return dtb.read_bytes()


def build_shim(out_dir: Path, env: dict, shim_addr: int) -> bytes:
    elf = out_dir / "shim.elf"
    binf = out_dir / "shim.bin"
    ld = out_dir / "shim.ld"
    ld.write_text(
        "OUTPUT_ARCH(riscv)\nENTRY(_start)\nSECTIONS\n{\n"
        f"  . = {shim_addr:#x};\n"
        "  .text : ALIGN(4) { KEEP(*(.text.shim)) *(.text*) }\n"
        "  /DISCARD/ : { *(.comment*) *(.note*) *(.riscv.attributes*)"
        " *(.eh_frame*) *(.data*) *(.bss*) }\n}\n")
    _run([
        "riscv64-unknown-elf-gcc",
        "-march=rv64imac_zicsr", "-mabi=lp64", "-mcmodel=medany",
        "-nostdlib", "-nostartfiles", "-ffreestanding", "-fno-pic",
        f"-DOPENSBI_ENTRY={OPENSBI_ADDR:#x}", f"-DDTB_ADDR={DTB_ADDR:#x}",
        "-T", str(ld), "-Wl,--build-id=none",
        "-o", str(elf), str(ROOT / "fw/opensbi-cva6-boot/shim.S"),
    ], out_dir, env)
    _run(["llvm-objcopy", "-O", "binary", str(elf), str(binf)], out_dir, env)
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
    ap.add_argument("--kernel",
                    default=str(ROOT / "external/linux/arch/riscv/boot/Image"))
    ap.add_argument("--initramfs",
                    default=str(HERE / "build/initramfs.cpio"))
    ap.add_argument("--out", default=str(HERE / "build/linux_boot.hex128"))
    ap.add_argument("--report", default=str(HERE / "build/linux_boot_image.json"))
    args = ap.parse_args()

    env = _env()
    for t in ("riscv64-unknown-elf-gcc", "llvm-objcopy", "dtc",
              "riscv64-linux-gnu-gcc"):
        _need(t, env)

    kernel_path = Path(args.kernel)
    if not kernel_path.exists():
        raise SystemExit(f"kernel Image not found: {kernel_path}")
    kernel = kernel_path.read_bytes()

    initrd_path = Path(args.initramfs)
    if not initrd_path.exists():
        # Build the initramfs on demand.
        _run(["python3", str(HERE / "build_initramfs.py")], HERE, env)
    initrd = initrd_path.read_bytes()

    # initramfs placed 1 MiB-aligned just past the kernel image.
    kernel_end = KERNEL_ADDR + len(kernel)
    initrd_addr = (kernel_end + MiB - 1) & ~(MiB - 1)
    initrd_end = initrd_addr + len(initrd)
    # boot shim placed 64 KiB-aligned past the initramfs.
    shim_addr = (initrd_end + 0x10000 - 1) & ~(0x10000 - 1)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    opensbi = build_opensbi(env)
    dtb = build_dtb(out.parent, env, initrd_addr, initrd_end)
    shim = build_shim(out.parent, env, shim_addr)

    if OPENSBI_ADDR + len(opensbi) > DTB_ADDR:
        raise SystemExit(
            f"OpenSBI ({len(opensbi)} B) overruns DTB region")
    if DTB_ADDR + len(dtb) > KERNEL_ADDR:
        raise SystemExit(f"DTB ({len(dtb)} B) overruns kernel region")

    top = shim_addr + len(shim)
    window = ((top - DRAM_BASE + BEAT_BYTES - 1) // BEAT_BYTES) * BEAT_BYTES
    image = bytearray(window)

    place(image, OPENSBI_ADDR, opensbi, "opensbi")
    place(image, DTB_ADDR, dtb, "dtb")
    place(image, KERNEL_ADDR, kernel, "kernel")
    place(image, initrd_addr, initrd, "initramfs")
    place(image, shim_addr, shim, "shim")

    lines = []
    for o in range(0, len(image), BEAT_BYTES):
        beat = image[o:o + BEAT_BYTES]
        lines.append(f"{int.from_bytes(beat, 'little'):032x}\n")
    out.write_text("".join(lines))

    beats = len(image) // BEAT_BYTES
    report = {
        "schema": "eliza.linux_boot_image.v1",
        "dram_base": hex(DRAM_BASE),
        "layout": {
            "opensbi":   {"addr": hex(OPENSBI_ADDR), "bytes": len(opensbi)},
            "dtb":       {"addr": hex(DTB_ADDR),     "bytes": len(dtb)},
            "kernel":    {"addr": hex(KERNEL_ADDR),  "bytes": len(kernel)},
            "initramfs": {"addr": hex(initrd_addr),  "bytes": len(initrd),
                          "end": hex(initrd_end)},
            "shim":      {"addr": hex(shim_addr),    "bytes": len(shim)},
        },
        "entry": {"a0_hartid": 0, "a1_dtb": hex(DTB_ADDR), "pc": hex(shim_addr),
                  "kernel_jump": hex(KERNEL_ADDR)},
        "image_beats": beats,
        "image_bytes": len(image),
        "preload_beats_required": beats,
        "hex128": str(out),
    }
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"\nlinux boot image: {out}  ({beats} beats, {len(image)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
