#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Run Tier 2 Linux+busybox QEMU boot and assert userspace banner + shell prompt.

Asserts within 30 seconds:
  * "eliza tier2: linux booted"
  * "/ #"  (busybox prompt)

Log: build/sim/qemu/tier2_linux.log
Exit 0 on success, nonzero on failure.
"""

from __future__ import annotations

import os
import pty
import select
import signal
import sys
import time
from contextlib import suppress
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
KERNEL = Path(os.environ.get("KERNEL", REPO_ROOT / "external/linux/arch/riscv/boot/Image"))
INITRD = Path(os.environ.get("INITRD", REPO_ROOT / "build/initramfs/eliza_tier2.cpio.gz"))
LOG = REPO_ROOT / "build/sim/qemu/tier2_linux.log"
TIMEOUT_S = 30.0

WANT_BANNER = "eliza tier2: linux booted"
WANT_PROMPT = "/ #"


def main() -> int:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    for f in (KERNEL, INITRD):
        if not f.is_file():
            print(f"ERROR: missing artifact: {f}", file=sys.stderr)
            print("See docs/sim/tier2-linux-busybox-recipe.md", file=sys.stderr)
            return 2

    cmd = [
        "qemu-system-riscv64",
        "-machine",
        "virt",
        "-nographic",
        "-m",
        "256M",
        "-smp",
        "1",
        "-bios",
        "default",
        "-kernel",
        str(KERNEL),
        "-initrd",
        str(INITRD),
        "-append",
        "console=ttyS0 earlycon=sbi panic=10",
        "-serial",
        "mon:stdio",
    ]

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    saw_banner = False
    saw_prompt = False
    deadline = time.time() + TIMEOUT_S
    buf = b""
    with LOG.open("wb") as log:
        try:
            while time.time() < deadline and not (saw_banner and saw_prompt):
                r, _, _ = select.select([fd], [], [], 0.5)
                if fd not in r:
                    continue
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                log.write(chunk)
                log.flush()
                buf += chunk
                text = buf.decode("utf-8", errors="replace")
                if WANT_BANNER in text:
                    saw_banner = True
                if WANT_PROMPT in text:
                    saw_prompt = True
        finally:
            with suppress(ProcessLookupError):
                os.kill(pid, signal.SIGTERM)
            with suppress(ChildProcessError):
                os.waitpid(pid, 0)

    print(f"banner={saw_banner} prompt={saw_prompt} log={LOG}")
    if saw_banner and saw_prompt:
        print("Tier 2 PASS: Linux booted to busybox shell.")
        return 0
    print("Tier 2 FAIL: missing banner and/or prompt within timeout.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
