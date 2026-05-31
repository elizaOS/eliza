#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_evidence_bundle.json"

REQUIRED_REPORTS = {
    "benchmark": ROOT / "build/reports/e1x_benchmark.json",
    "yield_repair_margin": ROOT / "build/reports/e1x_yield_repair_margin.json",
    "graph_mapper": ROOT / "build/reports/e1x_graph_mapper.json",
    "kernel_codegen": ROOT / "build/reports/e1x_kernel_codegen.json",
    "model_load_stream": ROOT / "build/reports/e1x_model_load_stream.json",
    "model_shard_sample_executor": ROOT / "build/reports/e1x_model_shard_sample_executor.json",
    "layer_shard_sweep_executor": ROOT / "build/reports/e1x_layer_shard_sweep_executor.json",
    "full_payload_manifest": ROOT / "build/reports/e1x_full_payload_manifest.json",
    "full_payload_repair_mapping": ROOT / "build/reports/e1x_full_payload_repair_mapping.json",
    "full_payload_repair_rom": ROOT / "build/reports/e1x_full_payload_repair_rom.json",
    "full_payload_repaired_run": ROOT / "build/reports/e1x_full_payload_repaired_run.json",
    "tensor_numerics": ROOT / "build/reports/e1x_tensor_numerics.json",
    "tensor_cycle_executor": ROOT / "build/reports/e1x_tensor_cycle_executor.json",
    "reduction_merge_cocotb": ROOT / "build/reports/e1x_reduction_merge_cocotb.json",
    "tensor_fabric_executor": ROOT / "build/reports/e1x_tensor_fabric_executor.json",
    "tensor_output_checksum": ROOT / "build/reports/e1x_tensor_output_checksum.json",
    "full_output_coverage": ROOT / "build/reports/e1x_full_output_coverage.json",
    "execution_coverage_ladder": ROOT / "build/reports/e1x_execution_coverage_ladder.json",
    "full_output_workplan": ROOT / "build/reports/e1x_full_output_workplan.json",
    "full_output_checksum_manifest": ROOT / "build/reports/e1x_full_output_checksum_manifest.json",
    "expanded_real_weight_rows": ROOT / "build/reports/e1x_expanded_real_weight_rows.json",
    "full_norm_real_weight_rows": ROOT / "build/reports/e1x_full_norm_real_weight_rows.json",
    "vocab_sampled_k_real_weight_rows": ROOT / "build/reports/e1x_vocab_sampled_k_real_weight_rows.json",
    "repaired_real_weight_execution": ROOT / "build/reports/e1x_repaired_real_weight_execution.json",
    "attn_out_sampled_k_real_weight_rows": ROOT / "build/reports/e1x_attn_out_sampled_k_real_weight_rows.json",
    "attn_qkv_sampled_k_real_weight_rows": ROOT / "build/reports/e1x_attn_qkv_sampled_k_real_weight_rows.json",
    "mlp_gate_sampled_k_real_weight_rows": ROOT / "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json",
    "mlp_up_sampled_k_real_weight_rows": ROOT / "build/reports/e1x_mlp_up_sampled_k_real_weight_rows.json",
    "mlp_down_sampled_k_real_weight_rows": ROOT / "build/reports/e1x_mlp_down_sampled_k_real_weight_rows.json",
    "vector_kernel_template": ROOT / "build/reports/e1x_vector_kernel_template.json",
    "looped_vector_kernel_skeleton": ROOT / "build/reports/e1x_looped_vector_kernel_skeleton.json",
    "per_layer_vector_codegen": ROOT / "build/reports/e1x_per_layer_vector_codegen.json",
    "sampled_vector_kernel_executor": ROOT / "build/reports/e1x_sampled_vector_kernel_executor.json",
    "vector_kernel_window_executor": ROOT / "build/reports/e1x_vector_kernel_window_executor.json",
    "vector_window_fabric_checksum": ROOT / "build/reports/e1x_vector_window_fabric_checksum.json",
    "window_shard_linkage": ROOT / "build/reports/e1x_window_shard_linkage.json",
    "window_repair_linkage": ROOT / "build/reports/e1x_window_repair_linkage.json",
    "window_route_validation": ROOT / "build/reports/e1x_window_route_validation.json",
    "window_repair_rom_linkage": ROOT / "build/reports/e1x_window_repair_rom_linkage.json",
    "window_execution_trace_linkage": ROOT / "build/reports/e1x_window_execution_trace_linkage.json",
    "fabric_reduction": ROOT / "build/reports/e1x_fabric_reduction.json",
    "power_thermal": ROOT / "build/reports/e1x_power_thermal.json",
    "core_cocotb": ROOT / "build/reports/e1x_core_cocotb.json",
    "pe_core_cocotb": ROOT / "build/reports/e1x_pe_core_cocotb.json",
    "repair_rom_cocotb": ROOT / "build/reports/e1x_repair_rom_cocotb.json",
    "repair_capacity": ROOT / "build/reports/e1x_repair_capacity.json",
    "repair_fuse_reader": ROOT / "build/reports/e1x_repair_fuse_reader.json",
    "boot_repair_fw": ROOT / "build/reports/e1x_boot_repair_fw.json",
    "tile_cocotb": ROOT / "build/reports/e1x_tile_cocotb.json",
    "dft_cocotb": ROOT / "build/reports/e1x_dft_cocotb.json",
    "dft_strategy": ROOT / "build/reports/e1x_dft_strategy.json",
    "fabric_cocotb": ROOT / "build/reports/e1x_fabric_cocotb.json",
    "credit_router_cocotb": ROOT / "build/reports/e1x_credit_router_cocotb.json",
    "mesh_fabric_cocotb": ROOT / "build/reports/e1x_mesh_fabric_cocotb.json",
    "mesh_liveness_evidence": ROOT / "build/reports/e1x_mesh_liveness_evidence.json",
    "formal": ROOT / "build/reports/e1x_formal.json",
    "rtl_contract": ROOT / "build/reports/e1x_rtl_contract.json",
}

NORMAL_ROM_SHA = "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97"
HIGH_ROM_SHA = "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"
FRESHNESS_SKEW = timedelta(seconds=2)
GENERATED_EVIDENCE_PREFIXES = (
    "benchmarks/results/",
    "build/reports/",
    "verify/cocotb/results/",
)
CAPTURE_COMMANDS = {
    "core_cocotb": "python3 scripts/check_e1x_core_cocotb.py",
    "repair_rom_cocotb": "python3 scripts/check_e1x_repair_rom_cocotb.py",
}

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "package_claim_allowed": False,
    "pd_signoff_claim_allowed": False,
    "foundry_dft_claim_allowed": False,
    "full_wafer_execution_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
}


def load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_report_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def resolve_evidence_path(value: str) -> Path:
    path = ROOT / value
    if path.is_file():
        return path
    if value.startswith("verify/cocotb/results/"):
        archive_path = ROOT / "build/reports/cocotb" / Path(value).name
        if archive_path.is_file():
            return archive_path
    return path


def is_generated_evidence_path(value: str) -> bool:
    return value.startswith(GENERATED_EVIDENCE_PREFIXES)


def check_reports_present(reports: dict[str, dict]) -> list[dict[str, str]]:
    checks = []
    for name, path in REQUIRED_REPORTS.items():
        exists = path.is_file()
        status, detail = pass_fail(
            exists,
            f"{path.relative_to(ROOT)} present",
            f"missing {path.relative_to(ROOT)}",
        )
        checks.append({"id": f"e1x_bundle_{name}_report_present", "status": status, "detail": detail})
        if exists:
            reports[name] = load_report(path)
    return checks


def check_report_passes(name: str, report: dict) -> dict[str, str]:
    status, detail = pass_fail(
        report.get("status") == "PASS",
        f"{name} report status PASS",
        f"{name} report status is {report.get('status')}",
    )
    return {"id": f"e1x_bundle_{name}_status", "status": status, "detail": detail}


def check_report_evidence_paths(name: str, report: dict) -> list[dict[str, str]]:
    evidence_paths = report.get("evidence_paths")
    if not isinstance(evidence_paths, list) or not evidence_paths:
        return [
            {
                "id": f"e1x_bundle_{name}_evidence_paths_declared",
                "status": "fail",
                "detail": f"{name} report declares no evidence_paths",
            }
        ]
    missing = []
    invalid = []
    for value in evidence_paths:
        if not isinstance(value, str) or not value or Path(value).is_absolute():
            invalid.append(str(value))
            continue
        path = resolve_evidence_path(value)
        if not path.is_file():
            missing.append(value)
    checks = [
        {
            "id": f"e1x_bundle_{name}_evidence_paths_declared",
            "status": "pass",
            "detail": f"{len(evidence_paths)} evidence paths declared",
        }
    ]
    status, detail = pass_fail(
        not invalid and not missing,
        f"all {len(evidence_paths)} {name} evidence paths exist",
        "invalid evidence paths: "
        + ", ".join(invalid[:5])
        + ("; " if invalid and missing else "")
        + "missing evidence paths: "
        + ", ".join(missing[:5]),
    )
    checks.append({
        "id": f"e1x_bundle_{name}_evidence_paths_exist",
        "status": status,
        "detail": detail,
    })
    return checks


def collect_missing_evidence_paths(reports: dict[str, dict]) -> list[dict[str, object]]:
    missing = []
    for name, report in sorted(reports.items()):
        evidence_paths = report.get("evidence_paths")
        if not isinstance(evidence_paths, list):
            continue
        missing_paths = []
        for value in evidence_paths:
            if not isinstance(value, str) or not value or Path(value).is_absolute():
                continue
            if not resolve_evidence_path(value).is_file():
                missing_paths.append(value)
        if missing_paths:
            entry: dict[str, object] = {
                "report": name,
                "missing_count": len(missing_paths),
                "paths": missing_paths,
            }
            command = CAPTURE_COMMANDS.get(name)
            if command:
                entry["next_command"] = command
            missing.append(entry)
    return missing


def collect_dependency_counts(reports: dict[str, dict], missing_evidence: list[dict[str, object]]) -> dict[str, int]:
    declared_evidence_path_count = sum(
        len(report.get("evidence_paths", []))
        for report in reports.values()
        if isinstance(report.get("evidence_paths"), list)
    )
    return {
        "required_report_count": len(REQUIRED_REPORTS),
        "present_report_count": len(reports),
        "passing_report_count": sum(1 for report in reports.values() if report.get("status") == "PASS"),
        "declared_evidence_path_count": declared_evidence_path_count,
        "missing_evidence_path_count": sum(int(item["missing_count"]) for item in missing_evidence),
    }


def build_next_commands(missing_evidence: list[dict[str, object]]) -> list[dict[str, object]]:
    commands = []
    for item in missing_evidence:
        command = item.get("next_command")
        if not command:
            continue
        commands.append(
            {
                "report": item["report"],
                "command": command,
                "expected_outputs": item["paths"],
            }
        )
    return commands


def check_report_freshness(name: str, report: dict) -> dict[str, str]:
    report_time = parse_report_time(report.get("generated_utc") or report.get("as_of"))
    if report_time is None:
        return {
            "id": f"e1x_bundle_{name}_freshness",
            "status": "fail",
            "detail": f"{name} report has no parseable generated_utc/as_of timestamp",
        }
    evidence_paths = report.get("evidence_paths")
    if not isinstance(evidence_paths, list) or not evidence_paths:
        return {
            "id": f"e1x_bundle_{name}_freshness",
            "status": "fail",
            "detail": f"{name} report has no evidence paths for freshness checking",
        }
    newest: tuple[datetime, str] | None = None
    source_candidate_count = 0
    for value in evidence_paths:
        if not isinstance(value, str) or not value or Path(value).is_absolute():
            continue
        if is_generated_evidence_path(value):
            continue
        source_candidate_count += 1
        path = resolve_evidence_path(value)
        if not path.is_file():
            continue
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
        if newest is None or mtime > newest[0]:
            newest = (mtime, value)
    if newest is None:
        status, detail = pass_fail(
            source_candidate_count == 0,
            f"{name} report timestamp is parseable; generated evidence paths are validated separately",
            f"{name} report has no existing source evidence paths for freshness checking",
        )
        return {"id": f"e1x_bundle_{name}_freshness", "status": status, "detail": detail}
    fresh = report_time + FRESHNESS_SKEW >= newest[0]
    status, detail = pass_fail(
        fresh,
        f"{name} report timestamp covers newest source evidence path {newest[1]}",
        f"{name} report timestamp {report_time.isoformat()} is older than {newest[1]} mtime {newest[0].isoformat()}",
    )
    return {"id": f"e1x_bundle_{name}_freshness", "status": status, "detail": detail}


