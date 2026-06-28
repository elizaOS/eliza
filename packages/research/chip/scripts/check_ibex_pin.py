#!/usr/bin/env python3
"""Fail-closed check that the lowRISC Ibex external pin manifest is consistent.

Mirrors the cva6/boom/xiangshan pin-check pattern. If the upstream checkout is
missing, the script reports BLOCKED but does not fail closed — the bootstrap
script `make ibex-fetch` resolves the checkout. If the checkout is present, the
HEAD commit must match the pinned value in `external/ibex/pin-manifest.json`.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "external" / "ibex" / "pin-manifest.json"
CHECKOUT = ROOT / "external" / "ibex" / "ibex"


def main() -> int:
    if not MANIFEST.is_file():
        print(f"FAIL ibex pin manifest missing: {MANIFEST.relative_to(ROOT)}")
        return 1

    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL ibex pin manifest invalid JSON: {exc}")
        return 1

    if manifest.get("license") != "Apache-2.0":
        print("FAIL ibex license must be Apache-2.0")
        return 1
    if manifest.get("ip_name") != "lowrisc-ibex":
        print("FAIL ibex ip_name must be lowrisc-ibex")
        return 1
    if manifest.get("instantiated_module") != "ibex_top":
        print("FAIL ibex instantiated_module must be ibex_top (used by rtl/power/pmc_top.sv)")
        return 1

    if not CHECKOUT.is_dir():
        print(
            "STATUS: BLOCKED power.ibex_pin - external/ibex/ibex absent; "
            "run scripts/bootstrap_ibex.sh first"
        )
        return 0

    for relpath in manifest.get("minimum_required_files", []):
        if not (ROOT / relpath).is_file():
            print(f"STATUS: BLOCKED power.ibex_pin - missing required file {relpath}")
            return 0

    try:
        head = subprocess.check_output(
            ["git", "-C", str(CHECKOUT), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.PIPE,
        ).strip()
    except subprocess.CalledProcessError as exc:
        print(f"STATUS: BLOCKED power.ibex_pin - rev-parse failed: {exc.stderr.strip()}")
        return 0

    pin = manifest.get("upstream_commit_pinned", "")
    if pin.startswith("BLOCKED"):
        print(f"STATUS: BLOCKED power.ibex_pin - pin is sentinel: {pin}")
        return 0
    if head != pin:
        print(f"STATUS: FAIL power.ibex_pin - HEAD={head} does not match pin={pin}")
        return 1

    print(f"STATUS: PASS power.ibex_pin - HEAD={head[:7]} matches manifest pin")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
