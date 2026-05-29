from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_kernel_codegen_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_kernel_codegen.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X kernel codegen" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_kernel_codegen.json").read_text())
    assert report["schema"] == "eliza.gate_status.v1"
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["layer_count"] == 283
    assert report["summary"]["total_instruction_words"] > 0
    assert report["summary"]["microkernel_sample_mac_count"] > 0
    assert report["summary"]["microkernel_aggregate_checksum"] > 0
    assert report["summary"]["tensor_schedule_core_waves"] > 0
    assert report["summary"]["tensor_schedule_k_waves"] > 0
    assert report["summary"]["fabric_color_pressure_used_colors"] == 24
    assert report["summary"]["fabric_color_pressure_total_wavelets"] > 0
    assert 0.0 < report["summary"]["fabric_color_pressure_peak_fraction"] <= 1.0
    assert 0 <= report["summary"]["fabric_color_timing_peak_color"] < 24
    assert report["summary"]["fabric_color_timing_peak_cycles"] > 0
    assert report["summary"]["fabric_color_timing_total_cycles"] > 0
    assert report["summary"]["schedule_execution_repair_hop_penalty"] >= 0.0
    assert report["summary"]["schedule_execution_total_cycles"] > 0
    assert float(report["summary"]["schedule_execution_elapsed_ms"]) > 0.0
    assert float(report["summary"]["schedule_execution_effective_tops"]) > 0.0
    checks = {check["id"]: check for check in report["checks"]}
    assert checks["all_layers_programmed"]["status"] == "pass"
    assert checks["rv64im_dispatch_words_decode"]["status"] == "pass"
    assert checks["dispatch_payloads_match_placement"]["status"] == "pass"
    assert checks["microkernel_proof_links_plan"]["status"] == "pass"
    assert checks["w4a8_microkernel_numerics"]["status"] == "pass"
    assert checks["tensor_schedule_links_plan"]["status"] == "pass"
    assert checks["tensor_schedule_covers_rows_k_and_sram"]["status"] == "pass"
    assert checks["fabric_color_pressure_links_schedule"]["status"] == "pass"
    assert checks["fabric_color_pressure_covers_colors"]["status"] == "pass"
    assert checks["fabric_color_timing_links_pressure"]["status"] == "pass"
    assert checks["fabric_color_timing_bounded_by_schedule"]["status"] == "pass"
    assert checks["schedule_execution_links_schedule"]["status"] == "pass"
    assert checks["schedule_execution_cycles_positive"]["status"] == "pass"

    plan = json.loads(
        (ROOT / "benchmarks/results/e1x-real-graph-kernel-dispatch-plan.json").read_text()
    )
    assert plan["schema"] == "eliza.e1x.kernel_dispatch_plan.v1"
    assert plan["programmed_layer_count"] == report["summary"]["layer_count"]

    proof = json.loads(
        (ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json").read_text()
    )
    assert proof["schema"] == "eliza.e1x.w4a8_microkernel_proof.v1"
    assert proof["source_kernel_plan_sha256"] == plan["artifact_sha256"]
    assert proof["proved_layer_record_count"] == report["summary"]["layer_count"]

    schedule = json.loads(
        (ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json").read_text()
    )
    assert schedule["schema"] == "eliza.e1x.tensor_tile_schedule.v1"
    assert schedule["source_kernel_plan_sha256"] == plan["artifact_sha256"]
    assert schedule["scheduled_layer_count"] == report["summary"]["layer_count"]
    assert schedule["all_rows_covered"] is True
    assert schedule["all_shards_fit_sram"] is True

    color_pressure = json.loads(
        (ROOT / "benchmarks/results/e1x-real-graph-fabric-color-pressure.json").read_text()
    )
    assert color_pressure["schema"] == "eliza.e1x.fabric_color_pressure.v1"
    assert color_pressure["source_tensor_schedule_sha256"] == schedule["artifact_sha256"]
    assert color_pressure["scheduled_layer_count"] == report["summary"]["layer_count"]
    assert color_pressure["used_routing_color_count"] == 24
    assert color_pressure["total_fabric_wavelets"] > 0

    color_timing = json.loads(
        (ROOT / "benchmarks/results/e1x-real-graph-fabric-color-timing.json").read_text()
    )
    assert color_timing["schema"] == "eliza.e1x.fabric_color_timing.v1"
    assert color_timing["source_color_pressure_sha256"] == color_pressure["artifact_sha256"]
    assert color_timing["used_routing_color_count"] == 24
    assert color_timing["peak_color_fabric_cycles"] > 0

    execution = json.loads(
        (
            ROOT / "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json"
        ).read_text()
    )
    assert execution["schema"] == "eliza.e1x.schedule_execution_estimate.v1"
    assert execution["source_tensor_schedule_sha256"] == schedule["artifact_sha256"]
    assert execution["estimated_layer_count"] == report["summary"]["layer_count"]
    assert (
        execution["repair_hop_penalty"]
        == report["summary"]["schedule_execution_repair_hop_penalty"]
    )
    assert execution["total_schedule_cycles"] > 0
    assert color_timing["peak_color_fabric_cycles"] <= execution["total_schedule_cycles"]
    assert color_timing["repair_hop_penalty"] == execution["repair_hop_penalty"]
    assert execution["estimated_elapsed_ms"] > 0.0
    assert execution["effective_tops"] > 0.0