def main() -> int:
    reports: dict[str, dict] = {}
    checks = check_reports_present(reports)
    checks.extend(
        check_report_passes(name, report)
        for name, report in sorted(reports.items())
    )
    for name, report in sorted(reports.items()):
        checks.extend(check_report_evidence_paths(name, report))
        checks.append(check_report_freshness(name, report))

    benchmark = reports.get("benchmark", {}).get("summary", {})
    yield_repair_margin = reports.get("yield_repair_margin", {}).get("summary", {})
    repair_rom = reports.get("repair_rom_cocotb", {}).get("summary", {})
    repair_capacity = reports.get("repair_capacity", {}).get("summary", {})
    repair_fuse_reader = reports.get("repair_fuse_reader", {}).get("summary", {})
    boot_fw = reports.get("boot_repair_fw", {}).get("summary", {})
    tile = reports.get("tile_cocotb", {}).get("summary", {})
    kernel = reports.get("kernel_codegen", {}).get("summary", {})
    model_load_stream = reports.get("model_load_stream", {}).get("summary", {})
    model_shard_sample = reports.get("model_shard_sample_executor", {}).get("summary", {})
    layer_shard_sweep = reports.get("layer_shard_sweep_executor", {}).get("summary", {})
    full_payload_manifest = reports.get("full_payload_manifest", {}).get("summary", {})
    full_payload_repair = reports.get("full_payload_repair_mapping", {}).get("summary", {})
    full_payload_repair_rom = reports.get("full_payload_repair_rom", {}).get("summary", {})
    full_payload_repaired_run = reports.get("full_payload_repaired_run", {}).get("summary", {})
    tensor_numerics = reports.get("tensor_numerics", {}).get("summary", {})
    tensor_cycle = reports.get("tensor_cycle_executor", {}).get("summary", {})
    reduction_merge = reports.get("reduction_merge_cocotb", {}).get("summary", {})
    tensor_fabric = reports.get("tensor_fabric_executor", {}).get("summary", {})
    tensor_output = reports.get("tensor_output_checksum", {}).get("summary", {})
    full_output = reports.get("full_output_coverage", {}).get("summary", {})
    execution_ladder = reports.get("execution_coverage_ladder", {}).get("summary", {})
    full_workplan = reports.get("full_output_workplan", {}).get("summary", {})
    full_checksum_manifest = reports.get("full_output_checksum_manifest", {}).get("summary", {})
    expanded_real_weight = reports.get("expanded_real_weight_rows", {}).get("summary", {})
    full_norm_real_weight = reports.get("full_norm_real_weight_rows", {}).get("summary", {})
    vocab_sampled_k = reports.get("vocab_sampled_k_real_weight_rows", {}).get("summary", {})
    repaired_real_weight = reports.get("repaired_real_weight_execution", {}).get("summary", {})
    attn_out_sampled_k = reports.get("attn_out_sampled_k_real_weight_rows", {}).get("summary", {})
    attn_qkv_sampled_k = reports.get("attn_qkv_sampled_k_real_weight_rows", {}).get("summary", {})
    mlp_gate_sampled_k = reports.get("mlp_gate_sampled_k_real_weight_rows", {}).get("summary", {})
    mlp_up_sampled_k = reports.get("mlp_up_sampled_k_real_weight_rows", {}).get("summary", {})
    mlp_down_sampled_k = reports.get("mlp_down_sampled_k_real_weight_rows", {}).get("summary", {})
    vector_kernel = reports.get("vector_kernel_template", {}).get("summary", {})
    loop_skeleton = reports.get("looped_vector_kernel_skeleton", {}).get("summary", {})
    per_layer_codegen = reports.get("per_layer_vector_codegen", {}).get("summary", {})
    sampled_vector = reports.get("sampled_vector_kernel_executor", {}).get("summary", {})
    vector_window = reports.get("vector_kernel_window_executor", {}).get("summary", {})
    vector_window_fabric = reports.get("vector_window_fabric_checksum", {}).get("summary", {})
    window_shard = reports.get("window_shard_linkage", {}).get("summary", {})
    window_repair = reports.get("window_repair_linkage", {}).get("summary", {})
    window_route = reports.get("window_route_validation", {}).get("summary", {})
    window_repair_rom = reports.get("window_repair_rom_linkage", {}).get("summary", {})
    window_trace = reports.get("window_execution_trace_linkage", {}).get("summary", {})
    fabric_reduction = reports.get("fabric_reduction", {}).get("summary", {})
    power_thermal = reports.get("power_thermal", {}).get("summary", {})
    graph_mapper = reports.get("graph_mapper", {}).get("summary", {})
    core = reports.get("core_cocotb", {}).get("summary", {})
    pe_core = reports.get("pe_core_cocotb", {}).get("summary", {})
    dft = reports.get("dft_cocotb", {}).get("summary", {})
    dft_strategy = reports.get("dft_strategy", {}).get("summary", {})
    credit_router = reports.get("credit_router_cocotb", {}).get("summary", {})
    mesh_fabric = reports.get("mesh_fabric_cocotb", {}).get("summary", {})
    mesh_liveness = reports.get("mesh_liveness_evidence", {}).get("summary", {})
    fabric = reports.get("fabric_cocotb", {}).get("summary", {})

    bundle_requirements = [
        (
            "real_graph_13b_8gb_model_fits_e1x_not_e1",
            float(benchmark.get("real_graph_model_required_vs_e1_sram", 0.0)) > 100.0
            and 0.0 < float(benchmark.get("real_graph_model_required_vs_e1x_sram", 0.0)) < 1.0,
            "real graph resident model needs >100x E1 SRAM and fits within E1X SRAM",
        ),
        (
            "real_graph_normal_and_high_execution_traces",
            int(benchmark.get("real_graph_normal_execution_trace_cycles", 0)) > 0
            and int(benchmark.get("real_graph_high_failure_execution_trace_cycles", 0)) > 0
            and float(benchmark.get("real_graph_high_vs_normal_trace_cycle_ratio", 0.0)) >= 1.0,
            "normal/high real-graph execution traces exist and high-failure is no faster",
        ),
        (
            "real_graph_repair_roms_benchmark_gated",
            benchmark.get("real_graph_normal_repair_rom_sha256") == NORMAL_ROM_SHA
            and benchmark.get("real_graph_high_failure_repair_rom_sha256") == HIGH_ROM_SHA
            and int(benchmark.get("real_graph_high_failure_repair_rom_words", 0))
            > int(benchmark.get("real_graph_normal_repair_rom_words", 0)),
            "benchmark gates normal/high real-graph repair ROM sidecars",
        ),
        (
            "yield_repair_margin_high_failure_stress",
            int(yield_repair_margin.get("case_count", 0)) >= 2
            and int(yield_repair_margin.get("high_failure_remapped_cores", 0)) >= 3510
            and int(yield_repair_margin.get("normal_remapped_cores", 0)) >= 340
            and int(yield_repair_margin.get("high_failure_spare_margin", 0)) > 0
            and float(yield_repair_margin.get("high_failure_spare_utilization", 1.0)) < 0.5
            and int(yield_repair_margin.get("high_failure_route_checks", 0)) >= 8192
            and float(yield_repair_margin.get("high_vs_normal_remap_ratio", 0.0)) > 10.0
            and int(yield_repair_margin.get("failing_check_count", 1)) == 0,
            "yield/repair-margin gate validates normal/high defect maps, remaps, route samples, and spare budget",
        ),
        (
            "real_graph_repair_roms_rtl_loader_route_table",
            repair_rom.get("real_graph_normal_repair_rom_sha256") == NORMAL_ROM_SHA
            and repair_rom.get("real_graph_high_failure_repair_rom_sha256") == HIGH_ROM_SHA
            and int(repair_rom.get("testcases", 0)) >= 16
            and int(repair_rom.get("failing_check_count", 1)) == 0,
            "repair-ROM cocotb covers normal/high real-graph ROM loader and route-table paths",
        ),
        (
            "real_graph_repair_roms_boot_firmware",
            int(boot_fw.get("verified_rom_case_count", 0)) >= 3
            and bool(boot_fw.get("native_verification_passed")) is True
            and int(boot_fw.get("failing_check_count", 1)) == 0
            and int(boot_fw.get("blocked_check_count", 1)) == 0,
            "boot firmware streams scaled and real-graph repair ROM cases",
        ),
        (
            "repair_fuse_and_sram_capacity_sized",
            int(repair_capacity.get("rom_case_count", 0)) >= 3
            and int(repair_capacity.get("max_remap_entries", 0)) >= 3510
            and int(repair_capacity.get("max_total_words", 0)) >= 3582
            and int(repair_capacity.get("production_fuse_window_words", 0)) >= 4096
            and int(repair_capacity.get("production_remap_entries", 0)) >= 4096
            and 0.0 < float(repair_capacity.get("production_dedicated_repair_sram_vs_local_core_sram", 0.0)) < 1.0
            and int(repair_capacity.get("failing_check_count", 1)) == 0,
            "repair fuse/ROM window and dedicated repair SRAM are sized against normal/high-failure repair images",
        ),
        (
            "repair_fuse_reader_streams_real_rom_cases",
            int(repair_fuse_reader.get("rom_case_count", 0)) >= 3
            and int(repair_fuse_reader.get("production_fuse_window_words", 0)) >= 4096
            and int(repair_fuse_reader.get("max_streamed_word_count", 0)) >= 3582
            and 0.0 < float(repair_fuse_reader.get("max_streamed_word_count_vs_window", 0.0)) < 1.0
            and bool(repair_fuse_reader.get("verilator_lint_clean")) is True
            and repair_fuse_reader.get("residual_blocker")
            == "silicon_fuse_burning_and_foundry_otp_macro_missing"
            and int(repair_fuse_reader.get("failing_check_count", 1)) == 0,
            "repair fuse-reader RTL streams real normal/high repair images into the repair-loader contract and records OTP silicon boundary",
        ),
        (
            "real_graph_repair_roms_tile_mmio",
            tile.get("real_graph_normal_repair_rom_sha256") == NORMAL_ROM_SHA
            and tile.get("real_graph_high_failure_repair_rom_sha256") == HIGH_ROM_SHA
            and int(tile.get("testcases", 0)) >= 12
            and int(tile.get("failing_check_count", 1)) == 0,
            "tile cocotb programs normal/high real-graph ROMs through MMIO and reroutes wavelets",
        ),
        (
            "real_graph_kernel_schedule_present",
            int(kernel.get("programmed_layer_count", kernel.get("real_graph_kernel_dispatch_layers", 0))) >= 283
            or int(benchmark.get("real_graph_kernel_dispatch_layers", 0)) >= 283,
            "real-graph kernel dispatch covers the checked layer graph",
        ),
        (
            "real_graph_model_load_stream_covers_all_placed_shards",
            int(model_load_stream.get("layer_count", 0)) >= 283
            and int(model_load_stream.get("programmed_shard_records", 0)) >= 151367
            and int(model_load_stream.get("unique_logical_cores", 0)) >= 151367
            and int(model_load_stream.get("max_shard_bytes", 0))
            <= int(model_load_stream.get("placement_usable_bytes_per_core", 0))
            and int(model_load_stream.get("reserve_policy_mismatch_bytes", 1)) == 0
            and int(model_load_stream.get("stream_loader_word_transactions", 0))
            >= int(model_load_stream.get("fabric_load_wavelets", 0))
            and int(model_load_stream.get("stream_padding_bytes", 1_000_000_000))
            < int(model_load_stream.get("total_weight_bytes", 0)) * 0.001
            and int(model_load_stream.get("core_cocotb_testcases", 0)) >= 22
            and model_load_stream.get("residual_blocker")
            == "cycle_accurate_full_tensor_executor_missing"
            and int(model_load_stream.get("failing_check_count", 1)) == 0,
            "full model-load stream accounting covers every placed shard and links to local SRAM loader cocotb evidence",
        ),
        (
            "model_shard_sample_executor_runs_actual_loaded_words",
            int(model_shard_sample.get("sampled_word_count", 0)) == 9_282
            and int(model_shard_sample.get("weight_shard_word_count", 0)) == 9_281
            and int(model_shard_sample.get("sampled_shard_word_count", 0)) == 9_281
            and int(model_shard_sample.get("sentinel_word_addr", -1)) == 12287
            and int(model_shard_sample.get("recomputed_loader_checksum", 0)) == 3_823_329_054
            and int(model_shard_sample.get("executed_lane_mac_count", 0)) == 74_256
            and int(model_shard_sample.get("sample_execution_checksum", 0))
            == 6_658_997_565_743_609_885
            and 0.0 < float(model_shard_sample.get("sample_word_coverage_fraction", 0.0)) < 0.00001
            and model_shard_sample.get("residual_blocker")
            == "full_quantized_weight_payload_executor_missing"
            and int(model_shard_sample.get("failing_check_count", 1)) == 0,
            "model-shard sample executor runs one complete checked per-core W4 shard through W4A8 semantics",
        ),
        (
            "layer_shard_sweep_executor_covers_every_layer",
            int(layer_shard_sweep.get("covered_layer_count", 0)) == 283
            and int(layer_shard_sweep.get("covered_kind_count", 0)) == 8
            and int(layer_shard_sweep.get("sampled_shard_record_count", 0)) == 687
            and int(layer_shard_sweep.get("executed_loader_word_count", 0)) == 5_064_960
            and int(layer_shard_sweep.get("executed_lane_mac_count", 0)) == 40_519_680
            and int(layer_shard_sweep.get("aggregate_execution_checksum", 0))
            == 7_249_510_583_533_139_077
            and 0.001 < float(layer_shard_sweep.get("loader_word_coverage_fraction", 0.0)) < 0.01
            and layer_shard_sweep.get("residual_blocker")
            == "full_quantized_weight_payload_executor_missing"
            and int(layer_shard_sweep.get("failing_check_count", 1)) == 0,
            "layer-shard sweep executor runs generated W4 shard payloads across every placed layer",
        ),
        (
            "full_payload_manifest_commits_all_shards",
            int(full_payload_manifest.get("committed_layer_count", 0)) == 283
            and int(full_payload_manifest.get("committed_shard_record_count", 0)) == 151_367
            and int(full_payload_manifest.get("committed_logical_core_count", 0)) == 151_367
            and int(full_payload_manifest.get("committed_loader_word_count", 0)) == 1_627_034_880
            and int(full_payload_manifest.get("committed_stream_bytes", 0)) == 6_508_139_520
            and int(full_payload_manifest.get("committed_probe_word_count", 0)) == 454_101
            and int(full_payload_manifest.get("payload_manifest_checksum", 0))
            == 15_384_439_414_980_776_514
            and 0.0 < float(full_payload_manifest.get("probe_word_fraction_of_loader_stream", 0.0)) < 0.001
            and full_payload_manifest.get("residual_blocker")
            == "full_quantized_weight_payload_executor_missing"
            and int(full_payload_manifest.get("failing_check_count", 1)) == 0,
            "full-payload manifest commits every placed shard record and deterministic W4 probe identity",
        ),
        (
            "full_payload_repair_mapping_maps_all_shards",
            int(full_payload_repair.get("payload_shard_record_count", 0)) == 151_367
            and int(full_payload_repair.get("payload_loader_word_count", 0)) == 1_627_034_880
            and int(full_payload_repair.get("payload_stream_bytes", 0)) == 6_508_139_520
            and int(full_payload_repair.get("normal_payload_remapped_records", 0)) == 279
            and int(full_payload_repair.get("high_failure_payload_remapped_records", 0)) == 3_012
            and float(full_payload_repair.get("high_vs_normal_payload_remap_ratio", 0.0)) > 10.0
            and int(full_payload_repair.get("normal_route_checksum", 0)) == 3_286_450_877_122_388_120
            and int(full_payload_repair.get("high_failure_route_checksum", 0))
            == 8_141_847_437_961_269_241
            and int(full_payload_repair.get("combined_payload_repair_checksum", 0))
            == 3_128_472_446_271_365_767
            and full_payload_repair.get("residual_blocker")
            == "full_quantized_weight_payload_executor_missing"
            and int(full_payload_repair.get("failing_check_count", 1)) == 0,
            "full-payload repair mapping maps every committed shard through normal/high repaired physical targets",
        ),
        (
            "full_payload_repair_rom_programs_all_payload_remaps",
            int(full_payload_repair_rom.get("payload_shard_record_count", 0)) == 151_367
            and int(full_payload_repair_rom.get("payload_loader_word_count", 0)) == 1_627_034_880
            and int(full_payload_repair_rom.get("normal_payload_remap_word_count", 0)) == 279
            and int(full_payload_repair_rom.get("high_failure_payload_remap_word_count", 0)) == 3_012
            and full_payload_repair_rom.get("normal_payload_remap_words_sha256")
            == "b941ac08aa1daaa9037e57443bf1700625fb598d79f04de20240d60ea9ba6ddd"
            and full_payload_repair_rom.get("high_failure_payload_remap_words_sha256")
            == "ef3422c00ace7d7d61ff761036c028ef0d72b53e8f909238373b6ebfcc432fe8"
            and int(full_payload_repair_rom.get("repair_rom_cocotb_testcases", 0)) >= 16
            and int(full_payload_repair_rom.get("boot_verified_rom_case_count", 0)) == 3
            and int(full_payload_repair_rom.get("combined_payload_repair_rom_checksum", 0))
            == 14_301_024_026_748_848_141
            and full_payload_repair_rom.get("residual_blocker")
            == "silicon_fuse_burning_and_foundry_otp_macro_missing"
            and int(full_payload_repair_rom.get("failing_check_count", 1)) == 0,
            "full-payload repair ROM programs every remap word needed by resident payload shards",
        ),
        (
            "full_payload_repaired_run_links_payload_repair_and_traces",
            int(full_payload_repaired_run.get("payload_shard_record_count", 0)) == 151_367
            and int(full_payload_repaired_run.get("payload_loader_word_count", 0)) == 1_627_034_880
            and int(full_payload_repaired_run.get("normal_payload_remap_words", 0)) == 279
            and int(full_payload_repaired_run.get("high_failure_payload_remap_words", 0)) == 3_012
            and int(full_payload_repaired_run.get("normal_total_cycles", 0)) == 47_501_642_583
            and int(full_payload_repaired_run.get("high_failure_total_cycles", 0)) == 63_132_355_414
            and float(full_payload_repaired_run.get("high_vs_normal_cycle_ratio", 0.0)) > 1.3
            and 0.7 < float(full_payload_repaired_run.get("high_vs_normal_decode_tps_ratio", 0.0)) < 0.8
            and int(full_payload_repaired_run.get("normal_output_checksum", 0))
            == 8_263_636_289_739_888_019
            and int(full_payload_repaired_run.get("high_failure_output_checksum", 0))
            == 3_419_781_716_949_080_192
            and int(full_payload_repaired_run.get("combined_repaired_run_checksum", 0))
            == 3_914_641_677_513_091_882
            and full_payload_repaired_run.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(full_payload_repaired_run.get("failing_check_count", 1)) == 0,
            "full-payload repaired-run linkage ties resident payload, repair ROMs, and normal/high traces",
        ),
        (
            "real_graph_tensor_numerics_recomputed",
            int(tensor_numerics.get("proof_layer_count", 0)) >= 283
            and int(tensor_numerics.get("schedule_layer_count", 0)) >= 283
            and int(tensor_numerics.get("placement_layer_count", 0)) >= 283
            and int(tensor_numerics.get("checked_mac_count", 0)) >= 26180
            and int(tensor_numerics.get("total_assigned_cores", 0)) >= 151367
            and int(tensor_numerics.get("max_core_shard_bytes", 0)) <= 48 * 1024
            and int(tensor_numerics.get("failing_check_count", 1)) == 0,
            "independent tensor-numerics gate recomputes sampled W4A8 MACs and aligns schedule to placement",
        ),
        (
            "real_graph_tensor_cycle_executor_replays_sampled_rows",
            int(tensor_cycle.get("proof_layer_count", 0)) >= 283
            and int(tensor_cycle.get("executed_row_count", 0)) >= 1132
            and int(tensor_cycle.get("executed_mac_count", 0)) >= 26180
            and int(tensor_cycle.get("scalar_cycle_count", 0)) >= 108116
            and int(tensor_cycle.get("pe_cocotb_testcases", 0)) >= 16
            and tensor_cycle.get("residual_blocker") == "vectorized_full_tensor_fabric_executor_missing"
            and int(tensor_cycle.get("failing_check_count", 1)) == 0,
            "cycle-level scalar tensor executor replays every sampled W4A8 proof row and links to PE RTL cocotb",
        ),
        (
            "real_graph_fabric_reduction_schedule_accounting_present",
            int(fabric_reduction.get("scheduled_layer_count", 0)) >= 283
            and int(fabric_reduction.get("routing_color_count", 0)) == 24
            and int(fabric_reduction.get("used_routing_color_count", 0)) == 24
            and int(fabric_reduction.get("total_reduction_wavelets", 0)) >= 2_608_640
            and int(fabric_reduction.get("total_activation_wavelets", 0)) >= 267_978_321
            and int(fabric_reduction.get("total_fabric_wavelets", 0))
            == int(fabric_reduction.get("total_activation_wavelets", -1))
            + int(fabric_reduction.get("total_reduction_wavelets", -1))
            and int(fabric_reduction.get("peak_color_fabric_cycles", 0)) > 0
            and int(fabric_reduction.get("reduction_merge_cocotb_testcases", 0)) >= 5
            and fabric_reduction.get("residual_blocker") == "vectorized_full_tensor_fabric_executor_missing"
            and int(fabric_reduction.get("failing_check_count", 1)) == 0,
            "fabric-reduction gate recomputes scheduled reduction wavelets, links per-color timing, and requires bounded RTL merge primitive evidence",
        ),
        (
            "reduction_merge_rtl_cocotb_present",
            int(reduction_merge.get("testcases", 0)) >= 5
            and int(reduction_merge.get("expected_test_count", 0)) == 5
            and int(reduction_merge.get("failures", 1)) == 0
            and int(reduction_merge.get("errors", 1)) == 0
            and int(reduction_merge.get("missing_expected_tests", 1)) == 0
            and reduction_merge.get("residual_blocker")
            == "vectorized_full_tensor_fabric_executor_missing"
            and int(reduction_merge.get("failing_check_count", 1)) == 0,
            "bounded RTL reduction-merge primitive covers signed partial sums, backpressure, tag mismatch, config errors, and saturation",
        ),
        (
            "sampled_tensor_fabric_executor_merges_rows",
            int(tensor_fabric.get("proof_layer_count", 0)) >= 283
            and int(tensor_fabric.get("merged_group_count", 0)) >= 283
            and int(tensor_fabric.get("merged_partial_count", 0)) >= 1132
            and int(tensor_fabric.get("executed_mac_count", 0)) >= 26180
            and int(tensor_fabric.get("scalar_cycle_count", 0)) >= 108116
            and int(tensor_fabric.get("merge_cycle_count", 0)) >= 1415
            and int(tensor_fabric.get("reduction_merge_cocotb_testcases", 0)) >= 5
            and int(tensor_fabric.get("fabric_reduction_total_reduction_wavelets", 0)) >= 2_608_640
            and tensor_fabric.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(tensor_fabric.get("failing_check_count", 1)) == 0,
            "sampled tensor fabric executor merges every proof-layer row partial through RTL-merge-equivalent semantics and links to 24-color fabric accounting",
        ),
        (
            "sampled_tensor_output_checksum_present",
            int(tensor_output.get("proof_layer_count", 0)) >= 283
            and int(tensor_output.get("sampled_output_row_count", 0)) >= 1132
            and int(tensor_output.get("sampled_output_checksum", 0))
            == 14_414_877_542_268_347_137
            and int(tensor_output.get("normal_trace_output_checksum", 0)) > 0
            and int(tensor_output.get("high_failure_trace_output_checksum", 0)) > 0
            and int(tensor_output.get("normal_trace_output_checksum", 0))
            != int(tensor_output.get("high_failure_trace_output_checksum", 0))
            and int(tensor_output.get("normal_trace_sampled_layers", 0)) >= 8
            and int(tensor_output.get("high_failure_trace_sampled_layers", 0)) >= 8
            and int(tensor_output.get("tensor_fabric_executor_merged_partials", 0)) >= 1132
            and tensor_output.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(tensor_output.get("failing_check_count", 1)) == 0,
            "sampled tensor output checksum covers all proof-layer requantized outputs and links normal/high execution trace checksum sidecars",
        ),
        (
            "full_output_coverage_gap_quantified",
            int(full_output.get("full_output_row_count", 0)) == 2_608_640
            and int(full_output.get("sampled_output_row_count", 0)) == 1132
            and int(full_output.get("missing_output_row_count", 0)) == 2_607_508
            and 0.0 < float(full_output.get("output_row_coverage_fraction", 0.0)) < 0.001
            and int(full_output.get("full_mac_count", 0)) == 13_015_864_320
            and int(full_output.get("sampled_mac_count", 0)) == 26_180
            and int(full_output.get("missing_mac_count", 0)) == 13_015_838_140
            and 0.0 < float(full_output.get("mac_coverage_fraction", 0.0)) < 0.001
            and full_output.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(full_output.get("failing_check_count", 1)) == 0,
            "full-output coverage gate quantifies sampled proof coverage and preserves the vectorized full-output blocker",
        ),
        (
            "execution_coverage_ladder_tracks_vector_window_progress",
            int(execution_ladder.get("full_output_row_count", 0)) == 2_608_640
            and int(execution_ladder.get("full_mac_count", 0)) == 13_015_864_320
            and int(execution_ladder.get("real_sampled_output_row_count", 0)) == 1_132
            and int(execution_ladder.get("real_sampled_mac_count", 0)) == 26_180
            and int(execution_ladder.get("deterministic_window_row_count", 0)) == 2_608_640
            and int(execution_ladder.get("deterministic_window_lane_mac_count", 0)) == 70_620_160
            and int(execution_ladder.get("deterministic_window_remaining_row_count", 0)) == 0
            and float(execution_ladder.get("row_coverage_gain_vs_real_sample", 0.0)) > 2300.0
            and float(execution_ladder.get("lane_mac_gain_vs_real_sample", 0.0)) > 2600.0
            and int(execution_ladder.get("sampled_output_checksum", 0))
            == 14_414_877_542_268_347_137
            and int(execution_ladder.get("routed_window_checksum", 0))
            == 4_718_384_912_712_357_942
            and int(execution_ladder.get("routing_color_count", 0)) == 24
            and int(execution_ladder.get("merged_group_count", 0)) == 283
            and execution_ladder.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(execution_ladder.get("failing_check_count", 1)) == 0,
            "execution coverage ladder separates real sampled outputs from deterministic vector-window fabric progress",
        ),
        (
            "full_output_workplan_covers_scheduled_graph",
            int(full_workplan.get("workplan_layer_count", 0)) == 283
            and int(full_workplan.get("full_output_row_count", 0)) == 2_608_640
            and int(full_workplan.get("full_mac_count", 0)) == 13_015_864_320
            and int(full_workplan.get("vector_word_op_count", 0)) == 1_627_345_920
            and int(full_workplan.get("core_wave_count", 0)) == 4_187_241
            and int(full_workplan.get("k_wave_count", 0)) == 5_481
            and int(full_workplan.get("routing_color_count", 0)) == 24
            and int(full_workplan.get("placed_core_count", 0)) == 151_367
            and int(full_workplan.get("sampled_executed_partial_count", 0)) == 1_132
            and full_workplan.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and full_workplan.get("residual_blocker")
            == "full_output_vectorized_tensor_kernel_execution_missing"
            and int(full_workplan.get("failing_check_count", 1)) == 0,
            "full-output workplan covers every scheduled row/MAC/core-wave/color while preserving vectorized execution blocker",
        ),
        (
            "full_output_checksum_manifest_commits_output_targets",
            int(full_checksum_manifest.get("committed_layer_count", 0)) == 283
            and int(full_checksum_manifest.get("committed_output_row_count", 0)) == 2_608_640
            and int(full_checksum_manifest.get("committed_mac_count", 0)) == 13_015_864_320
            and int(full_checksum_manifest.get("committed_vector_word_op_count", 0)) == 1_627_345_920
            and int(full_checksum_manifest.get("committed_row_probe_count", 0)) == 849
            and int(full_checksum_manifest.get("row_identity_manifest_checksum", 0))
            == 5_613_227_195_448_189_553
            and full_checksum_manifest.get("layer_commitment_sha256")
            == "58e4218553aae175a065025d4faa702f7da4e7721a798d88d6e5e7852ec154b5"
            and int(full_checksum_manifest.get("sampled_output_checksum", 0))
            == 14_414_877_542_268_347_137
            and int(full_checksum_manifest.get("routed_window_checksum", 0))
            == 4_718_384_912_712_357_942
            and int(full_checksum_manifest.get("normal_trace_output_checksum", 0))
            == 8_263_636_289_739_888_019
            and int(full_checksum_manifest.get("high_failure_trace_output_checksum", 0))
            == 3_419_781_716_949_080_192
            and int(full_checksum_manifest.get("missing_output_row_count", 0)) == 2_607_508
            and int(full_checksum_manifest.get("missing_mac_count", 0)) == 13_015_838_140
            and full_checksum_manifest.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and full_checksum_manifest.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(full_checksum_manifest.get("failing_check_count", 1)) == 0,
            "full-output checksum manifest commits every scheduled row identity and links existing checksum evidence while preserving the real-weight blocker",
        ),
        (
            "expanded_real_weight_rows_execute_full_k_samples",
            int(expanded_real_weight.get("placement_layer_count", 0)) == 283
            and int(expanded_real_weight.get("covered_kind_count", 0)) == 8
            and int(expanded_real_weight.get("executed_full_k_output_row_count", 0)) == 849
            and int(expanded_real_weight.get("executed_full_k_mac_count", 0)) == 4_147_443
            and 0.0003 < float(expanded_real_weight.get("row_coverage_fraction", 0.0)) < 0.0004
            and 0.0003 < float(expanded_real_weight.get("mac_coverage_fraction", 0.0)) < 0.0004
            and float(expanded_real_weight.get("mac_gain_vs_microkernel_proof", 0.0)) > 158.0
            and int(expanded_real_weight.get("expanded_full_k_checksum", 0))
            == 11_081_612_788_320_878_322
            and expanded_real_weight.get("sampled_layer_result_sha256")
            == "2abc4cb9334b939b0b230cca5d4ad605ea35aba13a5940948601e52dd25ed117"
            and int(expanded_real_weight.get("microkernel_sample_mac_count", 0)) == 26_180
            and expanded_real_weight.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and expanded_real_weight.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(expanded_real_weight.get("failing_check_count", 1)) == 0,
            "expanded real-weight executor computes first/mid/last full-K W4A8 rows for every placed layer while preserving the full-output blocker",
        ),
        (
            "full_norm_real_weight_rows_execute_whole_kind",
            full_norm_real_weight.get("executed_kind") == "norm"
            and int(full_norm_real_weight.get("executed_norm_layer_count", 0)) == 81
            and int(full_norm_real_weight.get("executed_norm_output_row_count", 0)) == 414_720
            and int(full_norm_real_weight.get("executed_norm_mac_count", 0)) == 414_720
            and 0.15 < float(full_norm_real_weight.get("row_coverage_fraction", 0.0)) < 0.17
            and 0.0 < float(full_norm_real_weight.get("mac_coverage_fraction", 0.0)) < 0.0001
            and int(full_norm_real_weight.get("full_norm_real_weight_checksum", 0))
            == 1_566_824_365_644_515_702
            and full_norm_real_weight.get("sampled_norm_result_sha256")
            == "e83b0a710f70a39f82b10ff34593f0b0dc2ca95fd095e2b7ee76a5946bc9b488"
            and full_norm_real_weight.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and full_norm_real_weight.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(full_norm_real_weight.get("failing_check_count", 1)) == 0,
            "full norm real-weight executor computes every norm output row while preserving the matmul/full-output blocker",
        ),
        (
            "vocab_sampled_k_real_weight_rows_execute_singletons",
            int(vocab_sampled_k.get("executed_layer_count", 0)) == 2
            and int(vocab_sampled_k.get("sampled_k", 0)) == 128
            and int(vocab_sampled_k.get("executed_vocab_output_row_count", 0)) == 64_000
            and int(vocab_sampled_k.get("executed_vocab_sampled_k_mac_count", 0)) == 8_192_000
            and int(vocab_sampled_k.get("represented_vocab_full_k_mac_count", 0)) == 327_680_000
            and 0.02 < float(vocab_sampled_k.get("row_coverage_fraction", 0.0)) < 0.03
            and 0.0006 < float(vocab_sampled_k.get("executed_mac_coverage_fraction", 0.0)) < 0.0007
            and 0.02 < float(vocab_sampled_k.get("represented_full_k_mac_fraction", 0.0)) < 0.03
            and int(vocab_sampled_k.get("vocab_sampled_k_real_weight_checksum", 0))
            == 2_937_447_206_589_032_094
            and vocab_sampled_k.get("vocab_sampled_k_result_sha256")
            == "eefae909eba8d90f14e4b04daee33f994e791f8be981fd2dcfa1fe3fdc5bf084"
            and vocab_sampled_k.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and vocab_sampled_k.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(vocab_sampled_k.get("failing_check_count", 1)) == 0,
            "vocab sampled-K real-weight executor computes every embedding/lm_head output row over a wider K window while preserving the full-K blocker",
        ),
        (
            "repaired_real_weight_execution_preserves_outputs",
            int(repaired_real_weight.get("executed_layer_count", 0)) == 83
            and int(repaired_real_weight.get("executed_real_weight_row_count", 0)) == 478_720
            and int(repaired_real_weight.get("executed_real_weight_mac_count", 0)) == 8_606_720
            and int(repaired_real_weight.get("touched_logical_core_count", 0)) == 3_847
            and int(repaired_real_weight.get("output_invariant_checksum", 0))
            == 1_513_790_197_994_659_005
            and int(repaired_real_weight.get("normal_route_checksum", 0))
            == 5_656_197_490_747_142_705
            and int(repaired_real_weight.get("high_failure_route_checksum", 0))
            == 15_868_043_245_877_341_904
            and int(repaired_real_weight.get("normal_route_checksum", 0))
            != int(repaired_real_weight.get("high_failure_route_checksum", 0))
            and int(repaired_real_weight.get("normal_touched_remapped_rows", 0)) == 68
            and int(repaired_real_weight.get("high_failure_touched_remapped_rows", 0)) == 11_787
            and float(repaired_real_weight.get("high_vs_normal_touched_remap_ratio", 0.0)) > 170.0
            and repaired_real_weight.get("sampled_executed_rows_sha256")
            == "692863e80ac6c9cb3cb10fe4a49bcf2d66c0183838cb76ab66378ffa41d8c605"
            and repaired_real_weight.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(repaired_real_weight.get("failing_check_count", 1)) == 0,
            "repair-aware real-weight execution preserves logical outputs while normal/high-failure physical route checksums diverge",
        ),
        (
            "attn_out_sampled_k_real_weight_rows_execute_all_rows",
            attn_out_sampled_k.get("executed_layer_kind") == "attn_out_proj"
            and int(attn_out_sampled_k.get("executed_layer_count", 0)) == 40
            and int(attn_out_sampled_k.get("sampled_k", 0)) == 64
            and int(attn_out_sampled_k.get("executed_attn_out_output_row_count", 0)) == 204_800
            and int(attn_out_sampled_k.get("executed_attn_out_sampled_k_mac_count", 0)) == 13_107_200
            and int(attn_out_sampled_k.get("represented_attn_out_full_k_mac_count", 0)) == 1_048_576_000
            and 0.07 < float(attn_out_sampled_k.get("row_coverage_fraction", 0.0)) < 0.09
            and 0.001 < float(attn_out_sampled_k.get("executed_mac_coverage_fraction", 0.0)) < 0.002
            and 0.08 < float(attn_out_sampled_k.get("represented_full_k_mac_fraction", 0.0)) < 0.09
            and int(attn_out_sampled_k.get("attn_out_sampled_k_real_weight_checksum", 0))
            == 6_608_415_098_217_527_669
            and attn_out_sampled_k.get("attn_out_sampled_k_result_sha256")
            == "eb125c171f915724c435bb531c3e46399daeef673edb4e2c571b93b1fd0487aa"
            and attn_out_sampled_k.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and attn_out_sampled_k.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(attn_out_sampled_k.get("failing_check_count", 1)) == 0,
            "attn-out sampled-K real-weight executor computes every attn_out_proj output row over a bounded K window",
        ),
        (
            "attn_qkv_sampled_k_real_weight_rows_execute_all_rows",
            attn_qkv_sampled_k.get("executed_layer_kind") == "attn_qkv_proj"
            and int(attn_qkv_sampled_k.get("executed_layer_count", 0)) == 40
            and int(attn_qkv_sampled_k.get("sampled_k", 0)) == 32
            and int(attn_qkv_sampled_k.get("executed_attn_qkv_output_row_count", 0)) == 614_400
            and int(attn_qkv_sampled_k.get("executed_attn_qkv_sampled_k_mac_count", 0)) == 19_660_800
            and int(attn_qkv_sampled_k.get("represented_attn_qkv_full_k_mac_count", 0)) == 3_145_728_000
            and 0.23 < float(attn_qkv_sampled_k.get("row_coverage_fraction", 0.0)) < 0.24
            and 0.001 < float(attn_qkv_sampled_k.get("executed_mac_coverage_fraction", 0.0)) < 0.002
            and 0.24 < float(attn_qkv_sampled_k.get("represented_full_k_mac_fraction", 0.0)) < 0.25
            and int(attn_qkv_sampled_k.get("attn_qkv_sampled_k_real_weight_checksum", 0))
            == 16_749_998_878_173_451_739
            and attn_qkv_sampled_k.get("attn_qkv_sampled_k_result_sha256")
            == "7774d62c42840b0bf66082fa7e072df8f4ee9067f659451e7195488f57f74940"
            and attn_qkv_sampled_k.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and attn_qkv_sampled_k.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(attn_qkv_sampled_k.get("failing_check_count", 1)) == 0,
            "attn-qkv sampled-K real-weight executor computes every attn_qkv_proj output row over a bounded K window",
        ),
        (
            "mlp_gate_sampled_k_real_weight_rows_execute_all_rows",
            mlp_gate_sampled_k.get("executed_layer_kind") == "mlp_gate_proj"
            and int(mlp_gate_sampled_k.get("executed_layer_count", 0)) == 40
            and int(mlp_gate_sampled_k.get("sampled_k", 0)) == 32
            and int(mlp_gate_sampled_k.get("executed_mlp_gate_output_row_count", 0)) == 552_960
            and int(mlp_gate_sampled_k.get("executed_mlp_gate_sampled_k_mac_count", 0)) == 17_694_720
            and int(mlp_gate_sampled_k.get("represented_mlp_gate_full_k_mac_count", 0)) == 2_831_155_200
            and 0.21 < float(mlp_gate_sampled_k.get("row_coverage_fraction", 0.0)) < 0.22
            and 0.001 < float(mlp_gate_sampled_k.get("executed_mac_coverage_fraction", 0.0)) < 0.002
            and 0.21 < float(mlp_gate_sampled_k.get("represented_full_k_mac_fraction", 0.0)) < 0.22
            and int(mlp_gate_sampled_k.get("mlp_gate_sampled_k_real_weight_checksum", 0))
            == 644_049_328_919_108_482
            and mlp_gate_sampled_k.get("mlp_gate_sampled_k_result_sha256")
            == "042143af521f945995b1862636d90a6668be8a9fc68d776ff800251ffc4e3fc4"
            and mlp_gate_sampled_k.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and mlp_gate_sampled_k.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(mlp_gate_sampled_k.get("failing_check_count", 1)) == 0,
            "mlp-gate sampled-K real-weight executor computes every mlp_gate_proj output row over a bounded K window",
        ),
        (
            "mlp_up_sampled_k_real_weight_rows_execute_all_rows",
            mlp_up_sampled_k.get("executed_layer_kind") == "mlp_up_proj"
            and int(mlp_up_sampled_k.get("executed_layer_count", 0)) == 40
            and int(mlp_up_sampled_k.get("sampled_k", 0)) == 32
            and int(mlp_up_sampled_k.get("executed_mlp_up_output_row_count", 0)) == 552_960
            and int(mlp_up_sampled_k.get("executed_mlp_up_sampled_k_mac_count", 0)) == 17_694_720
            and int(mlp_up_sampled_k.get("represented_mlp_up_full_k_mac_count", 0)) == 2_831_155_200
            and 0.21 < float(mlp_up_sampled_k.get("row_coverage_fraction", 0.0)) < 0.22
            and 0.001 < float(mlp_up_sampled_k.get("executed_mac_coverage_fraction", 0.0)) < 0.002
            and 0.21 < float(mlp_up_sampled_k.get("represented_full_k_mac_fraction", 0.0)) < 0.22
            and int(mlp_up_sampled_k.get("mlp_up_sampled_k_real_weight_checksum", 0))
            == 5_263_540_896_081_439_006
            and mlp_up_sampled_k.get("mlp_up_sampled_k_result_sha256")
            == "9886ad2306ea36a3d73135fea7ea73fad37f07ec6c891b5d5b10a94d4fac74c2"
            and mlp_up_sampled_k.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and mlp_up_sampled_k.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(mlp_up_sampled_k.get("failing_check_count", 1)) == 0,
            "mlp-up sampled-K real-weight executor computes every mlp_up_proj output row over a bounded K window",
        ),
        (
            "mlp_down_sampled_k_real_weight_rows_execute_all_rows",
            mlp_down_sampled_k.get("executed_layer_kind") == "mlp_down_proj"
            and int(mlp_down_sampled_k.get("executed_layer_count", 0)) == 40
            and int(mlp_down_sampled_k.get("sampled_k", 0)) == 32
            and int(mlp_down_sampled_k.get("executed_mlp_down_output_row_count", 0)) == 204_800
            and int(mlp_down_sampled_k.get("executed_mlp_down_sampled_k_mac_count", 0)) == 6_553_600
            and int(mlp_down_sampled_k.get("represented_mlp_down_full_k_mac_count", 0)) == 2_831_155_200
            and 0.07 < float(mlp_down_sampled_k.get("row_coverage_fraction", 0.0)) < 0.08
            and 0.0005 < float(mlp_down_sampled_k.get("executed_mac_coverage_fraction", 0.0)) < 0.001
            and 0.21 < float(mlp_down_sampled_k.get("represented_full_k_mac_fraction", 0.0)) < 0.22
            and int(mlp_down_sampled_k.get("mlp_down_sampled_k_real_weight_checksum", 0))
            == 3_360_713_502_265_478_628
            and mlp_down_sampled_k.get("mlp_down_sampled_k_result_sha256")
            == "a3d640fdc0ae8a55cacdaa0e61bfbfdade39cf9b30d14c291656d579a6b26495"
            and mlp_down_sampled_k.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and mlp_down_sampled_k.get("residual_blocker")
            == "full_output_real_weight_checksum_missing"
            and int(mlp_down_sampled_k.get("failing_check_count", 1)) == 0,
            "mlp-down sampled-K real-weight executor computes every mlp_down_proj output row over a bounded K window",
        ),
        (
            "vector_kernel_template_scales_to_workplan",
            int(vector_kernel.get("template_instruction_words", 0)) == 54
            and vector_kernel.get("template_sha256")
            == "3e98428c1de7d7f7ca9c549bcdc48699fddaaf0da38bf37a723c68f3f712b18c"
            and int(vector_kernel.get("load_instruction_count", 0)) == 9
            and int(vector_kernel.get("opimm_instruction_count", 0)) == 26
            and int(vector_kernel.get("op_instruction_count", 0)) == 16
            and int(vector_kernel.get("store_instruction_count", 0)) == 2
            and int(vector_kernel.get("vector_word_op_count", 0)) == 1_627_345_920
            and int(vector_kernel.get("full_template_instruction_estimate", 0)) == 87_876_679_680
            and vector_kernel.get("workplan_sha256")
            == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
            and vector_kernel.get("residual_blocker")
            == "looped_vector_kernel_codegen_and_full_execution_missing"
            and int(vector_kernel.get("failing_check_count", 1)) == 0,
            "vector-kernel template emits concrete RV64IM W4A8 vector-word program and scales it against full-output workplan",
        ),
        (
            "looped_vector_kernel_skeleton_scales_to_workplan",
            int(loop_skeleton.get("skeleton_instruction_words", 0)) == 11
            and loop_skeleton.get("skeleton_sha256")
            == "9422315bcb1a9f158be7d795c6fc386a3c65e31907b80cb5a3cc743d4145dfd3"
            and int(loop_skeleton.get("branch_instruction_count", 0)) == 4
            and int(loop_skeleton.get("opimm_instruction_count", 0)) == 6
            and int(loop_skeleton.get("full_output_row_count", 0)) == 2_608_640
            and int(loop_skeleton.get("vector_word_op_count", 0)) == 1_627_345_920
            and int(loop_skeleton.get("template_instruction_estimate", 0)) == 87_876_679_680
            and int(loop_skeleton.get("loop_control_instruction_estimate", 0)) == 6_517_209_600
            and int(loop_skeleton.get("combined_template_plus_loop_instruction_estimate", 0))
            == 94_393_889_280
            and loop_skeleton.get("residual_blocker")
            == "per_layer_looped_vector_kernel_codegen_execution_missing"
            and int(loop_skeleton.get("failing_check_count", 1)) == 0,
            "looped vector-kernel skeleton emits branch/control words and scales loop overhead against full-output workplan",
        ),
        (
            "per_layer_vector_codegen_covers_workplan",
            int(per_layer_codegen.get("codegen_layer_count", 0)) == 283
            and int(per_layer_codegen.get("template_body_instruction_estimate", 0))
            == 87_876_679_680
            and int(per_layer_codegen.get("loop_control_instruction_estimate", 0))
            == 6_517_209_600
            and int(per_layer_codegen.get("total_kernel_instruction_estimate", 0))
            == 94_393_889_280
            and int(per_layer_codegen.get("routing_color_count", 0)) == 24
            and per_layer_codegen.get("per_layer_codegen_sha256")
            == "3815c04bfb38c664d3215e0b268e6ed8d801a7a075a1dab6ab1174d4e4635956"
            and per_layer_codegen.get("template_sha256")
            == "3e98428c1de7d7f7ca9c549bcdc48699fddaaf0da38bf37a723c68f3f712b18c"
            and per_layer_codegen.get("skeleton_sha256")
            == "9422315bcb1a9f158be7d795c6fc386a3c65e31907b80cb5a3cc743d4145dfd3"
            and per_layer_codegen.get("residual_blocker")
            == "full_output_vector_kernel_execution_missing"
            and int(per_layer_codegen.get("failing_check_count", 1)) == 0,
            "per-layer vector-kernel codegen combines template and loop skeleton accounting for every scheduled layer",
        ),
        (
            "sampled_vector_kernel_executor_replays_proof_rows",
            int(sampled_vector.get("proof_layer_count", 0)) == 283
            and int(sampled_vector.get("executed_row_count", 0)) == 1_132
            and int(sampled_vector.get("executed_vector_word_op_count", 0)) == 3_556
            and int(sampled_vector.get("executed_lane_mac_count", 0)) == 26_180
            and int(sampled_vector.get("proof_aggregate_checksum", 0)) == 32_681_797
            and sampled_vector.get("sampled_vector_trace_sha256")
            == "f26180ab548688b9ff9f8f47bde426285c160ce99b08a55e6b35eed459ae607c"
            and sampled_vector.get("per_layer_codegen_sha256")
            == "3815c04bfb38c664d3215e0b268e6ed8d801a7a075a1dab6ab1174d4e4635956"
            and int(sampled_vector.get("pe_cocotb_testcases", 0)) >= 16
            and sampled_vector.get("residual_blocker")
            == "full_output_vector_kernel_execution_missing"
            and int(sampled_vector.get("failing_check_count", 1)) == 0,
            "sampled vector-kernel executor replays packed int4 vector-word operations for every proof layer",
        ),
        (
            "vector_kernel_window_executor_expands_execution_rows",
            int(vector_window.get("window_rows_per_layer", 0)) == 32_768
            and int(vector_window.get("proof_layer_count", 0)) == 283
            and int(vector_window.get("executed_row_count", 0)) == 2_608_640
            and int(vector_window.get("executed_vector_word_op_count", 0)) == 9_190_400
            and int(vector_window.get("executed_lane_mac_count", 0)) == 70_620_160
            and int(vector_window.get("full_output_row_count", 0)) == 2_608_640
            and int(vector_window.get("full_output_vector_word_op_count", 0)) == 1_627_345_920
            and int(vector_window.get("window_output_checksum", 0)) == 4_033_574_925_821_332_798
            and vector_window.get("window_record_sha256")
            == "199aaf62b4087ce224234c27bd0f4a8595535c21278f832de4f25bc47c23640f"
            and vector_window.get("sampled_vector_trace_sha256")
            == "f26180ab548688b9ff9f8f47bde426285c160ce99b08a55e6b35eed459ae607c"
            and vector_window.get("residual_blocker")
            == "full_output_vector_kernel_execution_missing"
            and int(vector_window.get("failing_check_count", 1)) == 0,
            "vector-kernel window executor expands deterministic packed-vector execution to every scheduled output row",
        ),
        (
            "vector_window_fabric_checksum_routes_window_outputs",
            int(vector_window_fabric.get("window_rows_per_layer", 0)) == 32_768
            and int(vector_window_fabric.get("proof_layer_count", 0)) == 283
            and int(vector_window_fabric.get("executed_row_count", 0)) == 2_608_640
            and int(vector_window_fabric.get("executed_vector_word_op_count", 0)) == 9_190_400
            and int(vector_window_fabric.get("executed_lane_mac_count", 0)) == 70_620_160
            and int(vector_window_fabric.get("merged_group_count", 0)) == 283
            and int(vector_window_fabric.get("window_merge_cycle_count", 0)) == 2_608_923
            and int(vector_window_fabric.get("routing_color_count", 0)) == 24
            and int(vector_window_fabric.get("routed_window_checksum", 0))
            == 4_718_384_912_712_357_942
            and vector_window_fabric.get("color_record_sha256")
            == "0de6d5fb8a46de54765f2f301a1fcc5407dcf4ec29ac05023056267019201bd0"
            and int(vector_window_fabric.get("vector_window_checksum", 0))
            == 4_033_574_925_821_332_798
            and int(vector_window_fabric.get("reduction_merge_cocotb_testcases", 0)) >= 5
            and int(vector_window_fabric.get("fabric_reduction_total_reduction_wavelets", 0))
            == 2_608_640
            and vector_window_fabric.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(vector_window_fabric.get("failing_check_count", 1)) == 0,
            "vector-window fabric checksum routes and reduces the expanded vector execution window by layer/color",
        ),
        (
            "window_shard_linkage_maps_execution_to_loaded_shards",
            int(window_shard.get("window_rows_per_layer", 0)) == 32_768
            and int(window_shard.get("placement_layer_count", 0)) == 283
            and int(window_shard.get("window_executed_row_count", 0)) == 2_608_640
            and int(window_shard.get("window_touched_shard_records", 0)) == 151_367
            and int(window_shard.get("window_touched_logical_cores", 0)) == 151_367
            and int(window_shard.get("window_touched_shard_bytes", 0)) == 6_508_139_520
            and int(window_shard.get("window_touched_loader_words", 0)) == 1_627_034_880
            and int(window_shard.get("total_programmed_shard_records", 0)) == 151_367
            and int(window_shard.get("total_stream_loader_word_transactions", 0)) == 1_627_034_880
            and int(window_shard.get("routed_window_checksum", 0)) == 4_718_384_912_712_357_942
            and window_shard.get("touched_shard_record_sha256")
            == "2d65679ad9dfcfe90582587e7ed2912d0e72d1d09c0d795087cb0e4ccb9e1f68"
            and window_shard.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(window_shard.get("failing_check_count", 1)) == 0,
            "window-shard linkage maps executed vector-window rows to loaded model SRAM shards",
        ),
        (
            "window_repair_linkage_maps_execution_to_repaired_cores",
            int(window_repair.get("window_touched_core_count", 0)) == 151_367
            and window_repair.get("window_touched_core_sha256")
            == "fc1928d24739ad1ee15f2c5d866850aa12cec35555fcc11109917898e42b0e6b"
            and int(window_repair.get("normal_window_remapped_core_count", 0)) == 279
            and int(window_repair.get("high_failure_window_remapped_core_count", 0)) == 3_012
            and int(window_repair.get("normal_window_direct_core_count", 0)) == 151_088
            and int(window_repair.get("high_failure_window_direct_core_count", 0)) == 148_355
            and int(window_repair.get("normal_total_remapped_core_count", 0)) == 340
            and int(window_repair.get("high_failure_total_remapped_core_count", 0)) == 3_510
            and float(window_repair.get("window_high_vs_normal_remap_ratio", 0.0)) > 10.0
            and int(window_repair.get("routed_window_checksum", 0)) == 4_718_384_912_712_357_942
            and window_repair.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(window_repair.get("failing_check_count", 1)) == 0,
            "window-repair linkage maps executed vector-window cores through normal/high repaired physical targets",
        ),
        (
            "window_route_validation_checks_repaired_neighbor_paths",
            int(window_route.get("window_touched_core_count", 0)) == 151_367
            and int(window_route.get("window_neighbor_edge_count", 0)) == 301_949
            and int(window_route.get("normal_window_extra_repair_hops", 0)) == 167_619
            and int(window_route.get("high_failure_window_extra_repair_hops", 0)) == 1_809_664
            and int(window_route.get("normal_window_max_repaired_neighbor_hops", 0)) == 342
            and int(window_route.get("high_failure_window_max_repaired_neighbor_hops", 0)) == 355
            and int(window_route.get("normal_window_remapped_neighbor_edges", 0)) > 0
            and int(window_route.get("high_failure_window_remapped_neighbor_edges", 0)) > 0
            and int(window_route.get("normal_window_route_checksum", 0)) == 3_286_450_877_122_388_120
            and int(window_route.get("high_failure_window_route_checksum", 0))
            == 8_141_847_437_961_269_241
            and float(window_route.get("high_vs_normal_window_extra_hop_ratio", 0.0)) > 10.0
            and window_route.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(window_route.get("failing_check_count", 1)) == 0,
            "window route validation checks repaired physical paths for adjacent executed-window cores",
        ),
        (
            "window_repair_rom_linkage_programs_window_remaps",
            int(window_repair_rom.get("window_touched_core_count", 0)) == 151_367
            and int(window_repair_rom.get("normal_window_remap_word_count", 0)) == 279
            and int(window_repair_rom.get("high_failure_window_remap_word_count", 0)) == 3_012
            and window_repair_rom.get("normal_window_remap_words_sha256")
            == "b941ac08aa1daaa9037e57443bf1700625fb598d79f04de20240d60ea9ba6ddd"
            and window_repair_rom.get("high_failure_window_remap_words_sha256")
            == "ef3422c00ace7d7d61ff761036c028ef0d72b53e8f909238373b6ebfcc432fe8"
            and window_repair_rom.get("normal_repair_rom_sha256")
            == "7911d1a3f892202baa2f39f6277d7efda42ac1d7a35e37c9bc3b597f8473cd97"
            and window_repair_rom.get("high_failure_repair_rom_sha256")
            == "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"
            and int(window_repair_rom.get("normal_rom_total_word_count", 0)) == 412
            and int(window_repair_rom.get("high_failure_rom_total_word_count", 0)) == 3_582
            and int(window_repair_rom.get("repair_rom_cocotb_testcases", 0)) >= 16
            and int(window_repair_rom.get("boot_verified_rom_case_count", 0)) == 3
            and int(window_repair_rom.get("window_route_high_failure_checksum", 0))
            == 8_141_847_437_961_269_241
            and window_repair_rom.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(window_repair_rom.get("failing_check_count", 1)) == 0,
            "window repair-ROM linkage proves programmed repair images contain remaps needed by executed-window cores",
        ),
        (
            "window_execution_trace_linkage_ties_repair_to_slowdown",
            int(window_trace.get("normal_total_cycles", 0)) == 47_501_642_583
            and int(window_trace.get("high_failure_total_cycles", 0)) == 63_132_355_414
            and float(window_trace.get("high_vs_normal_trace_cycle_ratio", 0.0)) > 1.3
            and float(window_trace.get("high_vs_normal_repair_hop_penalty_ratio", 0.0)) > 8.0
            and float(window_trace.get("window_high_vs_normal_extra_hop_ratio", 0.0)) > 10.0
            and int(window_trace.get("normal_output_checksum", 0)) == 8_263_636_289_739_888_019
            and int(window_trace.get("high_failure_output_checksum", 0)) == 3_419_781_716_949_080_192
            and int(window_trace.get("normal_route_checks", 0)) == 4_096
            and int(window_trace.get("high_failure_route_checks", 0)) == 8_192
            and window_trace.get("high_failure_repair_rom_sha256")
            == "9f2710a5266260fe9885f22954d14f3e6787840d5c6b0bf36781a051e42e29da"
            and int(window_trace.get("high_failure_window_remap_word_count", 0)) == 3_012
            and int(window_trace.get("high_failure_window_route_checksum", 0))
            == 8_141_847_437_961_269_241
            and window_trace.get("residual_blocker")
            == "full_output_vectorized_tensor_fabric_executor_missing"
            and int(window_trace.get("failing_check_count", 1)) == 0,
            "window execution-trace linkage ties repair ROM/window route evidence to normal/high benchmark traces",
        ),
        (
            "power_thermal_planning_model_present",
            int(power_thermal.get("logical_cores", 0)) == 175104
            and float(power_thermal.get("local_sram_mib", 0.0)) == 8208.0
            and float(power_thermal.get("peak_package_power_w", 0.0))
            < float(power_thermal.get("cooling_envelope_w", 0.0))
            and float(power_thermal.get("peak_power_density_w_per_mm2", 1.0)) < 0.5
            and 0.0 < float(power_thermal.get("schedule_energy_j", 0.0)) < 1.0
            and int(power_thermal.get("failing_check_count", 1)) == 0,
            "planning-grade power/thermal model covers peak dense and real-graph schedule envelopes",
        ),
        (
            "real_graph_mapper_placement_present",
            int(graph_mapper.get("passing_check_count", 0)) >= 8
            and not graph_mapper.get("failures", [1]),
            "graph mapper report covers manifest parsing, 13B placement, SRAM fit, colors, determinism, and wafer consistency",
        ),
        (
            "tiny_core_and_pe_core_cocotb_present",
            int(core.get("testcases", 0)) >= 22
            and int(pe_core.get("testcases", 0)) >= 16
            and int(core.get("failing_check_count", 1)) == 0
            and int(pe_core.get("failing_check_count", 1)) == 0,
            "tiny-core, local-SRAM loader, PE-core, and generated W4A8 PE execution cocotb coverage is present",
        ),
        (
            "sram_ecc_mbist_dft_cocotb_present",
            int(dft.get("testcases", 0)) >= 7
            and int(dft.get("failing_check_count", 1)) == 0
            and int(dft.get("failures", 1)) == 0
            and int(dft.get("errors", 1)) == 0,
            "local SRAM ECC and MBIST DFT cocotb coverage is present",
        ),
        (
            "dft_strategy_fail_closed_boundary_present",
            int(dft_strategy.get("required_section_count", 0)) >= 7
            and int(dft_strategy.get("required_phrase_count", 0)) >= 6
            and int(dft_strategy.get("blocked_marker_count", 0)) >= 1
            and int(dft_strategy.get("evidence_path_count", 0)) >= 7
            and int(dft_strategy.get("failing_check_count", 1)) == 0,
            "DFT strategy document couples ECC/MBIST evidence to fail-closed foundry scan/ATPG/silicon boundary",
        ),
        (
            "credit_router_flow_control_cocotb_present",
            int(credit_router.get("testcases", 0)) >= 8
            and int(credit_router.get("failing_check_count", 1)) == 0
            and int(credit_router.get("missing_expected_tests", 1)) == 0
            and int(credit_router.get("failures", 1)) == 0
            and int(credit_router.get("errors", 1)) == 0
            and int(fabric.get("testcases", 0)) >= 23,
            "production credit router covers routing, backpressure, credit recovery, arbitration, drops, and chained delivery",
        ),
        (
            "mesh_fabric_multihop_cocotb_present",
            int(mesh_fabric.get("testcases", 0)) >= 4
            and int(mesh_fabric.get("failing_check_count", 1)) == 0
            and int(mesh_fabric.get("missing_expected_tests", 1)) == 0
            and int(mesh_fabric.get("failures", 1)) == 0
            and int(mesh_fabric.get("errors", 1)) == 0,
            "parameterized mesh fabric covers real PE wavelet injection, multi-hop XY delivery, and independent colors",
        ),
        (
            "mesh_route_discipline_liveness_evidence_present",
            int(mesh_liveness.get("mesh_fabric_testcases", 0)) >= 4
            and int(mesh_liveness.get("credit_router_testcases", 0)) >= 8
            and int(mesh_liveness.get("formal_check_count", 0)) >= 8
            and int(mesh_liveness.get("expected_mesh_test_count", 0)) == 4
            and int(mesh_liveness.get("mesh_route_marker_count", 0)) >= 8
            and int(mesh_liveness.get("credit_route_marker_count", 0)) >= 6
            and int(mesh_liveness.get("formal_safety_marker_count", 0)) >= 6
            and mesh_liveness.get("residual_blocker") == "full_formal_network_liveness_proof_missing"
            and int(mesh_liveness.get("failing_check_count", 1)) == 0,
            "mesh route-discipline evidence ties XY routing, credit-router safety formal, and 4x4 mesh cocotb while preserving full-liveness blocker",
        ),
        (
            "fabric_schedule_uses_high_failure_repair_penalty",
            float(benchmark.get("real_graph_schedule_execution_repair_hop_penalty", -1.0))
            == float(benchmark.get("real_graph_high_failure_repair_hop_penalty", -2.0))
            and int(benchmark.get("real_graph_fabric_color_used_colors", 0)) == 24,
            "schedule/fabric evidence uses high-failure repair penalty and all routing colors",
        ),
    ]
    for req_id, condition, detail in bundle_requirements:
        status, resolved_detail = pass_fail(condition, detail)
        checks.append({"id": f"e1x_bundle_{req_id}", "status": status, "detail": resolved_detail})

    failures = [check for check in checks if check["status"] != "pass"]
    missing_evidence = collect_missing_evidence_paths(reports)
    dependency_counts = collect_dependency_counts(reports, missing_evidence)
    next_commands = build_next_commands(missing_evidence)
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "evidence_path_check_count": len(
            [check for check in checks if check["id"].endswith("_evidence_paths_exist")]
        ),
        "freshness_check_count": len(
            [check for check in checks if check["id"].endswith("_freshness")]
        ),
        "real_graph_normal_repair_rom_sha256": str(benchmark.get("real_graph_normal_repair_rom_sha256", "")),
        "real_graph_high_failure_repair_rom_sha256": str(benchmark.get("real_graph_high_failure_repair_rom_sha256", "")),
        "real_graph_model_required_mib": float(benchmark.get("real_graph_model_required_mib", 0.0)),
        "real_graph_model_required_vs_e1_sram": float(benchmark.get("real_graph_model_required_vs_e1_sram", 0.0)),
        "real_graph_model_required_vs_e1x_sram": float(benchmark.get("real_graph_model_required_vs_e1x_sram", 0.0)),
        "real_graph_high_vs_normal_trace_cycle_ratio": float(
            benchmark.get("real_graph_high_vs_normal_trace_cycle_ratio", 0.0)
        ),
        "yield_high_failure_spare_margin": int(yield_repair_margin.get("high_failure_spare_margin", 0)),
        "yield_high_failure_spare_utilization": float(
            yield_repair_margin.get("high_failure_spare_utilization", 0.0)
        ),
        "yield_high_vs_normal_remap_ratio": float(
            yield_repair_margin.get("high_vs_normal_remap_ratio", 0.0)
        ),
        "boot_verified_rom_case_count": int(boot_fw.get("verified_rom_case_count", 0)),
        "repair_capacity_rom_case_count": int(repair_capacity.get("rom_case_count", 0)),
        "repair_capacity_fuse_window_words": int(repair_capacity.get("production_fuse_window_words", 0)),
        "repair_capacity_dedicated_sram_bytes": int(
            repair_capacity.get("production_dedicated_repair_sram_bytes", 0)
        ),
        "repair_fuse_reader_max_streamed_word_count": int(
            repair_fuse_reader.get("max_streamed_word_count", 0)
        ),
        "repair_fuse_reader_verilator_lint_clean": bool(repair_fuse_reader.get("verilator_lint_clean")),
        "repair_fuse_reader_residual_blocker": str(repair_fuse_reader.get("residual_blocker", "")),
        "repair_rom_cocotb_testcases": int(repair_rom.get("testcases", 0)),
        "tile_cocotb_testcases": int(tile.get("testcases", 0)),
        "core_cocotb_testcases": int(core.get("testcases", 0)),
        "pe_core_cocotb_testcases": int(pe_core.get("testcases", 0)),
        "dft_cocotb_testcases": int(dft.get("testcases", 0)),
        "dft_strategy_required_sections": int(dft_strategy.get("required_section_count", 0)),
        "dft_strategy_blocked_marker_count": int(dft_strategy.get("blocked_marker_count", 0)),
        "model_load_stream_programmed_shard_records": int(
            model_load_stream.get("programmed_shard_records", 0)
        ),
        "model_load_stream_loader_word_transactions": int(
            model_load_stream.get("stream_loader_word_transactions", 0)
        ),
        "model_load_stream_reserve_policy_mismatch_bytes": int(
            model_load_stream.get("reserve_policy_mismatch_bytes", -1)
        ),
        "model_load_stream_residual_blocker": str(model_load_stream.get("residual_blocker", "")),
        "model_shard_sample_executor_words": int(model_shard_sample.get("sampled_word_count", 0)),
        "model_shard_sample_executor_shard_words": int(
            model_shard_sample.get("sampled_shard_word_count", 0)
        ),
        "model_shard_sample_executor_lane_macs": int(
            model_shard_sample.get("executed_lane_mac_count", 0)
        ),
        "model_shard_sample_executor_checksum": int(
            model_shard_sample.get("sample_execution_checksum", 0)
        ),
        "model_shard_sample_executor_payload_sha256": str(
            model_shard_sample.get("sample_payload_sha256", "")
        ),
        "model_shard_sample_executor_coverage_fraction": float(
            model_shard_sample.get("sample_word_coverage_fraction", 0.0)
        ),
        "model_shard_sample_executor_residual_blocker": str(
            model_shard_sample.get("residual_blocker", "")
        ),
        "layer_shard_sweep_executor_layers": int(layer_shard_sweep.get("covered_layer_count", 0)),
        "layer_shard_sweep_executor_kinds": int(layer_shard_sweep.get("covered_kind_count", 0)),
        "layer_shard_sweep_executor_records": int(
            layer_shard_sweep.get("sampled_shard_record_count", 0)
        ),
        "layer_shard_sweep_executor_words": int(
            layer_shard_sweep.get("executed_loader_word_count", 0)
        ),
        "layer_shard_sweep_executor_lane_macs": int(
            layer_shard_sweep.get("executed_lane_mac_count", 0)
        ),
        "layer_shard_sweep_executor_checksum": int(
            layer_shard_sweep.get("aggregate_execution_checksum", 0)
        ),
        "layer_shard_sweep_executor_coverage_fraction": float(
            layer_shard_sweep.get("loader_word_coverage_fraction", 0.0)
        ),
        "layer_shard_sweep_executor_result_sha256": str(
            layer_shard_sweep.get("sampled_result_sha256", "")
        ),
        "layer_shard_sweep_executor_residual_blocker": str(
            layer_shard_sweep.get("residual_blocker", "")
        ),
        "full_payload_manifest_layers": int(full_payload_manifest.get("committed_layer_count", 0)),
        "full_payload_manifest_shard_records": int(
            full_payload_manifest.get("committed_shard_record_count", 0)
        ),
        "full_payload_manifest_loader_words": int(
            full_payload_manifest.get("committed_loader_word_count", 0)
        ),
        "full_payload_manifest_stream_bytes": int(
            full_payload_manifest.get("committed_stream_bytes", 0)
        ),
        "full_payload_manifest_probe_words": int(
            full_payload_manifest.get("committed_probe_word_count", 0)
        ),
        "full_payload_manifest_probe_fraction": float(
            full_payload_manifest.get("probe_word_fraction_of_loader_stream", 0.0)
        ),
        "full_payload_manifest_checksum": int(
            full_payload_manifest.get("payload_manifest_checksum", 0)
        ),
        "full_payload_manifest_layer_sha256": str(
            full_payload_manifest.get("layer_commitment_sha256", "")
        ),
        "full_payload_manifest_record_sha256": str(
            full_payload_manifest.get("sampled_record_sha256", "")
        ),
        "full_payload_manifest_residual_blocker": str(
            full_payload_manifest.get("residual_blocker", "")
        ),
        "full_payload_repair_mapping_shards": int(
            full_payload_repair.get("payload_shard_record_count", 0)
        ),
        "full_payload_repair_mapping_loader_words": int(
            full_payload_repair.get("payload_loader_word_count", 0)
        ),
        "full_payload_repair_mapping_normal_remaps": int(
            full_payload_repair.get("normal_payload_remapped_records", 0)
        ),
        "full_payload_repair_mapping_high_failure_remaps": int(
            full_payload_repair.get("high_failure_payload_remapped_records", 0)
        ),
        "full_payload_repair_mapping_remap_ratio": float(
            full_payload_repair.get("high_vs_normal_payload_remap_ratio", 0.0)
        ),
        "full_payload_repair_mapping_normal_checksum": int(
            full_payload_repair.get("normal_payload_mapping_checksum", 0)
        ),
        "full_payload_repair_mapping_high_failure_checksum": int(
            full_payload_repair.get("high_failure_payload_mapping_checksum", 0)
        ),
        "full_payload_repair_mapping_combined_checksum": int(
            full_payload_repair.get("combined_payload_repair_checksum", 0)
        ),
        "full_payload_repair_mapping_case_sha256": str(
            full_payload_repair.get("case_summary_sha256", "")
        ),
        "full_payload_repair_mapping_residual_blocker": str(
            full_payload_repair.get("residual_blocker", "")
        ),
        "full_payload_repair_rom_normal_remap_words": int(
            full_payload_repair_rom.get("normal_payload_remap_word_count", 0)
        ),
        "full_payload_repair_rom_high_failure_remap_words": int(
            full_payload_repair_rom.get("high_failure_payload_remap_word_count", 0)
        ),
        "full_payload_repair_rom_normal_sha256": str(
            full_payload_repair_rom.get("normal_payload_remap_words_sha256", "")
        ),
        "full_payload_repair_rom_high_failure_sha256": str(
            full_payload_repair_rom.get("high_failure_payload_remap_words_sha256", "")
        ),
        "full_payload_repair_rom_normal_program_checksum": int(
            full_payload_repair_rom.get("normal_payload_remap_program_checksum", 0)
        ),
        "full_payload_repair_rom_high_failure_program_checksum": int(
            full_payload_repair_rom.get("high_failure_payload_remap_program_checksum", 0)
        ),
        "full_payload_repair_rom_combined_checksum": int(
            full_payload_repair_rom.get("combined_payload_repair_rom_checksum", 0)
        ),
        "full_payload_repair_rom_case_sha256": str(
            full_payload_repair_rom.get("case_summary_sha256", "")
        ),
        "full_payload_repair_rom_residual_blocker": str(
            full_payload_repair_rom.get("residual_blocker", "")
        ),
        "full_payload_repaired_run_normal_cycles": int(
            full_payload_repaired_run.get("normal_total_cycles", 0)
        ),
        "full_payload_repaired_run_high_failure_cycles": int(
            full_payload_repaired_run.get("high_failure_total_cycles", 0)
        ),
        "full_payload_repaired_run_cycle_ratio": float(
            full_payload_repaired_run.get("high_vs_normal_cycle_ratio", 0.0)
        ),
        "full_payload_repaired_run_decode_tps_ratio": float(
            full_payload_repaired_run.get("high_vs_normal_decode_tps_ratio", 0.0)
        ),
        "full_payload_repaired_run_normal_output_checksum": int(
            full_payload_repaired_run.get("normal_output_checksum", 0)
        ),
        "full_payload_repaired_run_high_failure_output_checksum": int(
            full_payload_repaired_run.get("high_failure_output_checksum", 0)
        ),
        "full_payload_repaired_run_combined_checksum": int(
            full_payload_repaired_run.get("combined_repaired_run_checksum", 0)
        ),
        "full_payload_repaired_run_normal_trace_sha256": str(
            full_payload_repaired_run.get("normal_trace_sha256", "")
        ),
        "full_payload_repaired_run_high_failure_trace_sha256": str(
            full_payload_repaired_run.get("high_failure_trace_sha256", "")
        ),
        "full_payload_repaired_run_residual_blocker": str(
            full_payload_repaired_run.get("residual_blocker", "")
        ),
        "tensor_numerics_checked_mac_count": int(tensor_numerics.get("checked_mac_count", 0)),
        "tensor_numerics_proof_layer_count": int(tensor_numerics.get("proof_layer_count", 0)),
        "tensor_numerics_total_assigned_cores": int(tensor_numerics.get("total_assigned_cores", 0)),
        "tensor_cycle_executor_executed_row_count": int(tensor_cycle.get("executed_row_count", 0)),
        "tensor_cycle_executor_scalar_cycle_count": int(tensor_cycle.get("scalar_cycle_count", 0)),
        "tensor_cycle_executor_residual_blocker": str(tensor_cycle.get("residual_blocker", "")),
        "reduction_merge_cocotb_testcases": int(reduction_merge.get("testcases", 0)),
        "reduction_merge_residual_blocker": str(reduction_merge.get("residual_blocker", "")),
        "tensor_fabric_executor_merged_partial_count": int(
            tensor_fabric.get("merged_partial_count", 0)
        ),
        "tensor_fabric_executor_merge_cycle_count": int(tensor_fabric.get("merge_cycle_count", 0)),
        "tensor_fabric_executor_total_sampled_cycles": int(
            tensor_fabric.get("total_sampled_fabric_executor_cycles", 0)
        ),
        "tensor_fabric_executor_residual_blocker": str(tensor_fabric.get("residual_blocker", "")),
        "tensor_output_sampled_row_count": int(tensor_output.get("sampled_output_row_count", 0)),
        "tensor_output_sampled_checksum": int(tensor_output.get("sampled_output_checksum", 0)),
        "tensor_output_residual_blocker": str(tensor_output.get("residual_blocker", "")),
        "full_output_missing_row_count": int(full_output.get("missing_output_row_count", 0)),
        "full_output_missing_mac_count": int(full_output.get("missing_mac_count", 0)),
        "full_output_row_coverage_fraction": float(
            full_output.get("output_row_coverage_fraction", 0.0)
        ),
        "full_output_mac_coverage_fraction": float(full_output.get("mac_coverage_fraction", 0.0)),
        "full_output_residual_blocker": str(full_output.get("residual_blocker", "")),
        "execution_ladder_real_sampled_rows": int(
            execution_ladder.get("real_sampled_output_row_count", 0)
        ),
        "execution_ladder_deterministic_window_rows": int(
            execution_ladder.get("deterministic_window_row_count", 0)
        ),
        "execution_ladder_row_coverage_gain": float(
            execution_ladder.get("row_coverage_gain_vs_real_sample", 0.0)
        ),
        "execution_ladder_window_remaining_rows": int(
            execution_ladder.get("deterministic_window_remaining_row_count", 0)
        ),
        "execution_ladder_routed_window_checksum": int(
            execution_ladder.get("routed_window_checksum", 0)
        ),
        "execution_ladder_residual_blocker": str(execution_ladder.get("residual_blocker", "")),
        "full_output_workplan_vector_word_op_count": int(
            full_workplan.get("vector_word_op_count", 0)
        ),
        "full_output_workplan_core_wave_count": int(full_workplan.get("core_wave_count", 0)),
        "full_output_workplan_sha256": str(full_workplan.get("workplan_sha256", "")),
        "full_output_workplan_residual_blocker": str(full_workplan.get("residual_blocker", "")),
        "full_output_checksum_manifest_rows": int(
            full_checksum_manifest.get("committed_output_row_count", 0)
        ),
        "full_output_checksum_manifest_macs": int(
            full_checksum_manifest.get("committed_mac_count", 0)
        ),
        "full_output_checksum_manifest_probe_count": int(
            full_checksum_manifest.get("committed_row_probe_count", 0)
        ),
        "full_output_checksum_manifest_checksum": int(
            full_checksum_manifest.get("row_identity_manifest_checksum", 0)
        ),
        "full_output_checksum_manifest_layer_sha256": str(
            full_checksum_manifest.get("layer_commitment_sha256", "")
        ),
        "full_output_checksum_manifest_sampled_output_checksum": int(
            full_checksum_manifest.get("sampled_output_checksum", 0)
        ),
        "full_output_checksum_manifest_routed_window_checksum": int(
            full_checksum_manifest.get("routed_window_checksum", 0)
        ),
        "full_output_checksum_manifest_normal_trace_checksum": int(
            full_checksum_manifest.get("normal_trace_output_checksum", 0)
        ),
        "full_output_checksum_manifest_high_failure_trace_checksum": int(
            full_checksum_manifest.get("high_failure_trace_output_checksum", 0)
        ),
        "full_output_checksum_manifest_residual_blocker": str(
            full_checksum_manifest.get("residual_blocker", "")
        ),
        "expanded_real_weight_rows": int(
            expanded_real_weight.get("executed_full_k_output_row_count", 0)
        ),
        "expanded_real_weight_macs": int(expanded_real_weight.get("executed_full_k_mac_count", 0)),
        "expanded_real_weight_mac_gain": float(
            expanded_real_weight.get("mac_gain_vs_microkernel_proof", 0.0)
        ),
        "expanded_real_weight_checksum": int(
            expanded_real_weight.get("expanded_full_k_checksum", 0)
        ),
        "expanded_real_weight_result_sha256": str(
            expanded_real_weight.get("sampled_layer_result_sha256", "")
        ),
        "expanded_real_weight_residual_blocker": str(
            expanded_real_weight.get("residual_blocker", "")
        ),
        "full_norm_real_weight_layers": int(
            full_norm_real_weight.get("executed_norm_layer_count", 0)
        ),
        "full_norm_real_weight_rows": int(
            full_norm_real_weight.get("executed_norm_output_row_count", 0)
        ),
        "full_norm_real_weight_macs": int(
            full_norm_real_weight.get("executed_norm_mac_count", 0)
        ),
        "full_norm_real_weight_row_fraction": float(
            full_norm_real_weight.get("row_coverage_fraction", 0.0)
        ),
        "full_norm_real_weight_checksum": int(
            full_norm_real_weight.get("full_norm_real_weight_checksum", 0)
        ),
        "full_norm_real_weight_result_sha256": str(
            full_norm_real_weight.get("sampled_norm_result_sha256", "")
        ),
        "full_norm_real_weight_residual_blocker": str(
            full_norm_real_weight.get("residual_blocker", "")
        ),
        "vocab_sampled_k_layers": int(vocab_sampled_k.get("executed_layer_count", 0)),
        "vocab_sampled_k_value": int(vocab_sampled_k.get("sampled_k", 0)),
        "vocab_sampled_k_rows": int(vocab_sampled_k.get("executed_vocab_output_row_count", 0)),
        "vocab_sampled_k_macs": int(
            vocab_sampled_k.get("executed_vocab_sampled_k_mac_count", 0)
        ),
        "vocab_sampled_k_represented_full_k_macs": int(
            vocab_sampled_k.get("represented_vocab_full_k_mac_count", 0)
        ),
        "vocab_sampled_k_row_fraction": float(
            vocab_sampled_k.get("row_coverage_fraction", 0.0)
        ),
        "vocab_sampled_k_checksum": int(
            vocab_sampled_k.get("vocab_sampled_k_real_weight_checksum", 0)
        ),
        "vocab_sampled_k_result_sha256": str(
            vocab_sampled_k.get("vocab_sampled_k_result_sha256", "")
        ),
        "vocab_sampled_k_residual_blocker": str(vocab_sampled_k.get("residual_blocker", "")),
        "repaired_real_weight_rows": int(
            repaired_real_weight.get("executed_real_weight_row_count", 0)
        ),
        "repaired_real_weight_macs": int(
            repaired_real_weight.get("executed_real_weight_mac_count", 0)
        ),
        "repaired_real_weight_touched_cores": int(
            repaired_real_weight.get("touched_logical_core_count", 0)
        ),
        "repaired_real_weight_output_checksum": int(
            repaired_real_weight.get("output_invariant_checksum", 0)
        ),
        "repaired_real_weight_normal_route_checksum": int(
            repaired_real_weight.get("normal_route_checksum", 0)
        ),
        "repaired_real_weight_high_failure_route_checksum": int(
            repaired_real_weight.get("high_failure_route_checksum", 0)
        ),
        "repaired_real_weight_high_failure_remapped_rows": int(
            repaired_real_weight.get("high_failure_touched_remapped_rows", 0)
        ),
        "repaired_real_weight_remap_ratio": float(
            repaired_real_weight.get("high_vs_normal_touched_remap_ratio", 0.0)
        ),
        "repaired_real_weight_residual_blocker": str(
            repaired_real_weight.get("residual_blocker", "")
        ),
        "attn_out_sampled_k_layers": int(attn_out_sampled_k.get("executed_layer_count", 0)),
        "attn_out_sampled_k_value": int(attn_out_sampled_k.get("sampled_k", 0)),
        "attn_out_sampled_k_rows": int(
            attn_out_sampled_k.get("executed_attn_out_output_row_count", 0)
        ),
        "attn_out_sampled_k_macs": int(
            attn_out_sampled_k.get("executed_attn_out_sampled_k_mac_count", 0)
        ),
        "attn_out_sampled_k_represented_full_k_macs": int(
            attn_out_sampled_k.get("represented_attn_out_full_k_mac_count", 0)
        ),
        "attn_out_sampled_k_row_fraction": float(
            attn_out_sampled_k.get("row_coverage_fraction", 0.0)
        ),
        "attn_out_sampled_k_checksum": int(
            attn_out_sampled_k.get("attn_out_sampled_k_real_weight_checksum", 0)
        ),
        "attn_out_sampled_k_result_sha256": str(
            attn_out_sampled_k.get("attn_out_sampled_k_result_sha256", "")
        ),
        "attn_out_sampled_k_residual_blocker": str(
            attn_out_sampled_k.get("residual_blocker", "")
        ),
        "attn_qkv_sampled_k_layers": int(attn_qkv_sampled_k.get("executed_layer_count", 0)),
        "attn_qkv_sampled_k_value": int(attn_qkv_sampled_k.get("sampled_k", 0)),
        "attn_qkv_sampled_k_rows": int(
            attn_qkv_sampled_k.get("executed_attn_qkv_output_row_count", 0)
        ),
        "attn_qkv_sampled_k_macs": int(
            attn_qkv_sampled_k.get("executed_attn_qkv_sampled_k_mac_count", 0)
        ),
        "attn_qkv_sampled_k_represented_full_k_macs": int(
            attn_qkv_sampled_k.get("represented_attn_qkv_full_k_mac_count", 0)
        ),
        "attn_qkv_sampled_k_row_fraction": float(
            attn_qkv_sampled_k.get("row_coverage_fraction", 0.0)
        ),
        "attn_qkv_sampled_k_checksum": int(
            attn_qkv_sampled_k.get("attn_qkv_sampled_k_real_weight_checksum", 0)
        ),
        "attn_qkv_sampled_k_result_sha256": str(
            attn_qkv_sampled_k.get("attn_qkv_sampled_k_result_sha256", "")
        ),
        "attn_qkv_sampled_k_residual_blocker": str(
            attn_qkv_sampled_k.get("residual_blocker", "")
        ),
        "mlp_gate_sampled_k_layers": int(mlp_gate_sampled_k.get("executed_layer_count", 0)),
        "mlp_gate_sampled_k_value": int(mlp_gate_sampled_k.get("sampled_k", 0)),
        "mlp_gate_sampled_k_rows": int(
            mlp_gate_sampled_k.get("executed_mlp_gate_output_row_count", 0)
        ),
        "mlp_gate_sampled_k_macs": int(
            mlp_gate_sampled_k.get("executed_mlp_gate_sampled_k_mac_count", 0)
        ),
        "mlp_gate_sampled_k_represented_full_k_macs": int(
            mlp_gate_sampled_k.get("represented_mlp_gate_full_k_mac_count", 0)
        ),
        "mlp_gate_sampled_k_row_fraction": float(
            mlp_gate_sampled_k.get("row_coverage_fraction", 0.0)
        ),
        "mlp_gate_sampled_k_checksum": int(
            mlp_gate_sampled_k.get("mlp_gate_sampled_k_real_weight_checksum", 0)
        ),
        "mlp_gate_sampled_k_result_sha256": str(
            mlp_gate_sampled_k.get("mlp_gate_sampled_k_result_sha256", "")
        ),
        "mlp_gate_sampled_k_residual_blocker": str(
            mlp_gate_sampled_k.get("residual_blocker", "")
        ),
        "mlp_up_sampled_k_layers": int(mlp_up_sampled_k.get("executed_layer_count", 0)),
        "mlp_up_sampled_k_value": int(mlp_up_sampled_k.get("sampled_k", 0)),
        "mlp_up_sampled_k_rows": int(
            mlp_up_sampled_k.get("executed_mlp_up_output_row_count", 0)
        ),
        "mlp_up_sampled_k_macs": int(
            mlp_up_sampled_k.get("executed_mlp_up_sampled_k_mac_count", 0)
        ),
        "mlp_up_sampled_k_represented_full_k_macs": int(
            mlp_up_sampled_k.get("represented_mlp_up_full_k_mac_count", 0)
        ),
        "mlp_up_sampled_k_row_fraction": float(
            mlp_up_sampled_k.get("row_coverage_fraction", 0.0)
        ),
        "mlp_up_sampled_k_checksum": int(
            mlp_up_sampled_k.get("mlp_up_sampled_k_real_weight_checksum", 0)
        ),
        "mlp_up_sampled_k_result_sha256": str(
            mlp_up_sampled_k.get("mlp_up_sampled_k_result_sha256", "")
        ),
        "mlp_up_sampled_k_residual_blocker": str(
            mlp_up_sampled_k.get("residual_blocker", "")
        ),
        "mlp_down_sampled_k_layers": int(mlp_down_sampled_k.get("executed_layer_count", 0)),
        "mlp_down_sampled_k_value": int(mlp_down_sampled_k.get("sampled_k", 0)),
        "mlp_down_sampled_k_rows": int(
            mlp_down_sampled_k.get("executed_mlp_down_output_row_count", 0)
        ),
        "mlp_down_sampled_k_macs": int(
            mlp_down_sampled_k.get("executed_mlp_down_sampled_k_mac_count", 0)
        ),
        "mlp_down_sampled_k_represented_full_k_macs": int(
            mlp_down_sampled_k.get("represented_mlp_down_full_k_mac_count", 0)
        ),
        "mlp_down_sampled_k_row_fraction": float(
            mlp_down_sampled_k.get("row_coverage_fraction", 0.0)
        ),
        "mlp_down_sampled_k_checksum": int(
            mlp_down_sampled_k.get("mlp_down_sampled_k_real_weight_checksum", 0)
        ),
        "mlp_down_sampled_k_result_sha256": str(
            mlp_down_sampled_k.get("mlp_down_sampled_k_result_sha256", "")
        ),
        "mlp_down_sampled_k_residual_blocker": str(
            mlp_down_sampled_k.get("residual_blocker", "")
        ),
        "vector_kernel_template_instruction_words": int(
            vector_kernel.get("template_instruction_words", 0)
        ),
        "vector_kernel_template_instruction_estimate": int(
            vector_kernel.get("full_template_instruction_estimate", 0)
        ),
        "vector_kernel_template_sha256": str(vector_kernel.get("template_sha256", "")),
        "vector_kernel_template_residual_blocker": str(vector_kernel.get("residual_blocker", "")),
        "looped_vector_kernel_skeleton_instruction_words": int(
            loop_skeleton.get("skeleton_instruction_words", 0)
        ),
        "looped_vector_kernel_control_instruction_estimate": int(
            loop_skeleton.get("loop_control_instruction_estimate", 0)
        ),
        "looped_vector_kernel_combined_instruction_estimate": int(
            loop_skeleton.get("combined_template_plus_loop_instruction_estimate", 0)
        ),
        "looped_vector_kernel_skeleton_residual_blocker": str(
            loop_skeleton.get("residual_blocker", "")
        ),
        "per_layer_vector_codegen_layer_count": int(per_layer_codegen.get("codegen_layer_count", 0)),
        "per_layer_vector_codegen_total_instruction_estimate": int(
            per_layer_codegen.get("total_kernel_instruction_estimate", 0)
        ),
        "per_layer_vector_codegen_sha256": str(
            per_layer_codegen.get("per_layer_codegen_sha256", "")
        ),
        "per_layer_vector_codegen_residual_blocker": str(
            per_layer_codegen.get("residual_blocker", "")
        ),
        "sampled_vector_kernel_executor_row_count": int(sampled_vector.get("executed_row_count", 0)),
        "sampled_vector_kernel_executor_vector_word_ops": int(
            sampled_vector.get("executed_vector_word_op_count", 0)
        ),
        "sampled_vector_kernel_executor_lane_macs": int(
            sampled_vector.get("executed_lane_mac_count", 0)
        ),
        "sampled_vector_kernel_executor_trace_sha256": str(
            sampled_vector.get("sampled_vector_trace_sha256", "")
        ),
        "sampled_vector_kernel_executor_residual_blocker": str(
            sampled_vector.get("residual_blocker", "")
        ),
        "vector_kernel_window_executor_row_count": int(vector_window.get("executed_row_count", 0)),
        "vector_kernel_window_executor_vector_word_ops": int(
            vector_window.get("executed_vector_word_op_count", 0)
        ),
        "vector_kernel_window_executor_lane_macs": int(vector_window.get("executed_lane_mac_count", 0)),
        "vector_kernel_window_executor_row_coverage_fraction": float(
            vector_window.get("window_row_coverage_fraction", 0.0)
        ),
        "vector_kernel_window_executor_checksum": int(vector_window.get("window_output_checksum", 0)),
        "vector_kernel_window_executor_residual_blocker": str(
            vector_window.get("residual_blocker", "")
        ),
        "vector_window_fabric_checksum_row_count": int(
            vector_window_fabric.get("executed_row_count", 0)
        ),
        "vector_window_fabric_checksum_vector_word_ops": int(
            vector_window_fabric.get("executed_vector_word_op_count", 0)
        ),
        "vector_window_fabric_checksum_merge_cycles": int(
            vector_window_fabric.get("window_merge_cycle_count", 0)
        ),
        "vector_window_fabric_checksum_routing_colors": int(
            vector_window_fabric.get("routing_color_count", 0)
        ),
        "vector_window_fabric_checksum": int(vector_window_fabric.get("routed_window_checksum", 0)),
        "vector_window_fabric_checksum_residual_blocker": str(
            vector_window_fabric.get("residual_blocker", "")
        ),
        "window_shard_linkage_touched_shards": int(window_shard.get("window_touched_shard_records", 0)),
        "window_shard_linkage_touched_loader_words": int(
            window_shard.get("window_touched_loader_words", 0)
        ),
        "window_shard_linkage_touched_bytes": int(window_shard.get("window_touched_shard_bytes", 0)),
        "window_shard_linkage_record_sha256": str(window_shard.get("touched_shard_record_sha256", "")),
        "window_shard_linkage_residual_blocker": str(window_shard.get("residual_blocker", "")),
        "window_repair_linkage_touched_cores": int(window_repair.get("window_touched_core_count", 0)),
        "window_repair_linkage_normal_remapped": int(
            window_repair.get("normal_window_remapped_core_count", 0)
        ),
        "window_repair_linkage_high_failure_remapped": int(
            window_repair.get("high_failure_window_remapped_core_count", 0)
        ),
        "window_repair_linkage_high_vs_normal_ratio": float(
            window_repair.get("window_high_vs_normal_remap_ratio", 0.0)
        ),
        "window_repair_linkage_core_sha256": str(window_repair.get("window_touched_core_sha256", "")),
        "window_repair_linkage_residual_blocker": str(window_repair.get("residual_blocker", "")),
        "window_route_validation_neighbor_edges": int(window_route.get("window_neighbor_edge_count", 0)),
        "window_route_validation_normal_extra_hops": int(
            window_route.get("normal_window_extra_repair_hops", 0)
        ),
        "window_route_validation_high_failure_extra_hops": int(
            window_route.get("high_failure_window_extra_repair_hops", 0)
        ),
        "window_route_validation_high_failure_route_checksum": int(
            window_route.get("high_failure_window_route_checksum", 0)
        ),
        "window_route_validation_residual_blocker": str(window_route.get("residual_blocker", "")),
        "window_repair_rom_linkage_normal_remap_words": int(
            window_repair_rom.get("normal_window_remap_word_count", 0)
        ),
        "window_repair_rom_linkage_high_failure_remap_words": int(
            window_repair_rom.get("high_failure_window_remap_word_count", 0)
        ),
        "window_repair_rom_linkage_high_failure_remap_sha256": str(
            window_repair_rom.get("high_failure_window_remap_words_sha256", "")
        ),
        "window_repair_rom_linkage_high_failure_rom_words": int(
            window_repair_rom.get("high_failure_rom_total_word_count", 0)
        ),
        "window_repair_rom_linkage_residual_blocker": str(
            window_repair_rom.get("residual_blocker", "")
        ),
        "window_execution_trace_normal_cycles": int(window_trace.get("normal_total_cycles", 0)),
        "window_execution_trace_high_failure_cycles": int(
            window_trace.get("high_failure_total_cycles", 0)
        ),
        "window_execution_trace_cycle_ratio": float(
            window_trace.get("high_vs_normal_trace_cycle_ratio", 0.0)
        ),
        "window_execution_trace_high_failure_checksum": int(
            window_trace.get("high_failure_output_checksum", 0)
        ),
        "window_execution_trace_residual_blocker": str(window_trace.get("residual_blocker", "")),
        "fabric_reduction_total_reduction_wavelets": int(
            fabric_reduction.get("total_reduction_wavelets", 0)
        ),
        "fabric_reduction_total_fabric_wavelets": int(fabric_reduction.get("total_fabric_wavelets", 0)),
        "fabric_reduction_peak_color_fabric_cycles": int(
            fabric_reduction.get("peak_color_fabric_cycles", 0)
        ),
        "fabric_reduction_residual_blocker": str(fabric_reduction.get("residual_blocker", "")),
        "power_thermal_peak_package_power_w": float(power_thermal.get("peak_package_power_w", 0.0)),
        "power_thermal_peak_power_density_w_per_mm2": float(
            power_thermal.get("peak_power_density_w_per_mm2", 0.0)
        ),
        "power_thermal_schedule_energy_j": float(power_thermal.get("schedule_energy_j", 0.0)),
        "credit_router_cocotb_testcases": int(credit_router.get("testcases", 0)),
        "fabric_cocotb_testcases": int(fabric.get("testcases", 0)),
        "mesh_fabric_cocotb_testcases": int(mesh_fabric.get("testcases", 0)),
        "mesh_liveness_formal_check_count": int(mesh_liveness.get("formal_check_count", 0)),
        "mesh_liveness_residual_blocker": str(mesh_liveness.get("residual_blocker", "")),
        "graph_mapper_passing_check_count": int(graph_mapper.get("passing_check_count", 0)),
        **dependency_counts,
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-evidence-bundle",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Aggregate E1X evidence-bundle gate over existing architecture, benchmark, "
            "firmware, RTL/cocotb, and formal reports. It checks current report contents "
            "and artifact linkage; it is not silicon, package, PD, foundry DFT, or "
            "cycle-accurate full-wafer execution evidence."
        ),
        "evidence_paths": [str(path.relative_to(ROOT)) for path in REQUIRED_REPORTS.values()],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    if missing_evidence:
        report["blocked_reasons"] = [
            {
                "code": "missing_declared_evidence_path",
                "report": item["report"],
                "missing_count": item["missing_count"],
                "paths": item["paths"],
            }
            for item in missing_evidence
        ]
    if next_commands:
        report["next_commands"] = next_commands
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X evidence bundle failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X evidence bundle; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
