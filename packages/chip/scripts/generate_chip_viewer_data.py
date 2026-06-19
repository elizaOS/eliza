#!/usr/bin/env python3
"""Generate the static data bundle used by the E1 chip viewer."""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "viewer" / "chip-viewer-data.json"


def read_json(path: str) -> dict[str, Any]:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def read_text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def maybe_json(path: str) -> dict[str, Any]:
    full_path = ROOT / path
    if not full_path.exists():
        return {}
    return json.loads(full_path.read_text(encoding="utf-8"))


def first_match(pattern: str, text: str, default: str = "unknown") -> str:
    match = re.search(pattern, text, re.MULTILINE)
    return match.group(1) if match else default


def first_paragraph_after(needle: str, text: str) -> str:
    start = text.find(needle)
    if start < 0:
        return "unknown"
    paragraph = text[start:].split("\n\n", 1)[0]
    return " ".join(paragraph.split())


def load_ariane_reference() -> dict[str, Any]:
    placement = maybe_json(
        "build/ai_eda/chipbench_d/validation/records/chipbench-d-ariane133-placement-case.json"
    )
    bundle = maybe_json(
        "build/ai_eda/chipbench_d/validation/records/chipbench-d-ariane133-design-bundle.json"
    )
    movable = placement.get("movable_objects", [])
    macros = Counter(item.get("macro_name", "unknown") for item in movable)
    die = placement.get("floorplan", {}).get("die_area_um", [0, 0, 1500, 1500])
    width = max(0.0, float(die[2]) - float(die[0]))
    height = max(0.0, float(die[3]) - float(die[1]))
    sample_macros = []
    for item in movable[:80]:
        target = item.get("target_placement") or {}
        sample_macros.append(
            {
                "id": item.get("id", "macro"),
                "kind": item.get("macro_name", "macro"),
                "x": target.get("x_um", item.get("x_um", 0)),
                "y": target.get("y_um", item.get("y_um", 0)),
                "w": item.get("width_um", 0),
                "h": item.get("height_um", 0),
                "orientation": target.get("orientation", item.get("orientation", "N")),
            }
        )
    return {
        "id": "ariane133",
        "name": "Ariane/CVA6 reference floorplan",
        "status": "training-only reference, not E1 signoff",
        "technology": bundle.get("technology", {}),
        "die": {"width_um": width, "height_um": height, "area_mm2": width * height / 1_000_000},
        "macro_count": len(movable),
        "macro_histogram": dict(macros.most_common()),
        "sample_macros": sample_macros,
        "source": "build/ai_eda/chipbench_d/validation/records/chipbench-d-ariane133-placement-case.json",
        "claim_boundary": placement.get(
            "claim_boundary",
            "chipbench_d_conversion_training_only_no_e1_signoff_or_release_claim",
        ),
    }


