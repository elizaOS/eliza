#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_wafer_model import E1XConfig, build_e1x_report  # noqa: E402

REPORT = ROOT / "build/reports/e1x_rtl_contract.json"
RTL_FILES = [
    ROOT / "rtl/e1x/e1x_pkg.sv",
    ROOT / "rtl/e1x/e1x_mesh_router.sv",
    ROOT / "rtl/e1x/e1x_local_sram_shard_loader.sv",
    ROOT / "rtl/e1x/e1x_repair_aware_router.sv",
    ROOT / "rtl/e1x/e1x_repair_mmio_programmer.sv",
    ROOT / "rtl/e1x/e1x_repair_rom_loader.sv",
    ROOT / "rtl/e1x/e1x_repair_state.sv",
    ROOT / "rtl/e1x/e1x_repair_route_table.sv",
    ROOT / "rtl/e1x/e1x_repair_routed_router.sv",
    ROOT / "rtl/e1x/e1x_repair_routed_tile.sv",
    ROOT / "rtl/e1x/e1x_repair_mmio_routed_tile.sv",
    ROOT / "rtl/e1x/e1x_tiny_core_contract.sv",
    ROOT / "rtl/e1x/e1x_tile.sv",
]


def read_param(text: str, name: str) -> int:
    match = re.search(rf"parameter\s+int\s+{re.escape(name)}\s*=\s*(\d+)\s*;", text)
    if not match:
        raise ValueError(f"missing parameter {name}")
    return int(match.group(1))


