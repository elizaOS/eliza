from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_benchmark_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_benchmark.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X benchmark" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_benchmark.json").read_text())
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["claim_level"] == "L2_ARCH_SIM"
    assert report["summary"]["scaled_local_sram_mib"] >= 8192
    assert report["summary"]["scaled_model_required_mib"] < report["summary"]["scaled_local_sram_mib"]
    assert report["summary"]["high_failure_prefill_ms"] > 0
    assert report["summary"]["high_failure_decode_tokens_per_second"] > 0
    assert report["summary"]["high_failure_output_checksum"] > 0
    assert (
        report["summary"]["high_failure_execution_trace_output_checksum"]
        == report["summary"]["high_failure_output_checksum"]
    )
    assert report["summary"]["high_failure_execution_trace_total_cycles"] > 0
    assert report["summary"]["real_graph_layers"] == 283
    assert report["summary"]["real_graph_total_parameters"] > 12_000_000_000
    assert report["summary"]["real_graph_e1_comparison_basis"] == "open_2028_sota_160tops"
    assert report["summary"]["real_graph_model_required_mib"] > 7000
    assert report["summary"]["real_graph_model_required_vs_e1_sram"] > 100
    assert 0.0 < report["summary"]["real_graph_model_required_vs_e1x_sram"] < 1.0
    assert report["summary"]["real_graph_high_failure_route_checks"] >= 4096
    assert report["summary"]["real_graph_high_failure_repair_hop_penalty"] >= 0.0
    assert report["summary"]["real_graph_high_failure_output_checksum"] > 0
    assert report["summary"]["real_graph_normal_defect_map_sha256"]
    assert report["summary"]["real_graph_normal_repair_manifest_sha256"]
    assert report["summary"]["real_graph_normal_repair_rom_sha256"]
    assert report["summary"]["real_graph_high_failure_defect_map_sha256"]
    assert report["summary"]["real_graph_high_failure_repair_manifest_sha256"]
    assert report["summary"]["real_graph_high_failure_repair_rom_sha256"]
    assert report["summary"]["real_graph_normal_remapped_cores"] > 0
    assert (
        report["summary"]["real_graph_high_failure_remapped_cores"]
        > report["summary"]["real_graph_normal_remapped_cores"]
    )
    assert report["summary"]["real_graph_normal_sampled_repair_routes"] > 0
    assert report["summary"]["real_graph_high_failure_sampled_repair_routes"] > 0
    assert report["summary"]["real_graph_normal_repair_rom_words"] > 8
    assert (
        report["summary"]["real_graph_high_failure_repair_rom_words"]
        > report["summary"]["real_graph_normal_repair_rom_words"]
    )
    assert report["summary"]["real_graph_normal_execution_trace_cycles"] > 0
    assert report["summary"]["real_graph_normal_execution_trace_sha256"]
    assert report["summary"]["real_graph_high_failure_execution_trace_cycles"] > 0
    assert report["summary"]["real_graph_high_failure_execution_trace_sha256"]
    assert report["summary"]["real_graph_high_failure_trace_sampled_layers"] > 0
    assert report["summary"]["real_graph_normal_trace_sampled_layers"] > 0
    assert report["summary"]["real_graph_high_vs_normal_trace_cycle_ratio"] >= 1.0
    assert report["summary"]["real_graph_kernel_dispatch_layers"] == report["summary"]["real_graph_layers"]
    assert report["summary"]["real_graph_kernel_dispatch_words"] > 0
    assert report["summary"]["real_graph_microkernel_sample_macs"] > 0
    assert report["summary"]["real_graph_microkernel_checksum"] > 0
    assert report["summary"]["real_graph_tensor_schedule_core_waves"] > 0
    assert report["summary"]["real_graph_tensor_schedule_k_waves"] > 0
    assert report["summary"]["real_graph_fabric_color_used_colors"] == 24
    assert report["summary"]["real_graph_fabric_color_total_wavelets"] > 0
    assert 0.0 < report["summary"]["real_graph_fabric_color_peak_fraction"] <= 1.0
    assert 0 <= report["summary"]["real_graph_fabric_color_timing_peak_color"] < 24
    assert report["summary"]["real_graph_fabric_color_timing_peak_cycles"] > 0
    assert report["summary"]["real_graph_fabric_color_timing_total_cycles"] > 0
    assert (
        report["summary"]["real_graph_schedule_execution_repair_hop_penalty"]
        == report["summary"]["real_graph_high_failure_repair_hop_penalty"]
    )
    assert report["summary"]["real_graph_schedule_execution_total_cycles"] > 0
    assert (
        report["summary"]["real_graph_schedule_execution_total_cycles"]
        <= report["summary"]["real_graph_high_failure_execution_trace_cycles"]
    )
    assert (
        report["summary"]["real_graph_fabric_color_timing_peak_cycles"]
        <= report["summary"]["real_graph_schedule_execution_total_cycles"]
    )
    assert report["summary"]["real_graph_schedule_execution_elapsed_ms"] > 0.0
    assert report["summary"]["real_graph_schedule_execution_effective_tops"] > 0.0
    assert report["summary"]["real_graph_schedule_effective_tops_vs_e1_peak"] > 0.0
    assert 0.0 < report["summary"]["real_graph_schedule_cycles_vs_trace_cycles"] <= 1.0
    checks = {check["id"]: check for check in report["checks"]}
    assert checks["e1x_real_graph_kernel_dispatch_codegen"]["status"] == "pass"
