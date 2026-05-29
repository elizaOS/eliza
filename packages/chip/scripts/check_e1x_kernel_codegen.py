#!/usr/bin/env python3
"""Gate for E1X real-graph kernel-dispatch code generation."""

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_graph_mapper import map_graph, parse_manifest  # noqa: E402
from compiler.runtime.e1x_kernel_codegen import (  # noqa: E402
    COLOR_PRESSURE_SCHEMA,
    COLOR_TIMING_SCHEMA,
    KERNEL_PLAN_SCHEMA,
    MICROKERNEL_PROOF_SCHEMA,
    SCHEDULE_EXECUTION_SCHEMA,
    TENSOR_SCHEDULE_SCHEMA,
    build_fabric_color_pressure,
    build_fabric_color_timing,
    build_kernel_dispatch_plan,
    build_schedule_execution_estimate,
    build_tensor_tile_schedule,
    build_w4a8_microkernel_proof,
    layer_dispatch_payload,
    unpack_signed_w4_word,
)
from compiler.runtime.e1x_wafer_model import (  # noqa: E402
    HIGH_DEFECT_SCENARIO,
    repair_hop_penalty_for_scenario,
    scaled_8gb_config,
)
from scripts.chip_utils import load_json_object  # noqa: E402

REPORT = ROOT / "build/reports/e1x_kernel_codegen.json"
MANIFEST = ROOT / "benchmarks/models/llama13b-w4a8-manifest.json"
PLACEMENT_OUT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
KERNEL_PLAN_OUT = ROOT / "benchmarks/results/e1x-real-graph-kernel-dispatch-plan.json"
MICROKERNEL_PROOF_OUT = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
TENSOR_SCHEDULE_OUT = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
COLOR_PRESSURE_OUT = ROOT / "benchmarks/results/e1x-real-graph-fabric-color-pressure.json"
COLOR_TIMING_OUT = ROOT / "benchmarks/results/e1x-real-graph-fabric-color-timing.json"
SCHEDULE_EXECUTION_OUT = (
    ROOT / "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json"
)


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def _decode_opcode(word_hex: str) -> int:
    return int(word_hex, 16) & 0x7F


def _saturating_shift7(value: int) -> int:
    return max(-128, min(127, value >> 7))


def _validate_microkernel_proof(proof: dict) -> tuple[bool, str]:
    if proof.get("schema") != MICROKERNEL_PROOF_SCHEMA:
        return False, f"bad schema {proof.get('schema')!r}"
    records = proof.get("records")
    if not isinstance(records, list) or not records:
        return False, "missing records"
    for record in records:
        activations = record.get("activation_s8")
        rows = record.get("row_results")
        if not isinstance(activations, list) or not isinstance(rows, list):
            return False, f"malformed record {record.get('layer_name')}"
        if any(not isinstance(value, int) or not -128 <= value <= 127 for value in activations):
            return False, f"activation outside s8 range in {record.get('layer_name')}"
        for row in rows:
            words = row.get("packed_w4_words_hex")
            if not isinstance(words, list):
                return False, f"missing packed words in {record.get('layer_name')}"
            weights = [
                weight
                for word in words
                for weight in unpack_signed_w4_word(int(str(word), 16))
            ][: len(activations)]
            if any(not -8 <= weight <= 7 for weight in weights):
                return False, f"unpacked W4 outside range in {record.get('layer_name')}"
            accumulator = sum(a * w for a, w in zip(activations, weights, strict=True))
            if accumulator != int(row.get("accumulator", 0)):
                return False, f"accumulator mismatch in {record.get('layer_name')}"
            if _saturating_shift7(accumulator) != int(row.get("requantized_s8", 0)):
                return False, f"requantized mismatch in {record.get('layer_name')}"
    return True, f"{len(records)} layer W4A8 microkernel records validated"


