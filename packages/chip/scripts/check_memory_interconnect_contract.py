#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PLATFORM = ROOT / "sw/platform/e1_platform_contract.json"
MEMORY_MAP = ROOT / "docs/arch/memory-map.md"
MEMORY_SUBSYSTEM = ROOT / "docs/arch/memory-subsystem.md"
INTERCONNECT = ROOT / "docs/arch/interconnect.md"
UMA = ROOT / "docs/project/uma-coherency-validation-strategy.yaml"
GATE = ROOT / "docs/evidence/memory/uma-dram-evidence-gate.yaml"

INTERCONNECT_RTL = ROOT / "rtl/interconnect/e1_axi_lite_interconnect.sv"
CONTRACT_RTL = ROOT / "rtl/interconnect/e1_linux_soc_contract.sv"
DRAM_RTL = ROOT / "rtl/memory/e1_axi_lite_dram.sv"

REQUIRED_UMA_AXES = {
    "coherency_policy": "uma_coherency_report",
    "iommu_isolation": "iommu_fault_injection_report",
    "memory_qos": "memory_qos_report",
    "android_buffer_lifecycle": "android_shared_buffer_report",
}

REQUIRED_UMA_ARTIFACTS = {
    "docs/evidence/memory/uma_coherency_report.json",
    "docs/evidence/memory/iommu_fault_injection_report.json",
    "docs/evidence/memory/memory_qos_report.json",
    "docs/evidence/android/android_shared_buffer_report.json",
}

EXPECTED_E1_CHIP_DRAM_BASE = 0x80000000
EXPECTED_E1_CHIP_DRAM_BYTES = 0x1000
EXPECTED_LINUX_DRAM_BYTES = 0x10000000
EXPECTED_AXI_LITE_WORD_BYTES = 4


def read(path: Path) -> str:
    return path.read_text(errors="ignore")


def h(value: str) -> int:
    return int(value.replace("_", "").replace("0x", ""), 16)


def parse_doc_hex(value: str) -> int:
    return h(value.strip().strip("`"))


def parse_doc_size(value: str) -> int:
    size = value.strip().strip("`")
    match = re.fullmatch(r"(\d+)\s+(KiB|MiB|GiB)", size)
    if not match:
        raise ValueError(size)
    amount = int(match.group(1))
    scale = {"KiB": 1024, "MiB": 1024**2, "GiB": 1024**3}[match.group(2)]
    return amount * scale


