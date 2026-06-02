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
        "coherency_claim_allowed",
        "iommu_claim_allowed",
        "qos_claim_allowed",
        "android_claim_allowed",
        "production_npu_memory_fabric_claim_allowed",
        "production_display_framebuffer_claim_allowed",
    ):
        if data.get(key) is not False:
            errors.append(f"{key} must be false")
    expected_false_claim_flags = {
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "production_fabric_claim_allowed": False,
        "coherency_claim_allowed": False,
        "iommu_claim_allowed": False,
        "qos_claim_allowed": False,
        "android_claim_allowed": False,
        "production_npu_memory_fabric_claim_allowed": False,
        "production_display_framebuffer_claim_allowed": False,
    }
    if data.get("false_claim_flags") != expected_false_claim_flags:
        errors.append("false_claim_flags must match memory/interconnect non-claim map")

    boundary = data.get("claim_boundary", "")
    for token in (
        "not production SoC routing",
        "not production SoC routing, ordering, coherency",
        "not production",
        "phone-class memory evidence",
        "AXI-Lite scaffold",
        "4 KiB SRAM-backed",
        "256 MiB Linux scaffold",
        "Linux-contract NPU/display MMIO",
        "fail-closed NPU descriptor",
        "fail-closed display framebuffer",
        "IOMMU/SMMU",
        "QoS",
        "NPU memory-fabric",
        "display framebuffer",
    ):
        if token not in boundary:
            errors.append(f"claim boundary missing token: {token}")

    checked_contracts = set(data.get("checked_contracts") or [])
    for contract in (
        "linux_npu_display_mmio_decode",
        "npu_display_memory_fabric_fail_closed",
    ):
        if contract not in checked_contracts:
            errors.append(f"checked_contracts missing {contract}")

    linux_mmio = data.get("linux_mmio_targets")
    if not isinstance(linux_mmio, dict):
        errors.append("linux_mmio_targets must be present")
    else:
        expected_linux_mmio = {
            "npu_base": "0x10020000",
            "display_base": "0x10030000",
            "target_bytes": 0x1000,
            "npu_descriptor_master": "fail_closed_slverr",
            "display_framebuffer_path": "not_routed",
        }
        for key, value in expected_linux_mmio.items():
            if linux_mmio.get(key) != value:
                errors.append(f"linux_mmio_targets.{key} drifted")

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