def _validate_tensor_schedule(schedule: dict, placement: dict) -> tuple[bool, str]:
    if schedule.get("schema") != TENSOR_SCHEDULE_SCHEMA:
        return False, f"bad schema {schedule.get('schema')!r}"
    if schedule.get("source_placement_sha256") != placement.get("artifact_sha256"):
        return False, "schedule does not reference placement"
    records = schedule.get("layers")
    if not isinstance(records, list) or not records:
        return False, "missing schedule records"
    placement_by_index = {int(layer["index"]): layer for layer in placement["layers"]}
    for record in records:
        layer = placement_by_index.get(int(record["layer_index"]))
        if layer is None:
            return False, f"unknown layer {record.get('layer_index')}"
        if int(record["row_coverage"]) != int(layer["rows"]):
            return False, f"row coverage mismatch in {record.get('layer_name')}"
        if int(record["assigned_cores"]) != int(layer["assigned_cores"]):
            return False, f"core-count mismatch in {record.get('layer_name')}"
        if int(record["k_wave_count"]) < 1:
            return False, f"missing K waves in {record.get('layer_name')}"
        if not bool(record["fits_core_sram"]):
            return False, f"SRAM overflow in {record.get('layer_name')}"
        sampled = record.get("sampled_core_schedules")
        if not isinstance(sampled, list):
            return False, f"missing sampled core schedules in {record.get('layer_name')}"
        for core in sampled:
            if int(core["row_start"]) >= int(core["row_end_exclusive"]):
                return False, f"empty row band in {record.get('layer_name')}"
            if int(core["weight_shard_bytes"]) > int(record["usable_bytes_per_core"]):
                return False, f"sampled row band exceeds SRAM in {record.get('layer_name')}"
    return True, f"{len(records)} layer tensor tile schedules validated"


def _validate_schedule_execution_estimate(
    estimate: dict,
    schedule: dict,
) -> tuple[bool, str]:
    if estimate.get("schema") != SCHEDULE_EXECUTION_SCHEMA:
        return False, f"bad schema {estimate.get('schema')!r}"
    if estimate.get("source_tensor_schedule_sha256") != schedule.get("artifact_sha256"):
        return False, "execution estimate does not reference tensor schedule"
    if int(estimate.get("estimated_layer_count", 0)) != int(schedule["scheduled_layer_count"]):
        return False, "execution estimate does not cover every scheduled layer"
    if int(estimate.get("total_k_wave_count", 0)) != int(schedule["total_k_wave_count"]):
        return False, "execution estimate K-wave count changed"
    if int(estimate.get("total_core_wave_count", 0)) != int(schedule["total_core_wave_count"]):
        return False, "execution estimate core-wave count changed"
    if int(estimate.get("total_schedule_cycles", 0)) <= 0:
        return False, "execution estimate has no cycles"
    if float(estimate.get("estimated_elapsed_ms", 0.0)) <= 0.0:
        return False, "execution estimate has no elapsed time"
    if float(estimate.get("effective_tops", 0.0)) <= 0.0:
        return False, "execution estimate has no effective throughput"
    sampled = estimate.get("layer_execution_sample")
    if not isinstance(sampled, list) or not sampled:
        return False, "execution estimate missing sampled layers"
    for layer in sampled:
        if int(layer.get("mac_count", 0)) <= 0:
            return False, f"sampled layer has no MACs: {layer.get('layer_name')}"
        if int(layer.get("estimated_layer_cycles", 0)) <= 0:
            return False, f"sampled layer has no cycles: {layer.get('layer_name')}"
    return True, f"{estimate['estimated_layer_count']} scheduled layers estimated"


def _validate_color_pressure(pressure: dict, schedule: dict, config) -> tuple[bool, str]:
    if pressure.get("schema") != COLOR_PRESSURE_SCHEMA:
        return False, f"bad schema {pressure.get('schema')!r}"
    if pressure.get("source_tensor_schedule_sha256") != schedule.get("artifact_sha256"):
        return False, "color pressure does not reference tensor schedule"
    if int(pressure.get("routing_color_capacity", 0)) != int(config.routing_colors):
        return False, "color pressure capacity does not match config"
    if int(pressure.get("scheduled_layer_count", 0)) != int(schedule["scheduled_layer_count"]):
        return False, "color pressure does not cover every scheduled layer"
    records = pressure.get("color_records")
    if not isinstance(records, list) or len(records) != int(config.routing_colors):
        return False, "color pressure missing per-color records"
    layer_count = sum(int(record.get("layer_count", 0)) for record in records)
    if layer_count != int(schedule["scheduled_layer_count"]):
        return False, "color pressure layer count does not match schedule"
    if sum(int(record.get("k_wave_count", 0)) for record in records) != int(
        schedule["total_k_wave_count"]
    ):
        return False, "color pressure K-wave count does not match schedule"
    if sum(int(record.get("core_wave_count", 0)) for record in records) != int(
        schedule["total_core_wave_count"]
    ):
        return False, "color pressure core-wave count does not match schedule"
    if int(pressure.get("used_routing_color_count", 0)) < int(config.routing_colors):
        return False, "scheduled graph does not exercise every routing color"
    if int(pressure.get("total_fabric_wavelets", 0)) <= 0:
        return False, "color pressure has no fabric wavelets"
    if not 0.0 < float(pressure.get("peak_color_fraction", 0.0)) <= 1.0:
        return False, "color pressure peak fraction out of range"
    return True, f"{len(records)} routing colors audited"


