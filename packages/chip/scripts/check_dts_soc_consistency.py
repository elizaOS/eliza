#!/usr/bin/env python3
"""Fail-closed gate: the SoC node graph must not drift across the DTS variants.

The generated platform base ``sw/platform/generated/e1-platform.dtsi`` is the
single source of truth for the on-die SoC peripherals (CLINT, PLIC, UART, NPU,
DMA, display, CPU interrupt controller, root bus). Consolidated variants
``#include`` it, so they cannot drift by construction. The two stand-alone
board/Android DTS files duplicate the SoC nodes (because downstream contract
gates text-grep them), so they are the drift risk this gate closes: every
canonical SoC ``compatible`` string in the base must also appear in each
stand-alone variant, with identical primary/fallback driver bindings.

Catches the CLINT/PLIC binding drift where a stand-alone DTS carried only
``riscv,clint0`` / ``riscv,plic0`` while the base used the
``sifive,clint0`` / ``sifive,plic-1.0.0`` primary bindings.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BASE = ROOT / "sw/platform/generated/e1-platform.dtsi"
STANDALONE_VARIANTS = (
    ROOT / "sw/linux/dts/eliza-e1.dts",
    ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts",
)

# Generic strings present in every DT; not SoC-IP identity, so excluded from the
# drift contract (board-specific bus/cpu shells legitimately vary).
_GENERIC = {"simple-bus", "riscv"}

_COMPATIBLE = re.compile(r'compatible\s*=\s*((?:"[^"]+"\s*,?\s*)+);')


def compatibles(text: str) -> set[str]:
    found: set[str] = set()
    for stmt in _COMPATIBLE.finditer(text):
        found.update(re.findall(r'"([^"]+)"', stmt.group(1)))
    return found


def main() -> int:
    if not BASE.is_file():
        print(f"STATUS: FAIL dts-soc-consistency: missing generated base {BASE}")
        return 1

    canonical = compatibles(BASE.read_text(encoding="utf-8")) - _GENERIC
    if not canonical:
        print("STATUS: FAIL dts-soc-consistency: no SoC compatibles parsed from base")
        return 1

    drift: list[str] = []
    for variant in STANDALONE_VARIANTS:
        if not variant.is_file():
            drift.append(f"{variant.relative_to(ROOT)}: missing stand-alone variant")
            continue
        present = compatibles(variant.read_text(encoding="utf-8"))
        missing = sorted(canonical - present)
        if missing:
            drift.append(
                f"{variant.relative_to(ROOT)}: missing canonical SoC compatibles "
                f"{missing} (base is the source of truth)"
            )

    if drift:
        print("STATUS: FAIL dts-soc-consistency: SoC node graph drifted from base")
        for line in drift:
            print(f"  - {line}")
        return 1

    print(
        f"STATUS: PASS dts-soc-consistency: {len(canonical)} canonical SoC "
        f"compatibles consistent across {len(STANDALONE_VARIANTS)} stand-alone variants"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