def markdown_rows(text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    headers: list[str] | None = None
    for line in text.splitlines():
        if not line.startswith("|"):
            headers = None
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not cells:
            continue
        if all(set(cell.replace(":", "").strip()) <= {"-"} for cell in cells):
            continue
        if headers is None:
            headers = cells
            continue
        if len(cells) == len(headers):
            rows.append(dict(zip(headers, cells, strict=True)))
    return rows


def rtl_localparam(text: str, name: str) -> int | None:
    match = re.search(rf"\b{name}\s*=\s*32'h([0-9A-Fa-f_]+)", text)
    if not match:
        return None
    return int(match.group(1).replace("_", ""), 16)


def dram_depth_words(text: str) -> int | None:
    match = re.search(r"parameter\s+int\s+unsigned\s+DEPTH_WORDS\s*=\s*(\d+)", text)
    if not match:
        return None
    return int(match.group(1))


def ranges_overlap(first_base: int, first_size: int, second_base: int, second_size: int) -> bool:
    return first_base < second_base + second_size and second_base < first_base + first_size


def fail_unless(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def region(contract: dict, name: str) -> dict:
    for item in contract["e1_chip"]["regions"]:
        if item["name"] == name:
            return item
    raise KeyError(name)


def check_e1_chip_dram_contract(contract: dict, errors: list[str]) -> None:
    dram = region(contract, "dram")
    fail_unless(
        dram["base"] == "0x80000000", "e1-chip DRAM aperture base must remain 0x80000000", errors
    )
    fail_unless(
        dram["size"] == "0x00001000",
        "e1-chip debug DRAM aperture must remain documented as 4 KiB",
        errors,
    )
    fail_unless(
        "Small debug-visible SRAM-backed DRAM aperture" in dram.get("description", ""),
        "e1-chip DRAM contract must say it is a small SRAM-backed aperture",
        errors,
    )
    fail_unless(
        contract["e1_chip"]["has_cpu"] is False,
        "e1-chip platform contract must not imply a production CPU/UMA path",
        errors,
    )


def check_docs(errors: list[str]) -> None:
    memory_map = read(MEMORY_MAP)
    memory_subsystem = read(MEMORY_SUBSYSTEM)
    interconnect = read(INTERCONNECT)
    joined = "\n".join([memory_map, memory_subsystem, interconnect])

    required_tokens = [
        "SRAM-backed",
        "no cache coherency",
        "no IOMMU",
        "no QoS",
        "real memory controller boundary",
        "fail closed",
        "CPU-wins arbitration",
        "bounded physical-address allowlist",
    ]
    for token in required_tokens:
        fail_unless(
            token in joined,
            f"memory/interconnect docs missing required boundary token: {token}",
            errors,
        )

    fail_unless(
        "`0x8000_0000` | `4 KiB`" in memory_map,
        "docs/arch/memory-map.md must keep the e1-chip debug DRAM aperture at 4 KiB",
        errors,
    )
    fail_unless(
        "`0x8000_0000` | `256 MiB`" in memory_map,
        "docs/arch/memory-map.md must document the Linux scaffold DRAM aperture separately",
        errors,
    )
    fail_unless(
        "Real DRAM, PHY timing, refresh, training, ECC, cache coherency, IOMMU/SMMU, and QoS"
        in memory_subsystem,
        "docs/arch/memory-subsystem.md must explicitly block real memory hierarchy claims",
        errors,
    )
    fail_unless(
        "No release, Android, AI-throughput, display-smoothness, or memory-bandwidth claim"
        in interconnect,
        "docs/arch/interconnect.md must document the release claim boundary",
        errors,
    )


def check_memory_map_consistency(contract: dict, errors: list[str]) -> None:
    memory_map = read(MEMORY_MAP)
    interconnect_rtl = read(INTERCONNECT_RTL)
    dram_rtl = read(DRAM_RTL)
    gate = yaml.safe_load(GATE.read_text())

    rows = markdown_rows(memory_map)
    dram_rows = [row for row in rows if row.get("Region") == "DRAM aperture"]
    normalized_dram_rows: list[tuple[int, int, str]] = []
    for row in dram_rows:
        try:
            normalized_dram_rows.append(
                (parse_doc_hex(row["Base"]), parse_doc_size(row["Size"]), row.get("Purpose", ""))
            )
        except (KeyError, ValueError) as exc:
            errors.append(f"malformed DRAM aperture row in memory map: {exc}")

    fail_unless(
        (
            EXPECTED_E1_CHIP_DRAM_BASE,
            EXPECTED_E1_CHIP_DRAM_BYTES,
            "SRAM-backed test DRAM visible to debug MMIO and DMA",
        )
        in normalized_dram_rows,
        "memory map must keep the e1-chip DRAM row at 0x8000_0000 / 4 KiB",
        errors,
    )
    fail_unless(
        any(
            base == EXPECTED_E1_CHIP_DRAM_BASE
            and size == EXPECTED_LINUX_DRAM_BYTES
            and "External DRAM controller/PHY boundary" in purpose
            for base, size, purpose in normalized_dram_rows
        ),
        "memory map must keep the Linux scaffold DRAM aperture at 0x8000_0000 / 256 MiB",
        errors,
    )

    dram_contract = region(contract, "dram")
    fail_unless(
        h(dram_contract["base"]) == EXPECTED_E1_CHIP_DRAM_BASE
        and h(dram_contract["size"]) == EXPECTED_E1_CHIP_DRAM_BYTES,
        "platform contract DRAM row must match the debug-visible 4 KiB memory-map row",
        errors,
    )

    rtl_regions = {
        "DRAM": (
            rtl_localparam(interconnect_rtl, "DRAM_BASE"),
            rtl_localparam(interconnect_rtl, "DRAM_MASK"),
        ),
        "INTC": (
            rtl_localparam(interconnect_rtl, "INTC_BASE"),
            rtl_localparam(interconnect_rtl, "INTC_MASK"),
        ),
        "DMA": (
            rtl_localparam(interconnect_rtl, "DMA_BASE"),
            rtl_localparam(interconnect_rtl, "DMA_MASK"),
        ),
    }
    for name, (base, mask) in rtl_regions.items():
        fail_unless(base is not None and mask is not None, f"missing RTL decode for {name}", errors)
    if all(base is not None and mask is not None for base, mask in rtl_regions.values()):
        dram_base, dram_mask = rtl_regions["DRAM"]
        assert dram_base is not None and dram_mask is not None
        fail_unless(
            dram_base == EXPECTED_E1_CHIP_DRAM_BASE and dram_mask + 1 == EXPECTED_LINUX_DRAM_BYTES,
            "interconnect DRAM decode must match the 0x8000_0000 / 256 MiB scaffold aperture",
            errors,
        )

        spans = [
            (name, base, mask + 1)
            for name, (base, mask) in rtl_regions.items()
            if base is not None and mask is not None
        ]
        for index, (name, base, size) in enumerate(spans):
            for other_name, other_base, other_size in spans[index + 1 :]:
                fail_unless(
                    not ranges_overlap(base, size, other_base, other_size),
                    f"RTL decode windows overlap: {name} and {other_name}",
                    errors,
                )

    dma_contract = region(contract, "dma")
    dma_base, dma_mask = rtl_regions["DMA"]
    if dma_base is not None and dma_mask is not None:
        fail_unless(
            h(dma_contract["base"]) == dma_base and h(dma_contract["size"]) == dma_mask + 1,
            "platform DMA MMIO row must match the AXI-Lite DMA-control decode",
            errors,
        )

    depth = dram_depth_words(dram_rtl)
    fail_unless(depth is not None, "DRAM model missing DEPTH_WORDS parameter", errors)
    if depth is not None:
        implemented_bytes = depth * EXPECTED_AXI_LITE_WORD_BYTES
        actual = gate.get("linux_scaffold_current_capability") if isinstance(gate, dict) else {}
        fail_unless(
            implemented_bytes == EXPECTED_E1_CHIP_DRAM_BYTES,
            "DRAM model implemented bytes must remain 4 KiB until gate/docs change",
            errors,
        )
        fail_unless(
            isinstance(actual, dict)
            and actual.get("usable_rtl_capacity_bytes") == implemented_bytes,
            "UMA gate usable_rtl_capacity_bytes must match e1_axi_lite_dram DEPTH_WORDS",
            errors,
        )


def check_rtl_decode(errors: list[str]) -> None:
    rtl = read(INTERCONNECT_RTL)
    contract_rtl = read(CONTRACT_RTL)
    dram_rtl = read(DRAM_RTL)

    required_patterns = {
        "DRAM base constant": r"DRAM_BASE\s*=\s*32'h8000_0000",
        "DRAM 256 MiB mask": r"DRAM_MASK\s*=\s*32'h0FFF_FFFF",
        "DRAM decode": r"\(addr\s*&\s*~DRAM_MASK\)\s*==\s*DRAM_BASE",
        "INTC base constant": r"INTC_BASE\s*=\s*32'h0C00_0000",
        "INTC decode": r"\(addr\s*&\s*~INTC_MASK\)\s*==\s*INTC_BASE",
        "DMA base constant": r"DMA_BASE\s*=\s*32'h1001_0000",
        "DMA decode": r"\(addr\s*&\s*~DMA_MASK\)\s*==\s*DMA_BASE",
        "DECERR/SLVERR response": r"RESP_SLVERR\s*=\s*2'b10",
        "unmapped read value": r"32'hDEAD_BEEF",
    }
    for name, pattern in required_patterns.items():
        fail_unless(re.search(pattern, rtl) is not None, f"interconnect RTL missing {name}", errors)

    fail_unless(
        "grant_dma_wr = !cpu_wr_req && dma_wr_req" in contract_rtl,
        "contract wrapper must preserve CPU-wins write arbitration over DMA",
        errors,
    )
    fail_unless(
        "grant_dma_rd = !cpu_rd_req && dma_rd_req" in contract_rtl,
        "contract wrapper must preserve CPU-wins read arbitration over DMA",
        errors,
    )
    fail_unless(
        "parameter int unsigned DEPTH_WORDS = 1024" in dram_rtl,
        "DRAM model must remain a small 1024-word SRAM stand-in unless docs and tests are updated",
        errors,
    )
    fail_unless(
        "s_axil_bresp <= 2'b10" in dram_rtl and "s_axil_rresp <= 2'b10" in dram_rtl,
        "DRAM model must return SLVERR for out-of-range or unaligned accesses",
        errors,
    )


def check_uma_strategy(errors: list[str]) -> None:
    data = yaml.safe_load(UMA.read_text())
    fail_unless(isinstance(data, dict), "UMA strategy must be a YAML mapping", errors)
    if not isinstance(data, dict):
        return

    fail_unless(
        data.get("schema") == "eliza.uma_coherency_validation_strategy.v1",
        "UMA strategy schema drifted",
        errors,
    )
    fail_unless(
        data.get("status") == "fail_closed_until_evidence",
        "UMA strategy must fail closed until evidence",
        errors,
    )

    axes = data.get("validation_axes")
    fail_unless(isinstance(axes, list), "UMA strategy must list validation_axes", errors)
    axis_by_id = {axis.get("id"): axis for axis in axes or [] if isinstance(axis, dict)}
    for axis_id, gate in REQUIRED_UMA_AXES.items():
        axis = axis_by_id.get(axis_id)
        fail_unless(axis is not None, f"UMA strategy missing axis {axis_id}", errors)
        if not axis:
            continue
        fail_unless(
            axis.get("release_gate") == gate,
            f"UMA axis {axis_id} must release through {gate}",
            errors,
        )
        fail_unless(
            isinstance(axis.get("minimum_tests"), list) and len(axis["minimum_tests"]) >= 4,
            f"UMA axis {axis_id} must list at least four minimum tests",
            errors,
        )
        fail_unless(
            isinstance(axis.get("evidence_gate"), dict)
            and axis["evidence_gate"].get("blocked") is True,
            f"UMA axis {axis_id} must include a blocked evidence_gate",
            errors,
        )

    artifacts = set(data.get("required_artifacts") or [])
    missing = sorted(REQUIRED_UMA_ARTIFACTS - artifacts)
    fail_unless(
        not missing, "UMA strategy missing required artifacts: " + ", ".join(missing), errors
    )

    for claim_rule in data.get("claim_rules") or []:
        fail_unless(
            "blocked" in claim_rule.lower() or "require" in claim_rule.lower(),
            f"UMA claim rule is not fail-closed: {claim_rule}",
            errors,
        )


def check_no_claim_leak(errors: list[str]) -> None:
    combined = "\n".join(
        read(path) for path in (MEMORY_MAP, MEMORY_SUBSYSTEM, INTERCONNECT, UMA)
    ).lower()
    forbidden_claims = [
        "real dram is implemented",
        "lpddr phy is implemented",
        "cache coherency is implemented",
        "iommu is implemented and enabled",
        "qos is implemented and enabled",
        "production uma is implemented",
    ]
    for claim in forbidden_claims:
        fail_unless(claim not in combined, f"forbidden unsupported claim present: {claim}", errors)


def main() -> int:
    errors: list[str] = []
    contract = json.loads(PLATFORM.read_text())
    check_e1_chip_dram_contract(contract, errors)
    check_docs(errors)
    check_memory_map_consistency(contract, errors)
    check_rtl_decode(errors)
    check_uma_strategy(errors)
    check_no_claim_leak(errors)

    if errors:
        print("Memory/interconnect contract check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("Memory/interconnect contract check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