def _validate_color_timing(
    timing: dict,
    color_pressure: dict,
    execution: dict,
    config,
) -> tuple[bool, str]:
    if timing.get("schema") != COLOR_TIMING_SCHEMA:
        return False, f"bad schema {timing.get('schema')!r}"
    if timing.get("source_color_pressure_sha256") != color_pressure.get("artifact_sha256"):
        return False, "color timing does not reference color pressure"
    if int(timing.get("routing_color_capacity", 0)) != int(config.routing_colors):
        return False, "color timing capacity does not match config"
    if int(timing.get("used_routing_color_count", 0)) != int(
        color_pressure["used_routing_color_count"]
    ):
        return False, "color timing used-color count changed"
    if int(timing.get("total_fabric_wavelets", 0)) != int(
        color_pressure["total_fabric_wavelets"]
    ):
        return False, "color timing fabric-wavelet count changed"
    if float(timing.get("repair_hop_penalty", -1.0)) != float(
        execution["repair_hop_penalty"]
    ):
        return False, "color timing repair-hop penalty does not match execution estimate"
    records = timing.get("color_timings")
    if not isinstance(records, list) or len(records) != int(config.routing_colors):
        return False, "color timing missing per-color records"
    if int(timing.get("peak_color_fabric_cycles", 0)) <= 0:
        return False, "color timing has no peak fabric cycles"
    if int(timing["peak_color_fabric_cycles"]) > int(execution["total_schedule_cycles"]):
        return False, "peak color fabric cycles exceed schedule execution cycles"
    return True, f"{len(records)} routing colors have fabric timing estimates"


