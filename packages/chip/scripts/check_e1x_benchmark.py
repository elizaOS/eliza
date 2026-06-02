#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_wafer_model import e1_baseline_summary  # noqa: E402

REPORT = ROOT / "build/reports/e1x_benchmark.json"
REPORT_ID = "e1x-scaled-repair-model-gate"
BENCH_REPORT = ROOT / f"benchmarks/results/{REPORT_ID}/report.json"
REAL_GRAPH_REPORT = ROOT / "benchmarks/results/e1x-real-graph-model-load.json"
KERNEL_PLAN = ROOT / "benchmarks/results/e1x-real-graph-kernel-dispatch-plan.json"
MICROKERNEL_PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
TENSOR_SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
COLOR_PRESSURE = ROOT / "benchmarks/results/e1x-real-graph-fabric-color-pressure.json"
COLOR_TIMING = ROOT / "benchmarks/results/e1x-real-graph-fabric-color-timing.json"
SCHEDULE_EXECUTION = ROOT / "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json"


def run_command(cmd: list[str]) -> tuple[bool, str]:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        return False, sanitize_text((proc.stderr.strip() or proc.stdout.strip())[-1600:])
    return True, sanitize_text((proc.stdout.strip() or "command completed")[-1600:])


def sanitize_text(text: str) -> str:
    return text.replace(str(ROOT), "packages/chip")