def main() -> None:
    npu_doc = read_text("docs/arch/npu.md")
    npu_rtl = read_text("rtl/npu/e1_npu.sv")
    mmio_decode = read_text("rtl/peripherals/e1_mmio_decode.sv")
    soc_rtl = read_text("rtl/top/e1_soc_top.sv")

    cva6_coremark = read_json("docs/evidence/cpu_ap/cva6-coremark-verilator.json")
    kunminghu_coremark = read_json("docs/evidence/cpu_ap/kunminghu-coremark.json")
    rvv = read_json("docs/evidence/cpu_ap/e1-rvv-vector.json")
    npu_shape = read_json("docs/evidence/process/asap7/npu_tile_shape.json")
    npu_projection = read_json("docs/evidence/process/asap7/npu_tile_projection_n2p.json")
    npu_power = read_json("benchmarks/power/local-estimates/e1-npu-openlane-npu-estimates.json")

    opcodes = []
    for match in re.finditer(r"\|\s*`?(\d+)`?\s*\|\s*`?([A-Z0-9_]+)`?\s*\|([^|]+)\|", npu_doc):
        opcodes.append(
            {
                "opcode": int(match.group(1)),
                "name": match.group(2),
                "description": " ".join(match.group(3).replace("`", "").split()),
            }
        )

    modules = []
    for label, path, x, y, w, h, kind in [
        ("CVA6 CPU wrapper", "rtl/cpu/e1_cva6_wrapper.sv", 78, 92, 170, 112, "cpu"),
        ("AXI bridge", "rtl/cpu/e1_cpu_axi_bridge.sv", 298, 112, 132, 72, "interconnect"),
        ("MMIO decode", "rtl/peripherals/e1_mmio_decode.sv", 480, 100, 142, 86, "interconnect"),
        ("Boot ROM", "rtl/bootrom/e1_bootrom.sv", 690, 78, 122, 70, "memory"),
        ("DMA", "rtl/dma/e1_dma.sv", 682, 176, 128, 78, "io"),
        ("NPU", "rtl/npu/e1_npu.sv", 462, 262, 172, 126, "npu"),
        ("Behavioral DRAM", "rtl/memory/e1_behavioral_dram.sv", 688, 320, 168, 88, "memory"),
        ("Display", "rtl/display/e1_display.sv", 278, 328, 132, 78, "io"),
        ("Interrupts", "rtl/interrupts/e1_interrupt_controller.sv", 88, 324, 150, 76, "io"),
        ("Peripherals", "rtl/peripherals/e1_peripherals.sv", 88, 220, 156, 72, "io"),
    ]:
        modules.append({"label": label, "path": path, "x": x, "y": y, "w": w, "h": h, "kind": kind})

    public_comparisons = [
        {
            "name": "E1 current RTL NPU",
            "category": "repo RTL",
            "npu_tops": None,
            "basis": "No sustained TOPS claim; scalar/tiny-tile RTL evidence only.",
            "source": "docs/arch/npu.md",
            "claim_level": "L0 RTL/unit unless promoted by a higher evidence report",
        },
        {
            "name": "E1 open-2028 NPU model",
            "category": "architecture model",
            "npu_tops": npu_power["npu_architecture_model"]["max_observed_tops"],
            "basis": "Deterministic architecture simulation; not measured silicon or sustained power evidence.",
            "source": npu_power["source_artifacts"]["npu_architecture_benchmark_report"],
            "claim_level": npu_power["npu_architecture_model"]["claim_level"],
        },
        {
            "name": "Apple A18 Pro",
            "category": "mobile SoC",
            "npu_tops": None,
            "basis": "Apple identifies a faster 16-core Neural Engine, but the cited Apple page does not publish a TOPS number.",
            "source": "https://www.apple.com/newsroom/2024/09/apple-debuts-iphone-16-pro-and-iphone-16-pro-max/",
            "claim_level": "vendor public spec",
        },
        {
            "name": "Apple M4",
            "category": "tablet/laptop SoC",
            "npu_tops": 38,
            "basis": "Apple reports up to 38 trillion operations per second.",
            "source": "https://www.apple.com/newsroom/2024/05/apple-introduces-m4-chip/",
            "claim_level": "vendor public spec",
        },
        {
            "name": "Snapdragon X Elite",
            "category": "laptop SoC",
            "npu_tops": 45,
            "basis": "Qualcomm Hexagon NPU public spec.",
            "source": "https://www.qualcomm.com/laptops/products/snapdragon-x-elite",
            "claim_level": "vendor public spec",
        },
    ]

    data = {
        "schema": "eliza.chip_viewer.v1",
        "generated_at": "source-controlled",
        "summary": {
            "chip": "Eliza E1 RISC-V AI SoC scaffold",
            "top": "e1_soc_top",
            "rtl_top_path": "rtl/top/e1_soc_top.sv",
            "npu_top_path": "rtl/npu/e1_npu.sv",
            "current_boundary": first_paragraph_after(
                "This block is not a phone-class accelerator.", npu_doc
            ),
            "cpu_note": "E1 little core adopts CVA6/Ariane; E1 mid-core evidence is separate XS-GEM5 Kunminghu simulation.",
        },
        "layout": {
            "title": "Current E1 SoC RTL layout, logical viewer",
            "note": "Logical integration diagram derived from instantiated RTL modules, not a placed DEF/GDS die shot.",
            "modules": modules,
            "links": [
                ["CVA6 CPU wrapper", "AXI bridge"],
                ["AXI bridge", "MMIO decode"],
                ["MMIO decode", "Boot ROM"],
                ["MMIO decode", "DMA"],
                ["MMIO decode", "NPU"],
                ["MMIO decode", "Display"],
                ["MMIO decode", "Peripherals"],
                ["DMA", "Behavioral DRAM"],
                ["NPU", "Behavioral DRAM"],
                ["Display", "Behavioral DRAM"],
                ["NPU", "Interrupts"],
                ["DMA", "Interrupts"],
                ["Display", "Interrupts"],
            ],
            "mmio_map": [
                {
                    "region": "bootrom",
                    "base": "0x0000_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
                {
                    "region": "peripherals",
                    "base": "0x1000_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
                {
                    "region": "dma",
                    "base": "0x1001_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
                {
                    "region": "npu",
                    "base": "0x1002_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
                {
                    "region": "display",
                    "base": "0x1003_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
                {
                    "region": "wbuf",
                    "base": "0x1004_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
                {
                    "region": "clint",
                    "base": "0x0200_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
                {
                    "region": "dram",
                    "base": "0x8000_0000",
                    "source": "rtl/peripherals/e1_mmio_decode.sv",
                },
            ],
            "rtl_signals": {
                "npu_irq_wired": "irq_npu" in soc_rtl,
                "npu_axi_lite_master": all(
                    token in npu_rtl for token in ["m_axil_awvalid", "m_axil_arvalid"]
                ),
                "mmio_decode_mentions_npu": "npu_sel" in mmio_decode,
            },
        },
        "npu": {
            "opcodes": opcodes,
            "scratch_words": int(first_match(r"SCRATCH_WORDS\s*=\s*(\d+)", npu_rtl, "0")),
            "desc_words": int(first_match(r"DESC_WORDS\s*=\s*(\d+)", npu_rtl, "0")),
            "source_id": first_match(r"NPU_SOURCE_ID\s*=\s*24'h([0-9A-Fa-f_]+)", npu_rtl),
            "shape": {
                "gate_count_total": npu_shape["gate_count_total"],
                "sequential_cells": npu_shape["sequential_cells"],
                "std_cell_area_mm2": npu_shape["std_cell_area_mm2"],
                "estimated_std_cell_area_um2": npu_shape["estimated_std_cell_area_um2"],
                "claim_boundary": npu_shape["claim_boundary"],
            },
            "advanced_node_projection": npu_projection["projections"],
            "power_estimate": npu_power,
        },
        "benchmarks": {
            "cva6_coremark_per_mhz": cva6_coremark["metrics"]["coremark_per_mhz"],
            "kunminghu_coremark_per_mhz": kunminghu_coremark["metrics"]["coremark_per_mhz"],
            "kunminghu_vs_cva6": kunminghu_coremark["head_to_head"]["kunminghu_multiple_vs_cva6"],
            "rvv_geomean_dynamic_insn_reduction_x": rvv["geomean_dynamic_insn_reduction_x"],
            "rvv_autovectorized_count": rvv["autovectorized_count"],
            "rvv_kernel_count": rvv["kernel_count"],
            "sources": [
                "docs/evidence/cpu_ap/cva6-coremark-verilator.json",
                "docs/evidence/cpu_ap/kunminghu-coremark.json",
                "docs/evidence/cpu_ap/e1-rvv-vector.json",
            ],
        },
        "comparisons": {
            "ariane": load_ariane_reference(),
            "popular_chips": public_comparisons,
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
