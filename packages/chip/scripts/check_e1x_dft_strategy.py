#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs/arch/e1x-dft.md"

REQUIRED_SECTIONS = (
    "## Scope and Fail-Closed Boundary",
    "## ECC Policy",
    "## MBIST Algorithm",
    "## MBIST Distribution Across the Mesh",
    "## Scan-Chain Stitching Plan",
    "## Repair Interaction with Wafer-Sort and the Repair-ROM Flow",
    "## Verification and Gates",
)

REQUIRED_PHRASES = (
    "SECDED",
    "March C-",
    "BLOCKED",
    "e1x_sram_ecc.sv",
    "e1x_mbist.sv",
    "repair ROM",
)


def missing_items() -> list[str]:
    if not DOC.is_file():
        return [f"missing doc {DOC}"]
    text = DOC.read_text(encoding="utf-8")
    missing = [section for section in REQUIRED_SECTIONS if section not in text]
    missing += [f"phrase:{phrase}" for phrase in REQUIRED_PHRASES if phrase not in text]
    return missing


def main() -> int:
    missing = missing_items()
    if missing:
        print("BLOCKED: e1x-dft strategy doc incomplete: " + ", ".join(missing))
        return 1
    print("PASS: e1x-dft strategy doc has all required sections")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