def inspect_benchmark_report() -> tuple[bool, str, dict[str, int | float | str]]:
    if not BENCH_REPORT.is_file():
        return False, f"missing benchmark report {BENCH_REPORT.relative_to(ROOT)}", {}
    report = json.loads(BENCH_REPORT.read_text(encoding="utf-8"))
    results = report.get("results")
    if not isinstance(results, list):
        return False, "benchmark report missing results list", {}
    by_name = {entry.get("name"): entry for entry in results if isinstance(entry, dict)}
    base = by_name.get("e1x_wafer_mesh_defect_sim")
    scaled = by_name.get("e1x_scaled_8gb_model_load_sim")
    if not isinstance(base, dict) or not isinstance(scaled, dict):
        return False, "missing base or scaled E1X benchmark result", {}
    base_metrics = base.get("metrics")
    scaled_metrics = scaled.get("metrics")
    if not isinstance(base_metrics, dict) or not isinstance(scaled_metrics, dict):
        return False, "E1X benchmark result missing metrics", {}
    scenarios = scaled_metrics.get("defect_testing", {}).get("scenarios", [])
    if not isinstance(scenarios, list) or len(scenarios) != 2:
        return False, "scaled E1X report missing normal/high defect scenarios", {}
    high = scenarios[1]
    if not isinstance(high, dict):
        return False, "scaled E1X high-failure scenario is malformed", {}
    if base_metrics.get("comparison", {}).get("e1", {}).get("basis") != "open_2028_sota_160tops":
        return False, "E1 comparison basis changed or is missing", {}
    e1_baseline = e1_baseline_summary()
    if base_metrics.get("comparison", {}).get("e1") != e1_baseline:
        return False, "E1 comparison baseline does not match canonical E1 summary", {}
    if scaled_metrics.get("model_loaded_under_high_failure") != 1:
        return False, "scaled E1X high-failure model load did not pass", {}
    if scaled_metrics.get("high_failure_repaired_logical_mesh") != 1:
        return False, "scaled E1X high-failure repair did not pass", {}
    if scaled_metrics.get("model_run_successful") != 1:
        return False, "scaled E1X high-failure model execution did not pass", {}
    execution = scaled_metrics.get("model_execution", {}).get("high_failure_rate_repair_stress")
    if not isinstance(execution, dict) or execution.get("golden_trace_match") is not True:
        return False, "scaled E1X high-failure execution trace is missing or mismatched", {}
    handoff = scaled_metrics.get("repair_handoff")
    if not isinstance(handoff, dict):
        return False, "scaled E1X report missing repair handoff metadata", {}
    defect_map = handoff.get("high_failure_defect_map")
    repair_manifest = handoff.get("high_failure_repair_manifest")
    repair_rom = handoff.get("high_failure_repair_rom")
    model_shard_sample = handoff.get("high_failure_model_shard_sample")
    model_execution_trace = handoff.get("high_failure_execution_trace")
    if (
        not isinstance(defect_map, dict)
        or not isinstance(repair_manifest, dict)
        or not isinstance(repair_rom, dict)
        or not isinstance(model_shard_sample, dict)
        or not isinstance(model_execution_trace, dict)
    ):
        return False, "scaled E1X handoff missing repair/model execution sidecars", {}
    defect_map_path = _required_repo_file(defect_map.get("path"))
    repair_manifest_path = _required_repo_file(repair_manifest.get("path"))
    repair_rom_path = _required_repo_file(repair_rom.get("path"))
    repair_rom_hex_path = _required_repo_file(repair_rom.get("hex_path"))
    model_shard_sample_path = _required_repo_file(model_shard_sample.get("path"))
    model_execution_trace_path = _required_repo_file(model_execution_trace.get("path"))
    if (
        defect_map_path is None
        or repair_manifest_path is None
        or repair_rom_path is None
        or repair_rom_hex_path is None
        or model_shard_sample_path is None
        or model_execution_trace_path is None
    ):
        return False, "scaled E1X handoff sidecar path is missing or invalid", {}
    defect_map_data = json.loads(defect_map_path.read_text(encoding="utf-8"))
    repair_manifest_data = json.loads(repair_manifest_path.read_text(encoding="utf-8"))
    repair_rom_data = json.loads(repair_rom_path.read_text(encoding="utf-8"))
    model_shard_sample_data = json.loads(model_shard_sample_path.read_text(encoding="utf-8"))
    model_execution_trace_data = json.loads(model_execution_trace_path.read_text(encoding="utf-8"))
    if defect_map_data.get("artifact_sha256") != defect_map.get("artifact_sha256"):
        return False, "defect-map sidecar sha does not match scaled report", {}
    if repair_manifest_data.get("artifact_sha256") != repair_manifest.get("artifact_sha256"):
        return False, "repair-manifest sidecar sha does not match scaled report", {}
    if repair_rom_data.get("artifact_sha256") != repair_rom.get("artifact_sha256"):
        return False, "repair-ROM sidecar sha does not match scaled report", {}
    if model_shard_sample_data.get("artifact_sha256") != model_shard_sample.get("artifact_sha256"):
        return False, "model-shard sidecar sha does not match scaled report", {}
    if model_execution_trace_data.get("artifact_sha256") != model_execution_trace.get(
        "artifact_sha256"
    ):
        return False, "execution-trace sidecar sha does not match scaled report", {}
    if repair_manifest_data.get("source_defect_map_sha256") != defect_map_data.get(
        "artifact_sha256"
    ):
        return False, "repair manifest does not reference the defect-map artifact", {}
    if repair_rom_data.get("source_repair_manifest_sha256") != repair_manifest_data.get(
        "artifact_sha256"
    ):
        return False, "repair ROM does not reference the repair-manifest artifact", {}
    if model_execution_trace_data.get("source_repair_manifest_sha256") != repair_manifest_data.get(
        "artifact_sha256"
    ):
        return False, "execution trace does not reference the repair-manifest artifact", {}
    if model_execution_trace_data.get(
        "source_model_shard_sample_sha256"
    ) != model_shard_sample_data.get("artifact_sha256"):
        return False, "execution trace does not reference the model-shard artifact", {}
    if model_execution_trace_data.get("output_checksum") != scaled_metrics.get(
        "high_failure_output_checksum"
    ):
        return False, "execution trace output checksum does not match scaled report", {}
    if model_execution_trace_data.get("golden_trace_match") is not True:
        return False, "execution trace did not match golden trace", {}
    rom_hex_words = repair_rom_hex_path.read_text(encoding="utf-8").strip().splitlines()
    if rom_hex_words != repair_rom_data.get("words"):
        return False, "repair-ROM hex image does not match JSON ROM words", {}
    if (
        not _file_sha256_is_stable(defect_map_path)
        or not _file_sha256_is_stable(repair_manifest_path)
        or not _file_sha256_is_stable(repair_rom_path)
    ):
        return False, "repair handoff sidecars are empty or unreadable", {}
    if not _file_sha256_is_stable(model_shard_sample_path):
        return False, "model-shard sidecar is empty or unreadable", {}
    if not _file_sha256_is_stable(model_execution_trace_path):
        return False, "execution-trace sidecar is empty or unreadable", {}
    real_graph_data = _load_real_graph_report()
    if real_graph_data is None:
        return False, "real-graph model-load report is missing or malformed", {}
    if real_graph_data.get("mapper_sram_fit") is not True:
        return False, "real-graph mapper SRAM fit did not pass", {}
    if real_graph_data.get("model_loaded_under_high_failure") != 1:
        return False, "real-graph high-failure model load did not pass", {}
    if real_graph_data.get("high_failure_repaired_logical_mesh") != 1:
        return False, "real-graph high-failure repair did not pass", {}
    if real_graph_data.get("high_failure_model_run_successful") != 1:
        return False, "real-graph high-failure execution did not pass", {}
    executions_by_scenario = real_graph_data.get("model_execution_by_scenario", {})
    normal_graph_execution = executions_by_scenario.get("normal_wafer_sort")
    high_graph_execution = executions_by_scenario.get("high_failure_rate_repair_stress")
    if (
        not isinstance(normal_graph_execution, dict)
        or normal_graph_execution.get("golden_trace_match") is not True
    ):
        return False, "real-graph normal execution trace is missing or mismatched", {}
    if (
        not isinstance(high_graph_execution, dict)
        or high_graph_execution.get("golden_trace_match") is not True
    ):
        return False, "real-graph high-failure execution trace is missing or mismatched", {}
    normal_graph_trace = real_graph_data.get("normal_execution_trace_artifact")
    if not isinstance(normal_graph_trace, dict):
        return False, "real-graph normal execution trace sidecar is missing", {}
    real_graph_trace = real_graph_data.get("high_failure_execution_trace_artifact")
    if not isinstance(real_graph_trace, dict):
        return False, "real-graph high-failure execution trace sidecar is missing", {}
    kernel_plan_data = _load_kernel_plan()
    if kernel_plan_data is None:
        return False, "real-graph kernel-dispatch plan is missing or malformed", {}
    placement_path = _required_repo_file(real_graph_data.get("placement_artifact"))
    if placement_path is None:
        return False, "real-graph placement artifact path is missing or invalid", {}
    placement_data = json.loads(placement_path.read_text(encoding="utf-8"))
    repair_audits = real_graph_data.get("repair_audit_artifacts")
    if not isinstance(repair_audits, dict):
        return False, "real-graph repair audit sidecars are missing", {}
    repair_audit_summary: dict[str, int | str] = {}
    for scenario_name, summary_prefix in (
        ("normal_wafer_sort", "real_graph_normal"),
        ("high_failure_rate_repair_stress", "real_graph_high_failure"),
    ):
        audit = repair_audits.get(scenario_name)
        scenario_report = real_graph_data.get("defect_testing", {}).get(scenario_name)
        if not isinstance(audit, dict) or not isinstance(scenario_report, dict):
            return False, f"real-graph repair audit missing {scenario_name}", {}
        defect_map_meta = audit.get("defect_map")
        repair_manifest_meta = audit.get("repair_manifest")
        repair_rom_meta = audit.get("repair_rom")
        if (
            not isinstance(defect_map_meta, dict)
            or not isinstance(
                repair_manifest_meta,
                dict,
            )
            or not isinstance(
                repair_rom_meta,
                dict,
            )
        ):
            return False, f"real-graph repair audit sidecars malformed for {scenario_name}", {}
        defect_map_path = _required_repo_file(defect_map_meta.get("path"))
        repair_manifest_path = _required_repo_file(repair_manifest_meta.get("path"))
        repair_rom_path = _required_repo_file(repair_rom_meta.get("path"))
        repair_rom_hex_path = _required_repo_file(repair_rom_meta.get("hex_path"))
        if (
            defect_map_path is None
            or repair_manifest_path is None
            or repair_rom_path is None
            or repair_rom_hex_path is None
        ):
            return False, f"real-graph repair audit path invalid for {scenario_name}", {}
        defect_map_data = json.loads(defect_map_path.read_text(encoding="utf-8"))
        repair_manifest_data = json.loads(repair_manifest_path.read_text(encoding="utf-8"))
        repair_rom_data = json.loads(repair_rom_path.read_text(encoding="utf-8"))
        if defect_map_data.get("schema") != "eliza.e1x.wafer_sort_defect_map.v1":
            return False, f"real-graph defect-map schema invalid for {scenario_name}", {}
        if repair_manifest_data.get("schema") != "eliza.e1x.repair_manifest.v1":
            return False, f"real-graph repair-manifest schema invalid for {scenario_name}", {}
        if repair_rom_data.get("schema") != "eliza.e1x.repair_rom.v1":
            return False, f"real-graph repair-ROM schema invalid for {scenario_name}", {}
        if defect_map_data.get("artifact_sha256") != defect_map_meta.get("artifact_sha256"):
            return False, f"real-graph defect-map sha mismatch for {scenario_name}", {}
        if repair_manifest_data.get("artifact_sha256") != repair_manifest_meta.get(
            "artifact_sha256"
        ):
            return False, f"real-graph repair-manifest sha mismatch for {scenario_name}", {}
        if repair_rom_data.get("artifact_sha256") != repair_rom_meta.get("artifact_sha256"):
            return False, f"real-graph repair-ROM sha mismatch for {scenario_name}", {}
        if repair_manifest_data.get("source_defect_map_sha256") != defect_map_data.get(
            "artifact_sha256"
        ):
            return (
                False,
                f"real-graph repair manifest does not link defect map for {scenario_name}",
                {},
            )
        if repair_rom_data.get("source_repair_manifest_sha256") != repair_manifest_data.get(
            "artifact_sha256"
        ):
            return (
                False,
                f"real-graph repair ROM does not link repair manifest for {scenario_name}",
                {},
            )
        if int(defect_map_data.get("blocked_core_count", -1)) != int(
            scenario_report.get("blocked_core_count", -2)
        ):
            return False, f"real-graph defect core count mismatch for {scenario_name}", {}
        if int(defect_map_data.get("blocked_link_count", -1)) != int(
            scenario_report.get("blocked_link_count", -2)
        ):
            return False, f"real-graph defect link count mismatch for {scenario_name}", {}
        validation = repair_manifest_data.get("validation")
        if not isinstance(validation, dict) or validation.get("repaired_logical_mesh") is not True:
            return False, f"real-graph repair validation failed for {scenario_name}", {}
        if int(validation.get("logical_neighbor_paths_checked", -1)) != int(
            scenario_report.get("logical_neighbor_paths_checked", -2)
        ):
            return False, f"real-graph route-check count mismatch for {scenario_name}", {}
        if float(validation.get("average_extra_hops_per_neighbor", -1.0)) != float(
            scenario_report.get("average_extra_hops_per_neighbor", -2.0)
        ):
            return False, f"real-graph repair hop penalty mismatch for {scenario_name}", {}
        sampled_routes = repair_manifest_data.get("sampled_routes")
        if not isinstance(sampled_routes, list) or not sampled_routes:
            return (
                False,
                f"real-graph repair manifest has no sampled routes for {scenario_name}",
                {},
            )
        if int(repair_rom_data.get("word_bits", 0)) != 64:
            return False, f"real-graph repair ROM word width invalid for {scenario_name}", {}
        if int(repair_rom_data.get("total_word_count", 0)) <= int(
            repair_rom_data.get("header_word_count", 0)
        ):
            return False, f"real-graph repair ROM has no programmed entries for {scenario_name}", {}
        if int(repair_rom_data.get("remap_word_count", -1)) != int(
            repair_manifest_data["remapped_core_count"]
        ):
            return False, f"real-graph repair ROM remap count mismatch for {scenario_name}", {}
        if int(repair_rom_data.get("route_sample_word_count", -1)) != len(sampled_routes):
            return False, f"real-graph repair ROM route count mismatch for {scenario_name}", {}
        rom_hex_words = repair_rom_hex_path.read_text(encoding="utf-8").strip().splitlines()
        if rom_hex_words != repair_rom_data.get("words"):
            return False, f"real-graph repair-ROM hex mismatch for {scenario_name}", {}
        if (
            not _file_sha256_is_stable(defect_map_path)
            or not _file_sha256_is_stable(repair_manifest_path)
            or not _file_sha256_is_stable(repair_rom_path)
        ):
            return False, f"real-graph repair audit sidecar unreadable for {scenario_name}", {}
        repair_audit_summary[f"{summary_prefix}_defect_map_sha256"] = str(
            defect_map_data["artifact_sha256"]
        )
        repair_audit_summary[f"{summary_prefix}_repair_manifest_sha256"] = str(
            repair_manifest_data["artifact_sha256"]
        )
        repair_audit_summary[f"{summary_prefix}_repair_rom_sha256"] = str(
            repair_rom_data["artifact_sha256"]
        )
        repair_audit_summary[f"{summary_prefix}_remapped_cores"] = int(
            repair_manifest_data["remapped_core_count"]
        )
        repair_audit_summary[f"{summary_prefix}_sampled_repair_routes"] = len(sampled_routes)
        repair_audit_summary[f"{summary_prefix}_repair_rom_words"] = int(
            repair_rom_data["total_word_count"]
        )
    if int(repair_audit_summary["real_graph_high_failure_remapped_cores"]) <= int(
        repair_audit_summary["real_graph_normal_remapped_cores"]
    ):
        return False, "real-graph high-failure repair did not stress more remaps than normal", {}
    normal_graph_trace_path = _required_repo_file(normal_graph_trace.get("path"))
    if normal_graph_trace_path is None:
        return False, "real-graph normal execution trace sidecar path is missing or invalid", {}
    normal_graph_trace_data = json.loads(normal_graph_trace_path.read_text(encoding="utf-8"))
    if normal_graph_trace_data.get("schema") != "eliza.e1x.real_graph_execution_trace.v1":
        return False, "real-graph normal execution trace sidecar schema is invalid", {}
    if normal_graph_trace_data.get("artifact_sha256") != normal_graph_trace.get("artifact_sha256"):
        return False, "real-graph normal execution trace sidecar sha does not match report", {}
    if normal_graph_trace_data.get("source_placement_sha256") != placement_data.get(
        "artifact_sha256"
    ):
        return False, "real-graph normal execution trace does not reference placement", {}
    if normal_graph_trace_data.get("output_checksum") != normal_graph_execution.get(
        "output_checksum"
    ):
        return False, "real-graph normal execution trace checksum does not match report", {}
    if normal_graph_trace_data.get("total_cycles") != normal_graph_execution.get("total_cycles"):
        return False, "real-graph normal execution trace cycles do not match report", {}
    if normal_graph_trace_data.get("golden_trace_match") is not True:
        return False, "real-graph normal execution trace did not match golden trace", {}
    real_graph_trace_path = _required_repo_file(real_graph_trace.get("path"))
    if real_graph_trace_path is None:
        return False, "real-graph execution trace sidecar path is missing or invalid", {}
    real_graph_trace_data = json.loads(real_graph_trace_path.read_text(encoding="utf-8"))
    if real_graph_trace_data.get("schema") != "eliza.e1x.real_graph_execution_trace.v1":
        return False, "real-graph execution trace sidecar schema is invalid", {}
    if real_graph_trace_data.get("artifact_sha256") != real_graph_trace.get("artifact_sha256"):
        return False, "real-graph execution trace sidecar sha does not match report", {}
    if real_graph_trace_data.get("source_placement_sha256") != placement_data.get(
        "artifact_sha256"
    ):
        return False, "real-graph execution trace does not reference placement", {}
    if real_graph_trace_data.get("output_checksum") != real_graph_data.get(
        "high_failure_output_checksum"
    ):
        return False, "real-graph execution trace checksum does not match report", {}
    if real_graph_trace_data.get("total_cycles") != high_graph_execution.get("total_cycles"):
        return False, "real-graph execution trace cycles do not match report", {}
    if real_graph_trace_data.get("golden_trace_match") is not True:
        return False, "real-graph execution trace did not match golden trace", {}
    layer_sample = real_graph_trace_data.get("layer_trace_sample")
    if not isinstance(layer_sample, list) or not layer_sample:
        return False, "real-graph execution trace missing sampled layers", {}
    normal_layer_sample = normal_graph_trace_data.get("layer_trace_sample")
    if not isinstance(normal_layer_sample, list) or not normal_layer_sample:
        return False, "real-graph normal execution trace missing sampled layers", {}
    placement_by_index = {int(layer["index"]): layer for layer in placement_data["layers"]}
    for sample in normal_layer_sample + layer_sample:
        if not isinstance(sample, dict):
            return False, "real-graph execution trace sampled layer is malformed", {}
        layer = placement_by_index.get(int(sample.get("layer", -1)))
        if layer is None:
            return False, "real-graph execution trace references an unknown layer", {}
        if int(sample.get("route_color", -1)) != int(layer["routing_color"]):
            return False, "real-graph execution trace route color does not match placement", {}
    if not _file_sha256_is_stable(normal_graph_trace_path):
        return False, "real-graph normal execution trace sidecar is empty or unreadable", {}
    if not _file_sha256_is_stable(real_graph_trace_path):
        return False, "real-graph execution trace sidecar is empty or unreadable", {}
    if kernel_plan_data.get("source_placement_sha256") != placement_data.get("artifact_sha256"):
        return False, "kernel-dispatch plan does not reference the real-graph placement", {}
    if kernel_plan_data.get("programmed_layer_count") != real_graph_data.get("graph_layers"):
        return False, "kernel-dispatch plan does not cover every real-graph layer", {}
    microkernel_proof_data = _load_microkernel_proof()
    if microkernel_proof_data is None:
        return False, "W4A8 microkernel proof is missing or malformed", {}
    if microkernel_proof_data.get("source_kernel_plan_sha256") != kernel_plan_data.get(
        "artifact_sha256"
    ):
        return False, "W4A8 microkernel proof does not reference the kernel-dispatch plan", {}
    if microkernel_proof_data.get("proved_layer_record_count") != real_graph_data.get(
        "graph_layers"
    ):
        return False, "W4A8 microkernel proof does not cover every real-graph layer", {}
    tensor_schedule_data = _load_tensor_schedule()
    if tensor_schedule_data is None:
        return False, "tensor tile schedule is missing or malformed", {}
    if tensor_schedule_data.get("source_kernel_plan_sha256") != kernel_plan_data.get(
        "artifact_sha256"
    ):
        return False, "tensor tile schedule does not reference the kernel-dispatch plan", {}
    if tensor_schedule_data.get("scheduled_layer_count") != real_graph_data.get("graph_layers"):
        return False, "tensor tile schedule does not cover every real-graph layer", {}
    if tensor_schedule_data.get("all_rows_covered") is not True:
        return False, "tensor tile schedule does not cover all output rows", {}
    if tensor_schedule_data.get("all_shards_fit_sram") is not True:
        return False, "tensor tile schedule has an SRAM-overflowing shard", {}
    color_pressure_data = _load_color_pressure()
    if color_pressure_data is None:
        return False, "fabric color pressure report is missing or malformed", {}
    if color_pressure_data.get("source_tensor_schedule_sha256") != tensor_schedule_data.get(
        "artifact_sha256"
    ):
        return False, "fabric color pressure does not reference the tensor schedule", {}
    if color_pressure_data.get("scheduled_layer_count") != tensor_schedule_data.get(
        "scheduled_layer_count"
    ):
        return False, "fabric color pressure does not cover every scheduled layer", {}
    if int(color_pressure_data.get("used_routing_color_count", 0)) != 24:
        return False, "fabric color pressure does not exercise all 24 routing colors", {}
    if int(color_pressure_data.get("total_fabric_wavelets", 0)) <= 0:
        return False, "fabric color pressure has no wavelets", {}
    if not 0.0 < float(color_pressure_data.get("peak_color_fraction", 0.0)) <= 1.0:
        return False, "fabric color pressure peak fraction is out of range", {}
    color_timing_data = _load_color_timing()
    if color_timing_data is None:
        return False, "fabric color timing report is missing or malformed", {}
    if color_timing_data.get("source_color_pressure_sha256") != color_pressure_data.get(
        "artifact_sha256"
    ):
        return False, "fabric color timing does not reference color pressure", {}
    if color_timing_data.get("used_routing_color_count") != color_pressure_data.get(
        "used_routing_color_count"
    ):
        return False, "fabric color timing used-color count changed", {}
    if color_timing_data.get("total_fabric_wavelets") != color_pressure_data.get(
        "total_fabric_wavelets"
    ):
        return False, "fabric color timing wavelet count changed", {}
    schedule_execution_data = _load_schedule_execution_estimate()
    if schedule_execution_data is None:
        return False, "schedule execution estimate is missing or malformed", {}
    if schedule_execution_data.get("source_tensor_schedule_sha256") != tensor_schedule_data.get(
        "artifact_sha256"
    ):
        return False, "schedule execution estimate does not reference the tensor schedule", {}
    if schedule_execution_data.get("estimated_layer_count") != tensor_schedule_data.get(
        "scheduled_layer_count"
    ):
        return False, "schedule execution estimate does not cover every scheduled layer", {}
    if int(schedule_execution_data.get("total_schedule_cycles", 0)) <= 0:
        return False, "schedule execution estimate has no cycles", {}
    if float(schedule_execution_data.get("repair_hop_penalty", -1.0)) != float(
        real_graph_data.get("high_failure_repair_hop_penalty", -2.0)
    ):
        return False, "schedule execution estimate does not use high-failure repair penalty", {}
    if float(real_graph_trace_data.get("repair_hop_penalty", -1.0)) != float(
        schedule_execution_data["repair_hop_penalty"]
    ):
        return False, "real-graph execution trace repair penalty does not match schedule", {}
    if int(schedule_execution_data["total_schedule_cycles"]) > int(
        real_graph_trace_data["total_cycles"]
    ):
        return False, "schedule execution cycles exceed real-graph trace cycles", {}
    if float(normal_graph_trace_data.get("repair_hop_penalty", -1.0)) != float(
        real_graph_data.get("normal_repair_hop_penalty", -2.0)
    ):
        return False, "real-graph normal execution trace repair penalty does not match report", {}
    high_vs_normal_trace_cycles = int(real_graph_trace_data["total_cycles"]) / max(
        1,
        int(normal_graph_trace_data["total_cycles"]),
    )
    if high_vs_normal_trace_cycles < 1.0:
        return False, "high-failure real-graph trace is unexpectedly faster than normal", {}
    if float(color_timing_data.get("repair_hop_penalty", -1.0)) != float(
        schedule_execution_data.get("repair_hop_penalty", -2.0)
    ):
        return False, "fabric color timing does not use schedule repair penalty", {}
    if int(color_timing_data.get("peak_color_fabric_cycles", 0)) > int(
        schedule_execution_data["total_schedule_cycles"]
    ):
        return False, "fabric color timing exceeds schedule execution estimate", {}
    if float(schedule_execution_data.get("estimated_elapsed_ms", 0.0)) <= 0.0:
        return False, "schedule execution estimate has no elapsed time", {}
    if float(schedule_execution_data.get("effective_tops", 0.0)) <= 0.0:
        return False, "schedule execution estimate has no effective throughput", {}
    real_graph_load = real_graph_data.get("model_load")
    if not isinstance(real_graph_load, dict):
        return False, "real-graph report is missing model-load details", {}
    if float(real_graph_load.get("total_required_mib", 0.0)) <= float(
        e1_baseline["local_sram_mib"]
    ):
        return False, "real-graph resident model unexpectedly fits in E1 local SRAM", {}
    schedule_vs_e1_peak = float(schedule_execution_data["effective_tops"]) / float(
        e1_baseline["dense_int8_peak_tops"]
    )
    required_vs_e1_sram = float(real_graph_load["total_required_mib"]) / float(
        e1_baseline["local_sram_mib"]
    )
    required_vs_e1x_sram = float(real_graph_load["total_required_mib"]) / float(
        scaled_metrics["local_sram_mib"]
    )
    if schedule_vs_e1_peak <= 0.0:
        return False, "real-graph schedule comparison against E1 is non-positive", {}
    if not 0.0 < required_vs_e1x_sram < 1.0:
        return False, "real-graph resident model does not fit within E1X SRAM ratio", {}
    summary = {
        "claim_level": str(report.get("claim_level")),
        "base_logical_cores": int(base_metrics["architecture"]["logical_cores"]),
        "scaled_logical_cores": int(scaled_metrics["architecture"]["logical_cores"]),
        "scaled_local_sram_mib": float(scaled_metrics["local_sram_mib"]),
        "scaled_model_required_mib": float(scaled_metrics["model_total_required_mib"]),
        "high_failure_blocked_cores": int(high["blocked_core_count"]),
        "high_failure_blocked_links": int(high["blocked_link_count"]),
        "high_failure_route_checks": int(high["logical_neighbor_paths_checked"]),
        "scaled_dense_int8_peak_tops": float(
            scaled_metrics["architecture"]["dense_int8_peak_tops"]
        ),
        "high_failure_prefill_ms": float(scaled_metrics["high_failure_prefill_ms"]),
        "high_failure_decode_tokens_per_second": float(
            scaled_metrics["high_failure_decode_tokens_per_second"]
        ),
        "high_failure_output_checksum": int(scaled_metrics["high_failure_output_checksum"]),
        "high_failure_defect_map_blocked_cores": int(defect_map_data["blocked_core_count"]),
        "high_failure_repair_manifest_remaps": int(repair_manifest_data["remapped_core_count"]),
        "high_failure_repair_manifest_sampled_routes": int(
            len(repair_manifest_data["sampled_routes"])
        ),
        "high_failure_repair_rom_words": int(repair_rom_data["total_word_count"]),
        "high_failure_model_shard_sample_words": int(model_shard_sample_data["sampled_word_count"]),
        "high_failure_model_shard_sample_checksum": int(
            model_shard_sample_data["expected_checksum"]
        ),
        "high_failure_execution_trace_output_checksum": int(
            model_execution_trace_data["output_checksum"]
        ),
        "high_failure_execution_trace_total_cycles": int(
            model_execution_trace_data["total_cycles"]
        ),
        "real_graph_layers": int(real_graph_data["graph_layers"]),
        "real_graph_total_parameters": int(real_graph_data["graph_total_parameters"]),
        "real_graph_cores_used": int(real_graph_data["graph_cores_used"]),
        "real_graph_model_required_mib": float(real_graph_load["total_required_mib"]),
        "real_graph_model_required_vs_e1_sram": required_vs_e1_sram,
        "real_graph_model_required_vs_e1x_sram": required_vs_e1x_sram,
        "real_graph_high_failure_route_checks": int(real_graph_data["high_failure_route_checks"]),
        "real_graph_high_failure_repair_hop_penalty": float(
            real_graph_data["high_failure_repair_hop_penalty"]
        ),
        "real_graph_high_failure_output_checksum": int(
            real_graph_data["high_failure_output_checksum"]
        ),
        **repair_audit_summary,
        "real_graph_normal_execution_trace_cycles": int(normal_graph_trace_data["total_cycles"]),
        "real_graph_normal_execution_trace_sha256": str(normal_graph_trace_data["artifact_sha256"]),
        "real_graph_high_failure_execution_trace_cycles": int(
            real_graph_trace_data["total_cycles"]
        ),
        "real_graph_high_failure_execution_trace_sha256": str(
            real_graph_trace_data["artifact_sha256"]
        ),
        "real_graph_high_failure_trace_sampled_layers": len(layer_sample),
        "real_graph_normal_trace_sampled_layers": len(normal_layer_sample),
        "real_graph_high_vs_normal_trace_cycle_ratio": high_vs_normal_trace_cycles,
        "real_graph_kernel_dispatch_layers": int(kernel_plan_data["programmed_layer_count"]),
        "real_graph_kernel_dispatch_words": int(kernel_plan_data["total_instruction_words"]),
        "real_graph_microkernel_sample_macs": int(microkernel_proof_data["sample_mac_count"]),
        "real_graph_microkernel_checksum": int(microkernel_proof_data["aggregate_checksum"]),
        "real_graph_tensor_schedule_core_waves": int(tensor_schedule_data["total_core_wave_count"]),
        "real_graph_tensor_schedule_k_waves": int(tensor_schedule_data["total_k_wave_count"]),
        "real_graph_fabric_color_used_colors": int(color_pressure_data["used_routing_color_count"]),
        "real_graph_fabric_color_total_wavelets": int(color_pressure_data["total_fabric_wavelets"]),
        "real_graph_fabric_color_peak_fraction": float(color_pressure_data["peak_color_fraction"]),
        "real_graph_fabric_color_timing_peak_color": int(color_timing_data["peak_routing_color"]),
        "real_graph_fabric_color_timing_peak_cycles": int(
            color_timing_data["peak_color_fabric_cycles"]
        ),
        "real_graph_fabric_color_timing_total_cycles": int(
            color_timing_data["total_color_fabric_cycles"]
        ),
        "real_graph_schedule_execution_total_cycles": int(
            schedule_execution_data["total_schedule_cycles"]
        ),
        "real_graph_schedule_execution_repair_hop_penalty": float(
            schedule_execution_data["repair_hop_penalty"]
        ),
        "real_graph_schedule_execution_elapsed_ms": float(
            schedule_execution_data["estimated_elapsed_ms"]
        ),
        "real_graph_schedule_execution_effective_tops": float(
            schedule_execution_data["effective_tops"]
        ),
        "real_graph_schedule_effective_tops_vs_e1_peak": schedule_vs_e1_peak,
        "real_graph_schedule_cycles_vs_trace_cycles": int(
            schedule_execution_data["total_schedule_cycles"]
        )
        / int(real_graph_trace_data["total_cycles"]),
        "real_graph_e1_comparison_basis": str(e1_baseline["basis"]),
    }
    return True, "E1X base and scaled model-load benchmarks passed", summary


