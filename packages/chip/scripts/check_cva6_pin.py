#!/usr/bin/env python3
"""Fail-closed check that the CVA6 external pin manifest is consistent.

CVA6 is consumed via two paths:

1. The Chipyard generator submodule chain
   external/chipyard/generators/cva6 -> .gitmodules ->
   src/main/resources/cva6/vsrc/cva6 (upstream openhwgroup/cva6).
2. The standalone external/cva6/ checkout used directly by
   rtl/cpu/e1_cva6_wrapper.sv when E1_HAVE_CVA6 is defined.

This gate verifies the manifest schema and confirms at least one of the
two checkouts exists. Absence of both is BLOCKED, not FAIL.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "external/cva6/pin-manifest.json"
CHIPYARD_WRAPPER = ROOT / "external/chipyard/generators/cva6"
CHIPYARD_CVA6_SUBMODULE = CHIPYARD_WRAPPER / "src/main/resources/cva6/vsrc/cva6"
STANDALONE = ROOT / "external/cva6/cva6"


def main() -> int:
    errors: list[str] = []
    if not MANIFEST.is_file():
        errors.append(f"missing manifest: {MANIFEST.relative_to(ROOT)}")
        print("CVA6 pin check failed:")
        for err in errors:
            print(f"  - {err}")
        return 1

    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL cva6 pin manifest invalid JSON: {exc}")
        return 1

    if manifest.get("license") != "Solderpad-Hardware-License-2.1":
        errors.append("license must be Solderpad-Hardware-License-2.1")
    if manifest.get("ip_name") != "cva6":
        errors.append("ip_name must be cva6")

    if errors:
        print("CVA6 pin check failed:")
        for err in errors:
            print(f"  - {err}")
        return 1

    wrapper_present = CHIPYARD_WRAPPER.is_dir()
    inner_present = CHIPYARD_CVA6_SUBMODULE.is_dir() and any(CHIPYARD_CVA6_SUBMODULE.iterdir())
    standalone_present = STANDALONE.is_dir()

    if not (wrapper_present and (inner_present or standalone_present)):
        if standalone_present:
            kind = "standalone external/cva6/cva6 only"
        elif wrapper_present:
            kind = "chipyard cva6 wrapper present but recursive submodule (CVA6 RTL) not fetched"
        else:
            kind = "no CVA6 checkout at all"
        print(
            f"STATUS: BLOCKED cpu.cva6_pin - {kind}; "
            f"run `git submodule update --init --recursive external/chipyard/generators/cva6` "
            f"or clone https://github.com/openhwgroup/cva6.git into external/cva6/cva6"
        )
        return 0

    if wrapper_present:
        try:
            head = subprocess.check_output(
                ["git", "-C", str(CHIPYARD_WRAPPER), "rev-parse", "HEAD"],
                text=True,
                stderr=subprocess.PIPE,
            ).strip()
        except subprocess.CalledProcessError as exc:
            print(f"STATUS: BLOCKED cpu.cva6_pin - wrapper rev-parse failed: {exc.stderr.strip()}")
            return 0
        pin = manifest.get("wrapper_pinned_commit", "")
        if pin and head != pin:
            print(f"STATUS: FAIL cpu.cva6_pin - wrapper HEAD={head} does not match pin={pin}")
            return 1

    print("STATUS: PASS cpu.cva6_pin - manifest + checkout(s) consistent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