def structural_checks() -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []
    missing = [str(path.relative_to(ROOT)) for path in RTL_FILES if not path.is_file()]
    checks.append(
        {
            "id": "e1x_rtl_sources_present",
            "status": "pass" if not missing else "fail",
            "detail": "all E1X RTL contract sources present"
            if not missing
            else "missing: " + ", ".join(missing),
        }
    )
    if missing:
        return checks

    pkg = (ROOT / "rtl/e1x/e1x_pkg.sv").read_text(encoding="utf-8")
    cfg = E1XConfig()
    expected = {
        "E1X_LOGICAL_ROWS": cfg.logical_rows,
        "E1X_LOGICAL_COLS": cfg.logical_cols,
        "E1X_SPARE_ROWS": cfg.spare_rows,
        "E1X_SPARE_COLS": cfg.spare_cols,
        "E1X_LOCAL_SRAM_KIB": cfg.local_sram_kib_per_core,
        "E1X_FABRIC_PAYLOAD_BITS": cfg.fabric_payload_bits,
        "E1X_ROUTING_COLORS": cfg.routing_colors,
    }
    mismatches = []
    for name, value in expected.items():
        try:
            actual = read_param(pkg, name)
        except ValueError as exc:
            mismatches.append(str(exc))
            continue
        if actual != value:
            mismatches.append(f"{name}: rtl={actual} model={value}")
    checks.append(
        {
            "id": "e1x_rtl_params_match_model",
            "status": "pass" if not mismatches else "fail",
            "detail": "RTL package constants match E1XConfig"
            if not mismatches
            else "; ".join(mismatches),
        }
    )

    tile = (ROOT / "rtl/e1x/e1x_tile.sv").read_text(encoding="utf-8")
    required_instances = ("e1x_mesh_router", "e1x_tiny_core_contract")
    missing_instances = [name for name in required_instances if name not in tile]
    checks.append(
        {
            "id": "e1x_tile_binds_core_and_router",
            "status": "pass" if not missing_instances else "fail",
            "detail": "tile instantiates router and tiny-core contract"
            if not missing_instances
            else "missing instances: " + ", ".join(missing_instances),
        }
    )
    tile_terms = (
        "core_instr_valid_i",
        "core_instr_i",
        "core_x1_o",
        "core_x2_o",
        "core_x3_o",
        "core_x10_o",
        "core_halted_o",
        "core_active_o",
    )
    missing_tile_terms = [term for term in tile_terms if term not in tile]
    checks.append(
        {
            "id": "e1x_tile_exposes_core_instruction_and_state",
            "status": "pass" if not missing_tile_terms else "fail",
            "detail": "tile exposes instruction feed and core architectural state for integration evidence"
            if not missing_tile_terms
            else "missing terms: " + ", ".join(missing_tile_terms),
        }
    )

    router = (ROOT / "rtl/e1x/e1x_mesh_router.sv").read_text(encoding="utf-8")
    router_terms = ("route_table_i", "port_disable_i", "repair_enable_i", "repaired_drop_o")
    missing_terms = [term for term in router_terms if term not in router]
    checks.append(
        {
            "id": "e1x_router_exposes_repair_controls",
            "status": "pass" if not missing_terms else "fail",
            "detail": "router exposes route table, port disable, repair enable, and repaired-drop output"
            if not missing_terms
            else "missing terms: " + ", ".join(missing_terms),
        }
    )
    local_sram_loader = (ROOT / "rtl/e1x/e1x_local_sram_shard_loader.sv").read_text(
        encoding="utf-8"
    )
    local_sram_terms = (
        "LOCAL_SRAM_KIB",
        "load_word_addr_i",
        "load_word_i",
        "capacity_bytes_o",
        "loaded_bytes_o",
        "checksum_o",
        "overflow_o",
        "local_sram",
    )
    missing_local_sram_terms = [term for term in local_sram_terms if term not in local_sram_loader]
    checks.append(
        {
            "id": "e1x_local_sram_loader_supports_quantized_shards",
            "status": "pass" if not missing_local_sram_terms else "fail",
            "detail": "local SRAM shard loader exposes capacity, loaded-byte, checksum, and overflow evidence"
            if not missing_local_sram_terms
            else "missing terms: " + ", ".join(missing_local_sram_terms),
        }
    )
    repair_rom = (ROOT / "rtl/e1x/e1x_repair_rom_loader.sv").read_text(encoding="utf-8")
    repair_rom_terms = (
        "E1X_REPAIR_MAGIC",
        "remap_valid_o",
        "route_valid_o",
        "remap_logical_o",
        "remap_physical_o",
        "route_logical_from_o",
        "route_logical_to_o",
        "route_dir_o",
        "route_hops_o",
    )
    missing_repair_rom_terms = [term for term in repair_rom_terms if term not in repair_rom]
    checks.append(
        {
            "id": "e1x_repair_rom_loader_decodes_handoff_words",
            "status": "pass" if not missing_repair_rom_terms else "fail",
            "detail": "repair-ROM loader exposes decoded remap and route records"
            if not missing_repair_rom_terms
            else "missing terms: " + ", ".join(missing_repair_rom_terms),
        }
    )
    repair_mmio_programmer = (ROOT / "rtl/e1x/e1x_repair_mmio_programmer.sv").read_text(
        encoding="utf-8"
    )
    repair_mmio_terms = (
        "mmio_write_valid_i",
        "mmio_write_ready_o",
        "mmio_read_valid_i",
        "repair_word_valid_o",
        "repair_word_ready_i",
        "repair_clear_o",
        "words_pushed_o",
        "ADDR_PUSH",
    )
    missing_repair_mmio_terms = [
        term for term in repair_mmio_terms if term not in repair_mmio_programmer
    ]
    checks.append(
        {
            "id": "e1x_repair_mmio_programmer_streams_repair_words",
            "status": "pass" if not missing_repair_mmio_terms else "fail",
            "detail": "repair MMIO programmer stages firmware writes into repair-ROM stream words"
            if not missing_repair_mmio_terms
            else "missing terms: " + ", ".join(missing_repair_mmio_terms),
        }
    )
    repair_state = (ROOT / "rtl/e1x/e1x_repair_state.sv").read_text(encoding="utf-8")
    repair_state_terms = (
        "e1x_repair_rom_loader",
        "remap_logical_mem",
        "remap_physical_mem",
        "route_from_mem",
        "route_to_mem",
        "route_dir_mem",
        "remap_lookup_hit_o",
        "route_lookup_hit_o",
        "route_lookup_dir_o",
        "overflow_o",
    )
    missing_repair_state_terms = [term for term in repair_state_terms if term not in repair_state]
    checks.append(
        {
            "id": "e1x_repair_state_retains_rom_records",
            "status": "pass" if not missing_repair_state_terms else "fail",
            "detail": "repair state stores decoded remap and route records with lookup ports"
            if not missing_repair_state_terms
            else "missing terms: " + ", ".join(missing_repair_state_terms),
        }
    )
    repair_aware_router = (ROOT / "rtl/e1x/e1x_repair_aware_router.sv").read_text(encoding="utf-8")
    repair_aware_router_terms = (
        "repair_route_hit_i",
        "repair_route_dir_i",
        "effective_route_table",
        "repair_override_used_o",
        "e1x_mesh_router",
    )
    missing_repair_aware_router_terms = [
        term for term in repair_aware_router_terms if term not in repair_aware_router
    ]
    checks.append(
        {
            "id": "e1x_repair_aware_router_overrides_route_table",
            "status": "pass" if not missing_repair_aware_router_terms else "fail",
            "detail": "repair-aware router applies repair route direction records before mesh routing"
            if not missing_repair_aware_router_terms
            else "missing terms: " + ", ".join(missing_repair_aware_router_terms),
        }
    )
    repair_routed_router = (ROOT / "rtl/e1x/e1x_repair_routed_router.sv").read_text(encoding="utf-8")
    repair_routed_router_terms = (
        "e1x_repair_route_table",
        "e1x_repair_aware_router",
        "repair_word_valid_i",
        "in_src_logical_i",
        "in_dst_logical_i",
        "route_lookup_dir",
        "repair_override_used_o",
        "repair_overflow_o",
    )
    missing_repair_routed_router_terms = [
        term for term in repair_routed_router_terms if term not in repair_routed_router
    ]
    checks.append(
        {
            "id": "e1x_repair_routed_router_connects_rom_state_to_forwarding",
            "status": "pass" if not missing_repair_routed_router_terms else "fail",
            "detail": "repair-routed router connects ROM-loaded route records to next-hop forwarding"
            if not missing_repair_routed_router_terms
            else "missing terms: " + ", ".join(missing_repair_routed_router_terms),
        }
    )
    repair_route_table = (ROOT / "rtl/e1x/e1x_repair_route_table.sv").read_text(encoding="utf-8")
    repair_route_table_terms = (
        "LOOKUP_PORTS",
        "e1x_repair_rom_loader",
        "lookup_from_i",
        "lookup_to_i",
        "lookup_hit_o",
        "lookup_dir_o",
        "route_from_mem",
        "route_dir_mem",
        "overflow_o",
    )
    missing_repair_route_table_terms = [
        term for term in repair_route_table_terms if term not in repair_route_table
    ]
    checks.append(
        {
            "id": "e1x_repair_route_table_supports_multiport_lookup",
            "status": "pass" if not missing_repair_route_table_terms else "fail",
            "detail": "repair route table stores ROM route records and exposes multi-port lookups"
            if not missing_repair_route_table_terms
            else "missing terms: " + ", ".join(missing_repair_route_table_terms),
        }
    )
    repair_routed_tile = (ROOT / "rtl/e1x/e1x_repair_routed_tile.sv").read_text(encoding="utf-8")
    repair_routed_tile_terms = (
        "e1x_repair_routed_router",
        "e1x_tiny_core_contract",
        "repair_word_valid_i",
        "fabric_src_logical_i",
        "fabric_dst_logical_i",
        "repair_override_used_o",
    )
    missing_repair_routed_tile_terms = [
        term for term in repair_routed_tile_terms if term not in repair_routed_tile
    ]
    checks.append(
        {
            "id": "e1x_repair_routed_tile_binds_core_rom_and_fabric",
            "status": "pass" if not missing_repair_routed_tile_terms else "fail",
            "detail": "repair-routed tile binds core, repair-ROM loading, logical route metadata, and fabric routing"
            if not missing_repair_routed_tile_terms
            else "missing terms: " + ", ".join(missing_repair_routed_tile_terms),
        }
    )
    repair_mmio_routed_tile = (ROOT / "rtl/e1x/e1x_repair_mmio_routed_tile.sv").read_text(
        encoding="utf-8"
    )
    repair_mmio_routed_tile_terms = (
        "e1x_repair_mmio_programmer",
        "e1x_repair_routed_tile",
        "mmio_write_valid_i",
        "mmio_read_valid_i",
        "repair_programmer_words_pushed_o",
        "repair_override_used_o",
    )
    missing_repair_mmio_routed_tile_terms = [
        term for term in repair_mmio_routed_tile_terms if term not in repair_mmio_routed_tile
    ]
    checks.append(
        {
            "id": "e1x_repair_mmio_routed_tile_binds_programmer_to_tile",
            "status": "pass" if not missing_repair_mmio_routed_tile_terms else "fail",
            "detail": "MMIO repair-routed tile connects firmware-style repair loading to tile fabric repair"
            if not missing_repair_mmio_routed_tile_terms
            else "missing terms: " + ", ".join(missing_repair_mmio_routed_tile_terms),
        }
    )
    return checks


