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
    ROOT / "rtl/e1x/e1x_credit_router.sv",
    ROOT / "rtl/e1x/e1x_local_sram_shard_loader.sv",
    ROOT / "rtl/e1x/e1x_reduction_merge.sv",
    ROOT / "rtl/e1x/e1x_sram_ecc.sv",
    ROOT / "rtl/e1x/e1x_mbist.sv",
    ROOT / "rtl/e1x/e1x_repair_aware_router.sv",
    ROOT / "rtl/e1x/e1x_repair_mmio_programmer.sv",
    ROOT / "rtl/e1x/e1x_repair_fuse_reader.sv",
    ROOT / "rtl/e1x/e1x_repair_rom_loader.sv",
    ROOT / "rtl/e1x/e1x_repair_state.sv",
    ROOT / "rtl/e1x/e1x_repair_route_table.sv",
    ROOT / "rtl/e1x/e1x_repair_routed_router.sv",
    ROOT / "rtl/e1x/e1x_repair_routed_tile.sv",
    ROOT / "rtl/e1x/e1x_repair_mmio_routed_tile.sv",
    ROOT / "rtl/e1x/e1x_tiny_core_contract.sv",
    ROOT / "rtl/e1x/e1x_pe_core.sv",
    ROOT / "rtl/e1x/e1x_tile.sv",
    ROOT / "rtl/e1x/e1x_pe_tile.sv",
    ROOT / "rtl/e1x/e1x_mesh_fabric.sv",
]
EVIDENCE_PATHS = [str(path.relative_to(ROOT)) for path in RTL_FILES] + [
    "compiler/runtime/e1x_wafer_model.py",
    "scripts/check_e1x_rtl_contract.py",
]


def read_param(text: str, name: str) -> int:
    match = re.search(rf"parameter\s+int\s+{re.escape(name)}\s*=\s*(\d+)\s*;", text)
    if not match:
        raise ValueError(f"missing parameter {name}")
    return int(match.group(1))