def run_checks() -> tuple[list[dict[str, str]], dict[str, int | float | str]]:
    checks: list[dict[str, str]] = []
    summary: dict[str, int | float | str] = {}
    if not MANIFEST.is_file():
        return [
            {
                "id": "manifest_present",
                "status": "blocked",
                "detail": f"missing {MANIFEST.relative_to(ROOT)}",
            }
        ], summary

    manifest = parse_manifest(load_json_object(MANIFEST))
    config = scaled_8gb_config()
    placement = map_graph(manifest, config)
    plan = build_kernel_dispatch_plan(
        placement,
        config,
        source_manifest=str(MANIFEST.relative_to(ROOT)),
    )
    proof = build_w4a8_microkernel_proof(placement, plan)
    schedule = build_tensor_tile_schedule(placement, plan)
    color_pressure = build_fabric_color_pressure(schedule, config)
    repair_hop_penalty = repair_hop_penalty_for_scenario(config, HIGH_DEFECT_SCENARIO)
    color_timing = build_fabric_color_timing(
        color_pressure,
        config,
        repair_hop_penalty=repair_hop_penalty,
    )
    execution = build_schedule_execution_estimate(
        schedule,
        config,
        repair_hop_penalty=repair_hop_penalty,
    )

    PLACEMENT_OUT.parent.mkdir(parents=True, exist_ok=True)
    PLACEMENT_OUT.write_text(json.dumps(placement, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    KERNEL_PLAN_OUT.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    MICROKERNEL_PROOF_OUT.write_text(
        json.dumps(proof, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    TENSOR_SCHEDULE_OUT.write_text(
        json.dumps(schedule, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    COLOR_PRESSURE_OUT.write_text(
        json.dumps(color_pressure, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    COLOR_TIMING_OUT.write_text(
        json.dumps(color_timing, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    SCHEDULE_EXECUTION_OUT.write_text(
        json.dumps(execution, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    checks.append(
        {
            "id": "kernel_plan_schema",
            "status": "pass" if plan.get("schema") == KERNEL_PLAN_SCHEMA else "fail",
            "detail": f"schema={plan.get('schema')}",
        }
    )
    checks.append(
        {
            "id": "kernel_plan_links_placement",
            "status": "pass"
            if plan.get("source_placement_sha256") == placement.get("artifact_sha256")
            else "fail",
            "detail": "kernel plan references the exact graph placement artifact",
        }
    )
    checks.append(
        {
            "id": "all_layers_programmed",
            "status": "pass"
            if int(plan["programmed_layer_count"]) == int(placement["layer_count"])
            else "fail",
            "detail": f"{plan['programmed_layer_count']} layer dispatch programs for "
            f"{placement['layer_count']} placed layers",
        }
    )

    records = plan.get("program_records")
    if not isinstance(records, list) or not records:
        checks.append({"id": "program_records_present", "status": "fail", "detail": "no records"})
        return checks, summary
    checks.append(
        {
            "id": "program_records_present",
            "status": "pass",
            "detail": f"{len(records)} program records emitted",
        }
    )

    bad_words: list[str] = []
    bad_payloads: list[str] = []
    allowed_opcodes = {0x13, 0x23, 0x37, 0x73}
    layers_by_index = {int(layer["index"]): layer for layer in placement["layers"]}
    for record in records:
        words = record.get("boot_words_hex")
        if not isinstance(words, list) or len(words) != int(record["instruction_word_count"]):
            bad_words.append(str(record.get("layer_name")))
            continue
        if any(not isinstance(word, str) or _decode_opcode(word) not in allowed_opcodes for word in words):
            bad_words.append(str(record.get("layer_name")))
        if words[-1] != "00000073":
            bad_words.append(str(record.get("layer_name")))
        layer = layers_by_index[int(record["layer_index"])]
        if int(record["dispatch_payload"]) != layer_dispatch_payload(layer):
            bad_payloads.append(str(record.get("layer_name")))

    checks.append(
        {
            "id": "rv64im_dispatch_words_decode",
            "status": "pass" if not bad_words else "fail",
            "detail": "all dispatch programs use PE-supported LUI/ADDI/SW/ECALL words"
            if not bad_words
            else f"bad programs: {bad_words[:4]}",
        }
    )
    checks.append(
        {
            "id": "dispatch_payloads_match_placement",
            "status": "pass" if not bad_payloads else "fail",
            "detail": "dispatch payloads encode layer index, fabric color, and assigned-core count"
            if not bad_payloads
            else f"bad payloads: {bad_payloads[:4]}",
        }
    )
    checks.append(
        {
            "id": "microkernel_proof_links_plan",
            "status": "pass"
            if proof.get("source_kernel_plan_sha256") == plan.get("artifact_sha256")
            and proof.get("source_placement_sha256") == placement.get("artifact_sha256")
            else "fail",
            "detail": "W4A8 proof links to kernel plan and placement artifact hashes",
        }
    )
    proof_ok, proof_detail = _validate_microkernel_proof(proof)
    checks.append(
        {
            "id": "w4a8_microkernel_numerics",
            "status": "pass" if proof_ok else "fail",
            "detail": proof_detail,
        }
    )
    checks.append(
        {
            "id": "tensor_schedule_links_plan",
            "status": "pass"
            if schedule.get("source_kernel_plan_sha256") == plan.get("artifact_sha256")
            and schedule.get("source_placement_sha256") == placement.get("artifact_sha256")
            else "fail",
            "detail": "tensor tile schedule links to kernel plan and placement artifact hashes",
        }
    )
    schedule_ok, schedule_detail = _validate_tensor_schedule(schedule, placement)
    checks.append(
        {
            "id": "tensor_schedule_covers_rows_k_and_sram",
            "status": "pass" if schedule_ok else "fail",
            "detail": schedule_detail,
        }
    )
    checks.append(
        {
            "id": "fabric_color_pressure_links_schedule",
            "status": "pass"
            if color_pressure.get("source_tensor_schedule_sha256")
            == schedule.get("artifact_sha256")
            else "fail",
            "detail": "fabric color pressure links to tensor schedule artifact hash",
        }
    )
    color_ok, color_detail = _validate_color_pressure(color_pressure, schedule, config)
    checks.append(
        {
            "id": "fabric_color_pressure_covers_colors",
            "status": "pass" if color_ok else "fail",
            "detail": color_detail,
        }
    )
    checks.append(
        {
            "id": "fabric_color_timing_links_pressure",
            "status": "pass"
            if color_timing.get("source_color_pressure_sha256")
            == color_pressure.get("artifact_sha256")
            else "fail",
            "detail": "fabric color timing links to color pressure artifact hash",
        }
    )
    checks.append(
        {
            "id": "schedule_execution_links_schedule",
            "status": "pass"
            if execution.get("source_tensor_schedule_sha256") == schedule.get("artifact_sha256")
            else "fail",
            "detail": "schedule execution estimate links to tensor schedule artifact hash",
        }
    )
    execution_ok, execution_detail = _validate_schedule_execution_estimate(execution, schedule)
    timing_ok, timing_detail = _validate_color_timing(
        color_timing,
        color_pressure,
        execution,
        config,
    )
    checks.append(
        {
            "id": "fabric_color_timing_bounded_by_schedule",
            "status": "pass" if timing_ok else "fail",
            "detail": timing_detail,
        }
    )
    checks.append(
        {
            "id": "schedule_execution_cycles_positive",
            "status": "pass" if execution_ok else "fail",
            "detail": execution_detail,
        }
    )

    summary = {
        "kernel_plan_artifact": str(KERNEL_PLAN_OUT.relative_to(ROOT)),
        "microkernel_proof_artifact": str(MICROKERNEL_PROOF_OUT.relative_to(ROOT)),
        "tensor_schedule_artifact": str(TENSOR_SCHEDULE_OUT.relative_to(ROOT)),
        "fabric_color_pressure_artifact": str(COLOR_PRESSURE_OUT.relative_to(ROOT)),
        "fabric_color_timing_artifact": str(COLOR_TIMING_OUT.relative_to(ROOT)),
        "schedule_execution_artifact": str(SCHEDULE_EXECUTION_OUT.relative_to(ROOT)),
        "kernel_plan_sha256": str(plan["artifact_sha256"]),
        "microkernel_proof_sha256": str(proof["artifact_sha256"]),
        "tensor_schedule_sha256": str(schedule["artifact_sha256"]),
        "fabric_color_pressure_sha256": str(color_pressure["artifact_sha256"]),
        "fabric_color_timing_sha256": str(color_timing["artifact_sha256"]),
        "schedule_execution_sha256": str(execution["artifact_sha256"]),
        "placement_sha256": str(placement["artifact_sha256"]),
        "layer_count": int(plan["layer_count"]),
        "total_instruction_words": int(plan["total_instruction_words"]),
        "program_record_count": len(records),
        "wavelet_tx_data_addr": int(plan["wavelet_tx_data_addr"]),
        "microkernel_sample_mac_count": int(proof["sample_mac_count"]),
        "microkernel_aggregate_checksum": int(proof["aggregate_checksum"]),
        "tensor_schedule_core_waves": int(schedule["total_core_wave_count"]),
        "tensor_schedule_k_waves": int(schedule["total_k_wave_count"]),
        "fabric_color_pressure_used_colors": int(
            color_pressure["used_routing_color_count"]
        ),
        "fabric_color_pressure_total_wavelets": int(
            color_pressure["total_fabric_wavelets"]
        ),
        "fabric_color_pressure_peak_fraction": float(
            color_pressure["peak_color_fraction"]
        ),
        "fabric_color_timing_peak_color": int(color_timing["peak_routing_color"]),
        "fabric_color_timing_peak_cycles": int(
            color_timing["peak_color_fabric_cycles"]
        ),
        "fabric_color_timing_total_cycles": int(
            color_timing["total_color_fabric_cycles"]
        ),
        "schedule_execution_repair_hop_penalty": float(
            execution["repair_hop_penalty"]
        ),
        "schedule_execution_total_cycles": int(execution["total_schedule_cycles"]),
        "schedule_execution_elapsed_ms": float(execution["estimated_elapsed_ms"]),
        "schedule_execution_effective_tops": float(execution["effective_tops"]),
    }
    return checks, summary


def main() -> int:
    checks, summary = run_checks()
    failures = [check for check in checks if check["status"] == "fail"]
    blocked = [check for check in checks if check["status"] == "blocked"]
    status = "BLOCKED" if failures or blocked else "PASS"
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-kernel-codegen",
        "status": status,
        "as_of": _now(),
        "generated_utc": _now(),
        "subsystem": "compiler_runtime",
        "claim_boundary": (
            "E1X real-graph RV64IM layer-dispatch code generation only: emits "
            "concrete PE boot words and wavelet dispatch tokens from the checked "
            "13B W4A8 graph placement, W4A8 scalar samples, row/K-wave schedules, "
            "fabric color pressure, and an architecture-level schedule cycle estimate. "
            "Not cycle-accurate tensor execution, full-output numerical proof, or "
            "silicon evidence."
        ),
        "evidence_paths": [
            "compiler/runtime/e1x_kernel_codegen.py",
            "compiler/runtime/e1x_graph_mapper.py",
            "benchmarks/models/llama13b-w4a8-manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-kernel-dispatch-plan.json",
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "benchmarks/results/e1x-real-graph-fabric-color-pressure.json",
            "benchmarks/results/e1x-real-graph-fabric-color-timing.json",
            "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json",
        ],
        "checks": checks,
        "summary": {
            **summary,
            "check_count": len(checks),
            "failing_check_count": len(failures),
            "blocked_check_count": len(blocked),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if status != "PASS":
        print("BLOCKED: E1X kernel codegen failed: " + ", ".join(c["id"] for c in failures + blocked))
        return 1
    print(f"PASS: E1X kernel codegen; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