def _required_repo_file(value: object) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if path.is_absolute():
        return None
    resolved = ROOT / path
    return resolved if resolved.is_file() else None


def _file_sha256_is_stable(path: Path) -> bool:
    return bool(sha256(path.read_bytes()).hexdigest())


def _load_real_graph_report() -> dict | None:
    if not REAL_GRAPH_REPORT.is_file():
        return None
    data = json.loads(REAL_GRAPH_REPORT.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1x.real_graph_model_load.v1":
        return None
    if not _file_sha256_is_stable(REAL_GRAPH_REPORT):
        return None
    return data


def _load_kernel_plan() -> dict | None:
    if not KERNEL_PLAN.is_file():
        return None
    data = json.loads(KERNEL_PLAN.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1x.kernel_dispatch_plan.v1":
        return None
    if not _file_sha256_is_stable(KERNEL_PLAN):
        return None
    return data


def _load_microkernel_proof() -> dict | None:
    if not MICROKERNEL_PROOF.is_file():
        return None
    data = json.loads(MICROKERNEL_PROOF.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1x.w4a8_microkernel_proof.v1":
        return None
    if not _file_sha256_is_stable(MICROKERNEL_PROOF):
        return None
    return data


def _load_tensor_schedule() -> dict | None:
    if not TENSOR_SCHEDULE.is_file():
        return None
    data = json.loads(TENSOR_SCHEDULE.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1x.tensor_tile_schedule.v1":
        return None
    if not _file_sha256_is_stable(TENSOR_SCHEDULE):
        return None
    return data


def _load_color_pressure() -> dict | None:
    if not COLOR_PRESSURE.is_file():
        return None
    data = json.loads(COLOR_PRESSURE.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1x.fabric_color_pressure.v1":
        return None
    if not _file_sha256_is_stable(COLOR_PRESSURE):
        return None
    return data


def _load_color_timing() -> dict | None:
    if not COLOR_TIMING.is_file():
        return None
    data = json.loads(COLOR_TIMING.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1x.fabric_color_timing.v1":
        return None
    if not _file_sha256_is_stable(COLOR_TIMING):
        return None
    return data


def _load_schedule_execution_estimate() -> dict | None:
    if not SCHEDULE_EXECUTION.is_file():
        return None
    data = json.loads(SCHEDULE_EXECUTION.read_text(encoding="utf-8"))
    if data.get("schema") != "eliza.e1x.schedule_execution_estimate.v1":
        return None
    if not _file_sha256_is_stable(SCHEDULE_EXECUTION):
        return None
    return data


def main() -> int:
    run_ok, run_detail = run_command(
        [
            sys.executable,
            "benchmarks/run_benchmarks.py",
            "run",
            "--bench",
            "e1x_wafer_mesh_defect_sim",
            "--bench",
            "e1x_scaled_8gb_model_load_sim",
            "--report-id",
            REPORT_ID,
        ]
    )
    validate_ok, validate_detail = (
        run_command(
            [
                sys.executable,
                "benchmarks/run_benchmarks.py",
                "validate-report",
                str(BENCH_REPORT.relative_to(ROOT)),
            ]
        )
        if run_ok
        else (False, "not run")
    )
    kernel_ok, kernel_detail = (
        run_command([sys.executable, "scripts/check_e1x_kernel_codegen.py"])
        if validate_ok
        else (False, "not run")
    )
    inspect_ok, inspect_detail, metrics = (
        inspect_benchmark_report() if validate_ok and kernel_ok else (False, "not run", {})
    )
    checks = [
        {"id": "e1x_benchmark_run", "status": "pass" if run_ok else "fail", "detail": run_detail},
        {
            "id": "e1x_benchmark_report_schema",
            "status": "pass" if validate_ok else "fail",
            "detail": validate_detail,
        },
        {
            "id": "e1x_scaled_repair_model_load_and_run_metrics",
            "status": "pass" if inspect_ok else "fail",
            "detail": inspect_detail,
        },
        {
            "id": "e1x_real_graph_kernel_dispatch_codegen",
            "status": "pass" if kernel_ok else "fail",
            "detail": kernel_detail,
        },
    ]
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-benchmark",
        "status": "PASS" if not failures else "BLOCKED",
        "generated_utc": datetime.now(UTC).isoformat(),
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": "E1X L2 architecture-simulator benchmark only; not silicon, FPGA, board, PD, DFT, package, or full-wafer RTL benchmark evidence.",
        "evidence_paths": [
            "benchmarks/configs/benchmark_plan.json",
            f"benchmarks/results/{REPORT_ID}/report.json",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_model_execution_trace.json",
            "benchmarks/results/e1x-real-graph-model-load.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
            "benchmarks/results/e1x-real-graph-model-load.normal_execution_trace.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_execution_trace.json",
            "benchmarks/results/e1x-real-graph-kernel-dispatch-plan.json",
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "benchmarks/results/e1x-real-graph-fabric-color-pressure.json",
            "benchmarks/results/e1x-real-graph-fabric-color-timing.json",
            "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json",
        ],
        "checks": checks,
        "summary": {**metrics, "check_count": len(checks), "failing_check_count": len(failures)},
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X benchmark failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X benchmark; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
