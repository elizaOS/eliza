#!/usr/bin/env python3
"""Build a tiny initramfs cpio for the E1 CVA6 Linux boot proof.

Compiles fw/linux-cva6-boot/init.c into a statically-linked, freestanding
riscv64 PID-1 `/init` (raw syscalls, no libc) and packs it into a newc-format
cpio archive — the kernel's CONFIG_BLK_DEV_INITRD payload.  Keeping `/init`
freestanding keeps the archive a few KiB so it fits the bounded Verilator
preload window and boots in a tractable number of cycles.

The marker `/init` prints (ELIZA-USERLAND-OK) is the userland proof token.
"""

from __future__ import annotations

import argparse
import io
import os
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]  # packages/chip
LINUX_GNU = ROOT / "external/riscv64-linux-gnu"


def _env() -> dict:
    env = dict(os.environ)
    gnu_bin = LINUX_GNU / "usr/bin"
    gnu_lib = LINUX_GNU / "usr/lib/x86_64-linux-gnu"
    if gnu_bin.is_dir():
        env["PATH"] = f"{gnu_bin}:{env.get('PATH', '')}"
    if gnu_lib.is_dir():
        env["LD_LIBRARY_PATH"] = f"{gnu_lib}:{env.get('LD_LIBRARY_PATH', '')}"
    return env


def build_init(out_dir: Path, env: dict) -> Path:
    elf = out_dir / "init"
    subprocess.run(
        [
            "riscv64-linux-gnu-gcc",
            "-static",
            "-nostdlib",
            "-nostartfiles",
            "-ffreestanding",
            "-fno-pic",
            "-fno-stack-protector",
            "-march=rv64imac",
            "-mabi=lp64",
            "-mcmodel=medany",
            "-Os",
            "-Wl,--build-id=none",
            "-Wl,-e,_start",
            "-o",
            str(elf),
            str(HERE / "init.c"),
        ],
        check=True,
        env=env,
    )
    return elf


def _cpio_newc(entries: list[tuple[str, int, bytes]]) -> bytes:
    """Build a newc-format cpio archive from (name, mode, data) entries."""
    buf = io.BytesIO()
    ino = 721
    for name, mode, data in entries:
        ino += 1
        name_b = name.encode() + b"\x00"
        fields = [
            ino,
            mode,
            0,
            0,
            1,
            0,
            len(data),
            0,
            0,
            0,
            0,
            len(name_b),
            0,
        ]
        header = b"070701" + b"".join(f"{f:08x}".encode() for f in fields)
        buf.write(header)
        buf.write(name_b)
        # pad name to 4-byte boundary (header is 110 bytes)
        pad = (4 - (len(header) + len(name_b)) % 4) % 4
        buf.write(b"\x00" * pad)
        buf.write(data)
        buf.write(b"\x00" * ((4 - len(data) % 4) % 4))
    # trailer
    name_b = b"TRAILER!!!\x00"
    fields = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, len(name_b), 0]
    header = b"070701" + b"".join(f"{f:08x}".encode() for f in fields)
    buf.write(header)
    buf.write(name_b)
    pad = (4 - (len(header) + len(name_b)) % 4) % 4
    buf.write(b"\x00" * pad)
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build/initramfs.cpio"))
    args = ap.parse_args()

    if shutil.which("riscv64-linux-gnu-gcc", path=_env()["PATH"]) is None:
        raise SystemExit("riscv64-linux-gnu-gcc not found (external/riscv64-linux-gnu)")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    env = _env()

    init_elf = build_init(out.parent, env)
    init_bytes = init_elf.read_bytes()

    # Minimal rootfs: /init plus the dirs the kernel expects to exist.
    S_IFDIR = 0o040000
    S_IFREG = 0o100000
    entries = [
        (".", S_IFDIR | 0o755, b""),
        ("dev", S_IFDIR | 0o755, b""),
        ("proc", S_IFDIR | 0o755, b""),
        ("sys", S_IFDIR | 0o755, b""),
        ("init", S_IFREG | 0o755, init_bytes),
    ]
    archive = _cpio_newc(entries)
    out.write_bytes(archive)
    print(f"initramfs: {out}  ({len(archive)} bytes; init {len(init_bytes)} B)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