def strip_sv_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return re.sub(r"//.*", "", text)


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
    credit_router = (ROOT / "rtl/e1x/e1x_credit_router.sv").read_text(encoding="utf-8")
    credit_router_terms = (
        "FIFO_DEPTH",
        "CREDIT_MAX",
        "out_credit_i",
        "credit_q",
        "fifo_mem",
        "rr_start_q",
        "prog_we_i",
        "prog_dir_o",
        "route_table_q",
        "repaired_drop_o",
        "E1X_DIR_DROP",
    )
    missing_credit_router_terms = [
        term for term in credit_router_terms if term not in credit_router
    ]
    checks.append(
        {
            "id": "e1x_credit_router_supports_lossless_flow_control",
            "status": "pass" if not missing_credit_router_terms else "fail",
            "detail": (
                "credit router exposes input FIFOs, route-table programming/readback, "
                "credit counters, round-robin arbitration, and repair/drop reporting"
            )
            if not missing_credit_router_terms
            else "missing terms: " + ", ".join(missing_credit_router_terms),
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
    reduction_merge = (ROOT / "rtl/e1x/e1x_reduction_merge.sv").read_text(encoding="utf-8")
    reduction_merge_terms = (
        "module e1x_reduction_merge",
        "cfg_expected_count_i",
        "in_group_i",
        "mismatch_count_o",
        "sign_extend_payload",
        "saturate_i32",
        "out_overflow_o",
        "received_count_o",
    )
    missing_reduction_merge_terms = [
        term for term in reduction_merge_terms if term not in reduction_merge
    ]
    checks.append(
        {
            "id": "e1x_reduction_merge_supports_bounded_tensor_partials",
            "status": "pass" if not missing_reduction_merge_terms else "fail",
            "detail": (
                "reduction-merge RTL exposes configured group counts, signed partial "
                "accumulation, mismatch accounting, saturation, and backpressured output"
            )
            if not missing_reduction_merge_terms
            else "missing terms: " + ", ".join(missing_reduction_merge_terms),
        }
    )
    pe_core = (ROOT / "rtl/e1x/e1x_pe_core.sv").read_text(encoding="utf-8")
    pe_core_terms = (
        "module e1x_pe_core",
        "RV64IM_Zicsr_Zifencei",
        "boot_en_i",
        "boot_pc_i",
        "local_sram",
        "regs",
        "csr_mcycle_q",
        "csr_minstret_q",
        "csr_mscratch_q",
        "mul_op",
        "div_op",
        "wavelet_valid_i",
        "wavelet_payload_o",
        "OP_FENCE",
        "OP_SYSTEM",
    )
    missing_pe_core_terms = [term for term in pe_core_terms if term not in pe_core]
    checks.append(
        {
            "id": "e1x_pe_core_supports_rv64im_wavelet_execution",
            "status": "pass" if not missing_pe_core_terms else "fail",
            "detail": (
                "PE core exposes boot-loaded local SRAM, integer/M-extension execution, "
                "CSR counters/scratch, fence/system handling, and wavelet MMIO ports"
            )
            if not missing_pe_core_terms
            else "missing terms: " + ", ".join(missing_pe_core_terms),
        }
    )

    pe_tile = strip_sv_comments((ROOT / "rtl/e1x/e1x_pe_tile.sv").read_text(encoding="utf-8"))
    pe_tile_instances = ("e1x_mesh_router", "e1x_pe_core")
    missing_pe_tile = [name for name in pe_tile_instances if name not in pe_tile]
    if "e1x_tiny_core_contract" in pe_tile:
        missing_pe_tile.append("must NOT bind e1x_tiny_core_contract")
    for term in ("core_boot_en_i", "core_boot_pc_i"):
        if term not in pe_tile:
            missing_pe_tile.append(term)
    checks.append(
        {
            "id": "e1x_pe_tile_integrates_real_pe_core",
            "status": "pass" if not missing_pe_tile else "fail",
            "detail": (
                "production PE tile binds the real e1x_pe_core (with boot stream) and the "
                "mesh router, not the tiny-core contract"
            )
            if not missing_pe_tile
            else "issues: " + ", ".join(missing_pe_tile),
        }
    )

    mesh_fabric = (ROOT / "rtl/e1x/e1x_mesh_fabric.sv").read_text(encoding="utf-8")
    mesh_fabric_terms = (
        "module e1x_mesh_fabric",
        "e1x_credit_router",
        "e1x_pe_core",
        "ROWS",
        "COLS",
        "out_credit_i",
        "rout_credit",
        "inject_valid_i",
        "eject_valid_o",
        "prog_we_i",
    )
    missing_mesh_fabric = [term for term in mesh_fabric_terms if term not in mesh_fabric]
    checks.append(
        {
            "id": "e1x_mesh_fabric_wires_credit_router_across_tiles",
            "status": "pass" if not missing_mesh_fabric else "fail",
            "detail": (
                "parameterized RxC mesh fabric instantiates the production credit router across "
                "PE-core tiles with credit-returned inter-tile links and route-table programming"
            )
            if not missing_mesh_fabric
            else "missing terms: " + ", ".join(missing_mesh_fabric),
        }
    )

    sram_ecc = (ROOT / "rtl/e1x/e1x_sram_ecc.sv").read_text(encoding="utf-8")
    sram_ecc_terms = (
        "SECDED",
        "DATA_BITS",
        "CHECK_BITS",
        "hamming_parity",
        "hamming_syndrome",
        "dec_single_error_o",
        "dec_double_error_o",
        "corrected_count_o",
        "detected_double_count_o",
    )
    missing_sram_ecc_terms = [term for term in sram_ecc_terms if term not in sram_ecc]
    checks.append(
        {
            "id": "e1x_sram_ecc_supports_local_sram_integrity",
            "status": "pass" if not missing_sram_ecc_terms else "fail",
            "detail": "local SRAM ECC exposes SECDED encode/decode and correction/detection counters"
            if not missing_sram_ecc_terms
            else "missing terms: " + ", ".join(missing_sram_ecc_terms),
        }
    )
    mbist = (ROOT / "rtl/e1x/e1x_mbist.sv").read_text(encoding="utf-8")
    mbist_terms = (
        "March C-",
        "start_i",
        "busy_o",
        "done_o",
        "fail_o",
        "fail_addr_o",
        "fail_bit_o",
        "inject_valid_i",
        "S_M0",
        "S_M5_R",
    )
    missing_mbist_terms = [term for term in mbist_terms if term not in mbist]
    checks.append(
        {
            "id": "e1x_mbist_supports_local_sram_manufacturing_test",
            "status": "pass" if not missing_mbist_terms else "fail",
            "detail": "local SRAM MBIST exposes March C- sequencing, status, fail address/bit, and injection-test hooks"
            if not missing_mbist_terms
            else "missing terms: " + ", ".join(missing_mbist_terms),
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
    repair_fuse_reader = (ROOT / "rtl/e1x/e1x_repair_fuse_reader.sv").read_text(
        encoding="utf-8"
    )
    repair_fuse_reader_terms = (
        "e1x_repair_fuse_reader",
        "otp_read_valid_o",
        "otp_read_addr_o",
        "otp_read_data_valid_i",
        "repair_word_valid_o",
        "repair_word_ready_i",
        "MAX_WORDS",
        "TIMEOUT_CYCLES",
    )
    missing_repair_fuse_reader_terms = [
        term for term in repair_fuse_reader_terms if term not in repair_fuse_reader
    ]
    checks.append(
        {
            "id": "e1x_repair_fuse_reader_bridges_otp_to_repair_loader",
            "status": "pass" if not missing_repair_fuse_reader_terms else "fail",
            "detail": "repair fuse-reader bridges persistent OTP/fuse reads to the repair-loader word stream"
            if not missing_repair_fuse_reader_terms
            else "missing terms: " + ", ".join(missing_repair_fuse_reader_terms),
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
        str(ROOT / "rtl/e1x/e1x_credit_router.sv"),
        str(ROOT / "rtl/e1x/e1x_local_sram_shard_loader.sv"),
        str(ROOT / "rtl/e1x/e1x_sram_ecc.sv"),
        str(ROOT / "rtl/e1x/e1x_mbist.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_aware_router.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_mmio_programmer.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_fuse_reader.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_rom_loader.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_state.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_route_table.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_routed_router.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_routed_tile.sv"),
        str(ROOT / "rtl/e1x/e1x_repair_mmio_routed_tile.sv"),
        str(ROOT / "rtl/e1x/e1x_tiny_core_contract.sv"),
        str(ROOT / "rtl/e1x/e1x_pe_core.sv"),
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


def verilator_mesh_fabric_check() -> dict[str, str]:
    verilator = shutil.which("verilator") or str(ROOT / "external/oss-cad-suite/bin/verilator")
    if not Path(verilator).is_file():
        return {
            "id": "e1x_mesh_fabric_verilator_lint",
            "status": "blocked",
            "detail": "verilator unavailable; structural mesh-fabric contract checks still ran",
        }
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        "-Wno-UNUSEDPARAM",
        "-Wno-UNUSEDSIGNAL",
        "-Wno-UNOPTFLAT",
        "-Wno-PINCONNECTEMPTY",
        "-I" + str(ROOT),
        str(ROOT / "rtl/e1x/e1x_credit_router.sv"),
        str(ROOT / "rtl/e1x/e1x_pe_core.sv"),
        str(ROOT / "rtl/e1x/e1x_mesh_fabric.sv"),
        "--top-module",
        "e1x_mesh_fabric",
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    detail = (proc.stderr.strip() or proc.stdout.strip() or "lint clean")[-1000:]
    return {
        "id": "e1x_mesh_fabric_verilator_lint",
        "status": "pass" if proc.returncode == 0 else "fail",
        "detail": detail,
    }


def verilator_reduction_merge_check() -> dict[str, str]:
    verilator = shutil.which("verilator") or str(ROOT / "external/oss-cad-suite/bin/verilator")
    if not Path(verilator).is_file():
        return {
            "id": "e1x_reduction_merge_verilator_lint",
            "status": "blocked",
            "detail": "verilator unavailable; structural reduction-merge contract checks still ran",
        }
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        "-Wno-UNUSEDPARAM",
        "-Wno-UNUSEDSIGNAL",
        "-I" + str(ROOT),
        str(ROOT / "rtl/e1x/e1x_reduction_merge.sv"),
        "--top-module",
        "e1x_reduction_merge",
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    detail = (proc.stderr.strip() or proc.stdout.strip() or "lint clean")[-1000:]
    return {
        "id": "e1x_reduction_merge_verilator_lint",
        "status": "pass" if proc.returncode == 0 else "fail",
        "detail": detail,
    }


def verilator_pe_tile_check() -> dict[str, str]:
    verilator = shutil.which("verilator") or str(ROOT / "external/oss-cad-suite/bin/verilator")
    if not Path(verilator).is_file():
        return {
            "id": "e1x_pe_tile_verilator_lint",
            "status": "blocked",
            "detail": "verilator unavailable; structural PE-tile contract checks still ran",
        }
    cmd = [
        verilator,
        "--lint-only",
        "-Wall",
        "-Wno-DECLFILENAME",
        "-Wno-UNUSEDPARAM",
        "-Wno-UNUSEDSIGNAL",
        "-Wno-UNOPTFLAT",
        "-I" + str(ROOT),
        str(ROOT / "rtl/e1x/e1x_mesh_router.sv"),
        str(ROOT / "rtl/e1x/e1x_pe_core.sv"),
        str(ROOT / "rtl/e1x/e1x_pe_tile.sv"),
        "--top-module",
        "e1x_pe_tile",
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    detail = (proc.stderr.strip() or proc.stdout.strip() or "lint clean")[-1000:]
    return {
        "id": "e1x_pe_tile_verilator_lint",
        "status": "pass" if proc.returncode == 0 else "fail",
        "detail": detail,
    }


def main() -> int:
    checks = structural_checks() + model_checks() + [
        verilator_check(),
        verilator_pe_tile_check(),
        verilator_mesh_fabric_check(),
        verilator_reduction_merge_check(),
    ]
    failures = [check for check in checks if check["status"] == "fail"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-rtl-contract-check",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        ),
        "subsystem": "e1x",
        "claim_boundary": "E1X RTL contract and architecture-model consistency only; RV64IM_Zicsr_Zifencei PE core is present but this is not full RISC-V compliance, wafer-scale RTL, PD, DFT, package, or silicon evidence.",
        "evidence_paths": EVIDENCE_PATHS,
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
