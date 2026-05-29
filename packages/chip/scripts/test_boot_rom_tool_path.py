#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_boot_rom_checker_finds_repo_local_riscv_tools() -> None:
    env = os.environ.copy()
    env["PATH"] = "/usr/bin:/bin"
    env.pop("RISCV_CC", None)
    env.pop("RISCV_OBJCOPY", None)
    result = subprocess.run(
        [sys.executable, "fw/boot-rom/check_boot_rom.py"],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout)
    if "STATUS: PASS bootrom.artifact" not in result.stdout:
        raise AssertionError(result.stdout)


def main() -> int:
    test_boot_rom_checker_finds_repo_local_riscv_tools()
    print("boot ROM repo-local tool path test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
