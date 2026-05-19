#!/usr/bin/env python3
"""Fail-closed check that the BOOM external pin manifest is consistent."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "external/boom/pin-manifest.json"
CHIPYARD_BOOM = ROOT / "external/chipyard/generators/boom"


def main() -> int:
    if not MANIFEST.is_file():
        print(f"FAIL boom pin manifest missing: {MANIFEST.relative_to(ROOT)}")
        return 1

    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL boom pin manifest invalid JSON: {exc}")
        return 1

    if manifest.get("license") != "BSD-3-Clause":
        print("FAIL boom license must be BSD-3-Clause")
        return 1
    if manifest.get("ip_name") != "riscv-boom":
        print("FAIL boom ip_name must be riscv-boom")
        return 1

    if not CHIPYARD_BOOM.is_dir():
        print(
            "STATUS: BLOCKED cpu.boom_pin - external/chipyard/generators/boom absent; "
            "run scripts/bootstrap_chipyard.sh first"
        )
        return 0

    try:
        head = subprocess.check_output(
            ["git", "-C", str(CHIPYARD_BOOM), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.PIPE,
        ).strip()
    except subprocess.CalledProcessError as exc:
        print(f"STATUS: BLOCKED cpu.boom_pin - rev-parse failed: {exc.stderr.strip()}")
        return 0

    pin = manifest.get("upstream_commit_pinned", "")
    if head != pin:
        print(f"STATUS: FAIL cpu.boom_pin - HEAD={head} does not match pin={pin}")
        return 1

    print(f"STATUS: PASS cpu.boom_pin - HEAD={head[:7]} matches manifest pin")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
