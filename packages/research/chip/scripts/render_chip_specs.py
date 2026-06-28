#!/usr/bin/env python3
"""Render the chip nameplate from the single source of truth.

Reads ``docs/spec-db/chip-topology.yaml`` (validated through
``spec_db_models``) and emits two derived artifacts:

  * ``build/reports/chip-nameplate.json`` — machine-readable nameplate
  * ``build/reports/chip-nameplate.md``   — human-readable datasheet stub

Both are derived; neither is hand-edited. Any consumer (README "Chip claims"
section, BSP header generation, datasheet) reads from these instead of
restating numbers.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from spec_db_models import ChipTopology, load_chip_topology

ROOT = Path(__file__).resolve().parents[1]
JSON_OUT = ROOT / "build/reports/chip-nameplate.json"
MD_OUT = ROOT / "build/reports/chip-nameplate.md"


def build_nameplate(topo: ChipTopology) -> dict[str, object]:
    cpu = topo.cpu
    return {
        "schema": "eliza.chip_nameplate.v1",
        "claim_boundary": (
            "Derived from docs/spec-db/chip-topology.yaml. Architectural "
            "targets, not silicon evidence. Promotion gated by the named "
            "evidence gates."
        ),
        "source": "docs/spec-db/chip-topology.yaml",
        "as_of": topo.as_of,
        "target_year": topo.target_year,
        "target_class": topo.target_class,
        "cpu": {
            "topology": f"{cpu.big_cores}+{cpu.mid_cores}+{cpu.little_cores}",
            "big_cores": cpu.big_cores,
            "mid_cores": cpu.mid_cores,
            "little_cores": cpu.little_cores,
            "application_cores": cpu.application_cores,
            "management_security_harts": cpu.management_security_harts,
            "big_core_clock_ghz": {
                "base": cpu.big_core_base_ghz,
                "burst": cpu.big_core_burst_ghz,
            },
            "mid_core_clock_ghz": {
                "base": cpu.mid_core_base_ghz,
                "max": cpu.mid_core_max_ghz,
            },
            "little_core_clock_ghz": {
                "base": cpu.little_core_base_ghz,
                "max": cpu.little_core_max_ghz,
            },
        },
        "memory": {
            "external_class": topo.memory.external_class,
            "baseline_sku_class": topo.memory.baseline_sku_class,
            "capacity_gib_min": topo.memory.capacity_gib_min,
            "capacity_gib_ai_sku": topo.memory.capacity_gib_ai_sku,
            "peak_bandwidth_gbps_min": topo.memory.peak_bandwidth_gbps_min,
            "sustained_bandwidth_gbps_min": topo.memory.sustained_bandwidth_gbps_min,
            "shared_system_cache_mib_min": topo.memory.shared_system_cache_mib_min,
        },
        "storage": {
            "class": topo.storage.class_,
            "fallback_class": topo.storage.fallback_class,
            "capacity_gb_min": topo.storage.capacity_gb_min,
        },
        "npu": {
            "dense_int8_peak_tops": topo.npu.dense_int8_peak_tops,
            "dense_int8_sustained_tops": topo.npu.dense_int8_sustained_tops,
            "dense_int8_base_operating_tops": topo.npu.dense_int8_base_operating_tops,
            "sparse_int4_peak_tops": topo.npu.sparse_int4_peak_tops,
            "sparse_int4_sustained_tops": topo.npu.sparse_int4_sustained_tops,
            "int2_bitnet_peak_tops": topo.npu.int2_bitnet_peak_tops,
            "fp8_peak_tflops": topo.npu.fp8_peak_tflops,
            "local_sram_mib_min": topo.npu.local_sram_mib_min,
            "tile_count_range": [topo.npu.tile_count_min, topo.npu.tile_count_max],
        },
        "fabric": {
            "axi_addr_w": topo.fabric.axi_addr_w,
            "axi_data_w": topo.fabric.axi_data_w,
            "axi_id_w": topo.fabric.axi_id_w,
            "soc_phys_addr_w": topo.fabric.soc_phys_addr_w,
            "topology": topo.fabric.topology,
            "coherence_protocol": topo.fabric.coherence_protocol,
        },
        "debug": {
            "standard": topo.debug.standard,
            "transport": topo.debug.transport,
            "status": topo.debug.status,
        },
        "process": {
            "marketing_name": topo.process.marketing_name,
            "node_range_nm": topo.process.node_range_nm,
            "selected_option_status": topo.process.selected_option_status,
        },
    }


def render_markdown(np: dict[str, object]) -> str:
    cpu = np["cpu"]
    mem = np["memory"]
    sto = np["storage"]
    npu = np["npu"]
    fab = np["fabric"]
    dbg = np["debug"]
    proc = np["process"]
    assert isinstance(cpu, dict) and isinstance(mem, dict) and isinstance(sto, dict)
    assert isinstance(npu, dict) and isinstance(fab, dict) and isinstance(dbg, dict)
    assert isinstance(proc, dict)

    lines: list[str] = []
    lines.append("# Eliza E1 — Chip Nameplate")
    lines.append("")
    lines.append(f"> {np['claim_boundary']}")
    lines.append("")
    lines.append(
        f"Generated from `{np['source']}` (as_of {np['as_of']}, "
        f"target {np['target_year']}, class `{np['target_class']}`). "
        "Do not hand-edit — run `scripts/render_chip_specs.py`."
    )
    lines.append("")
    lines.append("| Subsystem | Nameplate |")
    lines.append("|---|---|")
    lines.append(
        f"| CPU topology | {cpu['topology']} "
        f"({cpu['application_cores']} application cores "
        f"+ {cpu['management_security_harts']} mgmt/security hart) |"
    )
    big = cpu["big_core_clock_ghz"]
    mid = cpu["mid_core_clock_ghz"]
    lit = cpu["little_core_clock_ghz"]
    assert isinstance(big, dict) and isinstance(mid, dict) and isinstance(lit, dict)
    lines.append(f"| Big core clock | {big['base']} GHz base / {big['burst']} GHz burst |")
    lines.append(f"| Mid core clock | {mid['base']}–{mid['max']} GHz |")
    lines.append(f"| Little core clock | {lit['base']}–{lit['max']} GHz |")
    lines.append(
        f"| External memory | {mem['external_class']} "
        f"(baseline {mem['baseline_sku_class']}), "
        f"{mem['capacity_gib_min']}–{mem['capacity_gib_ai_sku']} GiB |"
    )
    lines.append(
        f"| Memory bandwidth | {mem['peak_bandwidth_gbps_min']} GB/s peak / "
        f"{mem['sustained_bandwidth_gbps_min']} GB/s sustained (min) |"
    )
    lines.append(f"| Shared system cache | {mem['shared_system_cache_mib_min']} MiB (min) |")
    lines.append(
        f"| Storage | {sto['class']} (fallback {sto['fallback_class']}), "
        f"{sto['capacity_gb_min']} GB (min) |"
    )
    lines.append(
        f"| NPU dense INT8 | {npu['dense_int8_peak_tops']} TOPS peak / "
        f"{npu['dense_int8_sustained_tops']} TOPS sustained "
        f"({npu['dense_int8_base_operating_tops']} TOPS base operating point) |"
    )
    lines.append(
        f"| NPU sparse INT4 | {npu['sparse_int4_peak_tops']} TOPS peak / "
        f"{npu['sparse_int4_sustained_tops']} TOPS sustained |"
    )
    lines.append(f"| NPU INT2 (BitNet) | {npu['int2_bitnet_peak_tops']} TOPS peak |")
    lines.append(f"| NPU FP8 | {npu['fp8_peak_tflops']} TFLOPS peak |")
    lines.append(
        f"| NPU local SRAM | {npu['local_sram_mib_min']} MiB (min), "
        f"{npu['tile_count_range'][0]}–{npu['tile_count_range'][1]} tiles |"
    )
    lines.append(
        f"| Fabric | {fab['topology']}, {fab['coherence_protocol']}, "
        f"AXI {fab['axi_addr_w']}/{fab['axi_data_w']}/{fab['axi_id_w']} "
        f"(addr/data/id), SoC phys addr {fab['soc_phys_addr_w']} b |"
    )
    lines.append(f"| Debug | {dbg['standard']} over {dbg['transport']} ({dbg['status']}) |")
    lines.append(
        f"| Process | {proc['marketing_name']} "
        f"({proc['node_range_nm'].replace('_', ' ')} nm), "
        f"{proc['selected_option_status']} |"
    )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    topo = load_chip_topology()
    nameplate = build_nameplate(topo)

    JSON_OUT.parent.mkdir(parents=True, exist_ok=True)
    JSON_OUT.write_text(json.dumps(nameplate, indent=2) + "\n", encoding="utf-8")
    MD_OUT.write_text(render_markdown(nameplate), encoding="utf-8")

    print(f"wrote {JSON_OUT.relative_to(ROOT)}")
    print(f"wrote {MD_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