def model_checks() -> list[dict[str, str]]:
    report = build_e1x_report()
    defect = report["defect_testing"]
    return [
        {
            "id": "e1x_model_repairs_defect_map",
            "status": "pass" if defect["repaired_logical_mesh"] is True else "fail",
            "detail": (
                f"{defect['logical_neighbor_paths_checked']} logical neighbor routes checked; "
                f"max repaired neighbor hops={defect['max_repaired_neighbor_hops']}"
            ),
        },
        {
            "id": "e1x_model_keeps_e1_comparison",
            "status": "pass"
            if report["comparison"]["e1"]["basis"] == "open_2028_sota_160tops"
            else "fail",
            "detail": "E1 comparison remains tied to the existing Ariane/CVA6 NPU model",
        },
    ]


def verilator_check() -> dict[str, str]:
    verilator = shutil.which("verilator") or str(ROOT / "external/oss-cad-suite/bin/verilator")
    if not Path(verilator).is_file():
        return {
            "id": "e1x_verilator_lint",
            "status": "blocked",
            "detail": "verilator unavailable; structural RTL contract checks still ran",
        }
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        "-Wno-UNUSEDPARAM",
        "-Wno-UNUSEDSIGNAL",
        "-Wno-BLKSEQ",
        str(ROOT / "rtl/e1x/e1x_mesh_router.sv"),
        str(ROOT / "rtl/e1x/e1x_local_sram_shard_loader.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_aware_router.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_mmio_programmer.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_rom_loader.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_state.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_route_table.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_routed_router.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_routed_tile.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_mmio_routed_tile.sv"),
        str(ROOT / "rtl/e1x/e1x_tiny_core_contract.sv"),
        str(ROOT / "rtl/e1x/e1x_tile.sv"),
        "--top-module",
        "e1x_tile",
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    detail = (proc.stderr.strip() or proc.stdout.strip() or "lint clean")[-1000:]
    return {
        "id": "e1x_verilator_lint",
        "status": "pass" if proc.returncode == 0 else "fail",
        "detail": detail,
    }


def main() -> int:
    checks = structural_checks() + model_checks() + [verilator_check()]
    failures = [check for check in checks if check["status"] == "fail"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-rtl-contract-check",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": "E1X RTL contract and architecture-model consistency only; not a complete RISC-V core, wafer-scale RTL, PD, DFT, package, or silicon claim.",
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for check in checks if check["status"] == "pass"),
            "blocked_check_count": sum(1 for check in checks if check["status"] == "blocked"),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X RTL contract failures: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X RTL contract check; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
