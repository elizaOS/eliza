#!/usr/bin/env python3
"""Build a minimal riscv64 Linux Image for the E1 CVA6 Verilator boot.

The riscv `defconfig` kernel that previously shipped here is a full distro
kernel (SMP NR_CPUS=64, NET, PCI, netfilter, 9p, EFI stub, RISC-V vector, every
filesystem) — a 22 MiB Image whose pre-userland init path is far too long for
the cycle-bounded Verilator run, which is why the boot reached the kernel banner
but ran out of cycles before `/init`.

This script builds the trimmed kernel instead:

  base   = `make ARCH=riscv tinyconfig`           (smallest bootable starting set)
  + merge = fw/linux-cva6-boot/minimal.config      (only what /init needs)
  build  = arch/riscv/boot/Image

The initramfs cpio is built first and baked into the kernel via
CONFIG_INITRAMFS_SOURCE (the `@INITRAMFS_CPIO@` placeholder in minimal.config is
substituted with the absolute cpio path), so there is no separate initramfs load
or block device on the boot path — the kernel unpacks its builtin archive and
runs `/init` directly.

Everything is real toolchain output; nothing is stubbed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]   # packages/chip
LINUX_SRC = ROOT / "external/linux"
LINUX_GNU = ROOT / "external/riscv64-linux-gnu"

CROSS = "riscv64-linux-gnu-"
ARCH = "riscv"


def _env() -> dict:
    env = dict(os.environ)
    gnu_bin = LINUX_GNU / "usr/bin"
    gnu_lib = LINUX_GNU / "usr/lib/x86_64-linux-gnu"
    if gnu_bin.is_dir():
        env["PATH"] = f"{gnu_bin}:{env.get('PATH', '')}"
    if gnu_lib.is_dir():
        env["LD_LIBRARY_PATH"] = f"{gnu_lib}:{env.get('LD_LIBRARY_PATH', '')}"
    return env


def _make(targets: list[str], env: dict, extra: list[str] | None = None) -> None:
    cmd = [
        "make", "-C", str(LINUX_SRC),
        f"ARCH={ARCH}", f"CROSS_COMPILE={CROSS}",
        "-j", str(os.cpu_count() or 4),
    ]
    if extra:
        cmd += extra
    cmd += targets
    subprocess.run(cmd, env=env, check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--initramfs", default=str(HERE / "build/initramfs.cpio"))
    ap.add_argument("--skip-initramfs", action="store_true",
                    help="reuse an existing initramfs cpio instead of rebuilding")
    args = ap.parse_args()

    env = _env()
    if shutil.which(f"{CROSS}gcc", path=env["PATH"]) is None:
        raise SystemExit(f"{CROSS}gcc not found (external/riscv64-linux-gnu)")

    # 1) initramfs cpio (baked into the kernel below).
    initrd = Path(args.initramfs)
    if not args.skip_initramfs or not initrd.exists():
        subprocess.run(["python3", str(HERE / "build_initramfs.py"),
                        "--out", str(initrd)], env=env, check=True)
    if not initrd.exists():
        raise SystemExit(f"initramfs not built: {initrd}")

    # 2) tinyconfig base.
    _make(["tinyconfig"], env)

    # 3) merge the minimal fragment, substituting the cpio path.
    frag_src = (HERE / "minimal.config").read_text()
    frag_src = frag_src.replace("@INITRAMFS_CPIO@", str(initrd.resolve()))
    frag = HERE / "build/minimal.resolved.config"
    frag.parent.mkdir(parents=True, exist_ok=True)
    frag.write_text(frag_src)
    subprocess.run(
        ["./scripts/kconfig/merge_config.sh", "-m", ".config", str(frag)],
        cwd=str(LINUX_SRC), env=env, check=True)
    _make(["olddefconfig"], env)

    # 4) verify the load-bearing options survived olddefconfig.
    config = (LINUX_SRC / ".config").read_text()
    required = [
        "CONFIG_ARCH_RV64I=y", "CONFIG_MMU=y", "CONFIG_RISCV_SBI=y",
        "CONFIG_SERIAL_8250_CONSOLE=y", "CONFIG_SERIAL_EARLYCON=y",
        "CONFIG_BLK_DEV_INITRD=y", "CONFIG_BINFMT_ELF=y",
        "CONFIG_DEVTMPFS=y", "CONFIG_CMDLINE_FORCE=y",
        f'CONFIG_INITRAMFS_SOURCE="{initrd.resolve()}"',
    ]
    missing = [r for r in required if r not in config]
    if missing:
        raise SystemExit(
            "minimal config lost required options after olddefconfig:\n  "
            + "\n  ".join(missing))
    if "CONFIG_SMP=y" in config:
        print("WARNING: CONFIG_SMP=y survived (expected UP) — SMP bring-up will "
              "still run.", file=sys.stderr)

    # 5) build the Image.
    _make(["Image"], env)
    image = LINUX_SRC / "arch/riscv/boot/Image"
    if not image.exists():
        raise SystemExit(f"kernel Image not produced: {image}")
    size = image.stat().st_size
    print(f"\nminimal riscv64 Image: {image}  ({size} bytes, "
          f"{size / 1024 / 1024:.2f} MiB)")
    # Persist the resolved config alongside the fw for documentation/repro.
    shutil.copy(LINUX_SRC / ".config", HERE / "build/kernel.config")
    print(f"resolved kernel config saved: {HERE / 'build/kernel.config'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
