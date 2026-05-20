#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Boot an elizaOS Debian riscv64 kernel/initramfs pair under QEMU."""

from __future__ import annotations

import argparse
import os
import pty
import select
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path


WANT = (
    "OpenSBI",
    "Linux version",
    "Run /init as init process",
    "elizaOS Debian RISC-V: linux booted",
    "/ #",
)


def newest(out_dir: Path, suffix: str) -> Path:
    matches = sorted(out_dir.glob(f"elizaos-debian-riscv64-*.{suffix}"))
    if not matches:
        raise FileNotFoundError(f"no elizaOS Debian riscv64 .{suffix} artifact in {out_dir}")
    return matches[-1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parents[1] / "out")
    parser.add_argument("--kernel", type=Path)
    parser.add_argument("--initrd", type=Path)
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("ELIZAOS_QEMU_TIMEOUT_S", "60")))
    parser.add_argument("--log", type=Path)
    args = parser.parse_args()

    if not shutil_which("qemu-system-riscv64"):
        print("ERROR: qemu-system-riscv64 not found on PATH", file=sys.stderr)
        return 2

    kernel = args.kernel or newest(args.out_dir, "vmlinuz")
    initrd = args.initrd or newest(args.out_dir, "cpio.gz")
    log = args.log or args.out_dir / "qemu-smoke.log"
    log.parent.mkdir(parents=True, exist_ok=True)

    for artifact in (kernel, initrd):
        if not artifact.is_file():
            print(f"ERROR: missing artifact: {artifact}", file=sys.stderr)
            return 2

    cmd = [
        "qemu-system-riscv64",
        "-machine",
        "virt",
        "-nographic",
        "-m",
        os.environ.get("ELIZAOS_QEMU_MEM", "512M"),
        "-smp",
        os.environ.get("ELIZAOS_QEMU_SMP", "1"),
        "-bios",
        "default",
        "-kernel",
        str(kernel),
        "-initrd",
        str(initrd),
        "-append",
        os.environ.get("ELIZAOS_QEMU_APPEND", "console=ttyS0 earlycon=sbi rdinit=/init panic=10"),
        "-serial",
        "mon:stdio",
    ]

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    seen = {marker: False for marker in WANT}
    deadline = time.time() + args.timeout
    buf = b""
    with log.open("wb") as fh:
        try:
            while time.time() < deadline and not all(seen.values()):
                readable, _, _ = select.select([fd], [], [], 0.5)
                if fd not in readable:
                    continue
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                fh.write(chunk)
                fh.flush()
                buf += chunk
                text = buf.decode("utf-8", errors="replace")
                for marker in seen:
                    if marker in text:
                        seen[marker] = True
        finally:
            with suppress(ProcessLookupError):
                os.kill(pid, signal.SIGTERM)
            with suppress(ChildProcessError):
                os.waitpid(pid, 0)

    missing = [marker for marker, present in seen.items() if not present]
    if missing:
        print(f"elizaOS Debian RISC-V QEMU smoke: FAIL missing={missing} log={log}", file=sys.stderr)
        return 1
    print(f"elizaOS Debian RISC-V QEMU smoke: PASS log={log}")
    return 0


def shutil_which(command: str) -> str | None:
    try:
        from shutil import which
    except ImportError:
        return None
    return which(command)


if __name__ == "__main__":
    sys.exit(main())
