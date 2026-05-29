#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/memory_interconnect_contract.json"
CHECKER = ROOT / "scripts/check_memory_interconnect_contract.py"


def main() -> int:
    result = subprocess.run(
        [sys.executable, str(CHECKER)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        print(result.stdout)
        print("FAIL: memory/interconnect checker did not pass")
        return 1

    data = json.loads(REPORT.read_text(encoding="utf-8"))
    errors: list[str] = []
    if data.get("schema") != "eliza.memory_interconnect_contract.local_report.v1":
        errors.append("report schema drifted")
    if data.get("status") != "PASS":
        errors.append("report status must be PASS after passing checker")
    for key in (
        "phone_claim_allowed",
        "release_claim_allowed",
        "production_fabric_claim_allowed",
    ):
        if data.get(key) is not False:
            errors.append(f"{key} must be false")

    boundary = data.get("claim_boundary", "")
    for token in (
        "not production SoC routing",
        "not production SoC routing, ordering, coherency",
        "not production",
        "phone-class memory evidence",
        "AXI-Lite scaffold",
        "4 KiB SRAM-backed",
        "256 MiB Linux scaffold",
        "IOMMU/SMMU",
        "QoS",
    ):
        if token not in boundary:
            errors.append(f"claim boundary missing token: {token}")

    expected_paths = {
        "sw/platform/e1_platform_contract.json",
        "docs/arch/memory-map.md",
        "docs/arch/interconnect.md",
        "rtl/interconnect/e1_linux_soc_contract.sv",
        "rtl/memory/e1_axi_lite_dram.sv",
    }
    paths = set(data.get("evidence_paths") or [])
    missing = sorted(expected_paths - paths)
    if missing:
        errors.append("missing evidence paths: " + ", ".join(missing))

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS memory/interconnect contract report regression")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
