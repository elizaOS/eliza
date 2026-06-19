#!/usr/bin/env python3
"""Run deeper local static analysis and verification gates."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(name: str, cmd: list[str], *, optional: bool = False) -> bool:
    if shutil.which(cmd[0]) is None:
        status = "BLOCK" if optional else "FAIL"
        print(f"{status}: {name}: missing tool {cmd[0]}")
        return optional
    print(f"RUN: {name}: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode == 0:
        print(f"PASS: {name}")
        return True
    print(f"FAIL: {name}: exit {result.returncode}")
    return False


def main() -> int:
    ok = True
    ok &= run("rtl lint/elaboration", ["make", "rtl-check"])
    ok &= run("formal structural", ["make", "formal"])
    ok &= run("synthesis", ["make", "synth"])
    ok &= run("stub audit", ["make", "stub-audit"])
    ok &= run("product gates", ["make", "product-check"])
    ok &= run("pipeline check", ["make", "pipeline-check"])
    ok &= run(
        "device tree compiler",
        [
            "dtc",
            "-I",
            "dts",
            "-O",
            "dtb",
            "-o",
            "/tmp/eliza-e1.dtb",
            "sw/linux/dts/eliza-e1.dts",
        ],
        optional=True,
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
