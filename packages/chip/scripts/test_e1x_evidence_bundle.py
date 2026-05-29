from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_evidence_bundle_gate_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_evidence_bundle.py"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    assert "PASS: E1X evidence bundle" in result.stdout
    report = json.loads((ROOT / "build/reports/e1x_evidence_bundle.json").read_text())
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["evidence_path_check_count"] == 41
    assert report["summary"]["freshness_check_count"] == 41
    assert report["summary"]["real_graph_model_required_vs_e1_sram"] > 100
    assert 0.0 < report["summary"]["real_graph_model_required_vs_e1x_sram"] < 1.0
    assert report["summary"]["boot_verified_rom_case_count"] == 3
    assert report["summary"]["repair_capacity_rom_case_count"] == 3
    assert report["summary"]["repair_capacity_fuse_window_words"] == 4096
    assert report["summary"]["repair_capacity_dedicated_sram_bytes"] <= 48 * 1024
    assert report["summary"]["repair_fuse_reader_max_streamed_word_count"] == 3582
    assert report["summary"]["repair_fuse_reader_verilator_lint_clean"] is True
    assert (
        report["summary"]["repair_fuse_reader_residual_blocker"]
        == "silicon_fuse_burning_and_foundry_otp_macro_missing"
    )
    assert report["summary"]["yield_high_failure_spare_margin"] == 10_410
    assert report["summary"]["yield_high_failure_spare_utilization"] < 0.5
    assert report["summary"]["yield_high_vs_normal_remap_ratio"] > 10.0
    assert report["summary"]["repair_rom_cocotb_testcases"] >= 16
    assert report["summary"]["tile_cocotb_testcases"] >= 12
    assert report["summary"]["core_cocotb_testcases"] >= 22
    assert report["summary"]["pe_core_cocotb_testcases"] >= 16
    assert report["summary"]["tensor_numerics_proof_layer_count"] == 283
    assert report["summary"]["tensor_numerics_checked_mac_count"] == 26180
    assert report["summary"]["tensor_numerics_total_assigned_cores"] == 151367
    assert report["summary"]["tensor_cycle_executor_executed_row_count"] == 1132
    assert report["summary"]["tensor_cycle_executor_scalar_cycle_count"] == 108116
    assert (
        report["summary"]["tensor_cycle_executor_residual_blocker"]
        == "vectorized_full_tensor_fabric_executor_missing"
    )
    assert report["summary"]["reduction_merge_cocotb_testcases"] == 5
    assert (
        report["summary"]["reduction_merge_residual_blocker"]
        == "vectorized_full_tensor_fabric_executor_missing"
    )
    assert report["summary"]["tensor_fabric_executor_merged_partial_count"] == 1132
    assert report["summary"]["tensor_fabric_executor_merge_cycle_count"] == 1415
    assert report["summary"]["tensor_fabric_executor_total_sampled_cycles"] == 109531
    assert (
        report["summary"]["tensor_fabric_executor_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["tensor_output_sampled_row_count"] == 1132
    assert report["summary"]["tensor_output_sampled_checksum"] == 14_414_877_542_268_347_137
    assert (
        report["summary"]["tensor_output_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["full_output_missing_row_count"] == 2_607_508
    assert report["summary"]["full_output_missing_mac_count"] == 13_015_838_140
    assert 0.0 < report["summary"]["full_output_row_coverage_fraction"] < 0.001
    assert 0.0 < report["summary"]["full_output_mac_coverage_fraction"] < 0.001
    assert (
        report["summary"]["full_output_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["execution_ladder_real_sampled_rows"] == 1_132
    assert report["summary"]["execution_ladder_deterministic_window_rows"] == 18_112
    assert report["summary"]["execution_ladder_row_coverage_gain"] == 16.0
    assert report["summary"]["execution_ladder_window_remaining_rows"] == 2_590_528
    assert report["summary"]["execution_ladder_routed_window_checksum"] == 15_818_110_737_476_397_592
    assert (
        report["summary"]["execution_ladder_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["full_output_workplan_vector_word_op_count"] == 1_627_345_920
    assert report["summary"]["full_output_workplan_core_wave_count"] == 4_187_241
    assert (
        report["summary"]["full_output_workplan_sha256"]
        == "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
    )
    assert (
        report["summary"]["full_output_workplan_residual_blocker"]
        == "full_output_vectorized_tensor_kernel_execution_missing"
    )
    assert report["summary"]["vector_kernel_template_instruction_words"] == 54
    assert report["summary"]["vector_kernel_template_instruction_estimate"] == 87_876_679_680
    assert (
        report["summary"]["vector_kernel_template_sha256"]
        == "3e98428c1de7d7f7ca9c549bcdc48699fddaaf0da38bf37a723c68f3f712b18c"
    )
    assert (
        report["summary"]["vector_kernel_template_residual_blocker"]
        == "looped_vector_kernel_codegen_and_full_execution_missing"
    )
    assert report["summary"]["looped_vector_kernel_skeleton_instruction_words"] == 11
    assert report["summary"]["looped_vector_kernel_control_instruction_estimate"] == 6_517_209_600
    assert report["summary"]["looped_vector_kernel_combined_instruction_estimate"] == 94_393_889_280
    assert (
        report["summary"]["looped_vector_kernel_skeleton_residual_blocker"]
        == "per_layer_looped_vector_kernel_codegen_execution_missing"
    )
    assert report["summary"]["per_layer_vector_codegen_layer_count"] == 283
    assert report["summary"]["per_layer_vector_codegen_total_instruction_estimate"] == 94_393_889_280
    assert (
        report["summary"]["per_layer_vector_codegen_sha256"]
        == "3815c04bfb38c664d3215e0b268e6ed8d801a7a075a1dab6ab1174d4e4635956"
    )
    assert (
        report["summary"]["per_layer_vector_codegen_residual_blocker"]
        == "full_output_vector_kernel_execution_missing"
    )
    assert report["summary"]["sampled_vector_kernel_executor_row_count"] == 1_132
    assert report["summary"]["sampled_vector_kernel_executor_vector_word_ops"] == 3_556
    assert report["summary"]["sampled_vector_kernel_executor_lane_macs"] == 26_180
    assert (
        report["summary"]["sampled_vector_kernel_executor_trace_sha256"]
        == "f26180ab548688b9ff9f8f47bde426285c160ce99b08a55e6b35eed459ae607c"
    )
    assert (
        report["summary"]["sampled_vector_kernel_executor_residual_blocker"]
        == "full_output_vector_kernel_execution_missing"
    )
    assert report["summary"]["vector_kernel_window_executor_row_count"] == 18_112
    assert report["summary"]["vector_kernel_window_executor_vector_word_ops"] == 56_896
    assert report["summary"]["vector_kernel_window_executor_lane_macs"] == 418_880
    assert 0.006 < report["summary"]["vector_kernel_window_executor_row_coverage_fraction"] < 0.007
    assert report["summary"]["vector_kernel_window_executor_checksum"] == 3_343_337_413_686_647_285
    assert (
        report["summary"]["vector_kernel_window_executor_residual_blocker"]
        == "full_output_vector_kernel_execution_missing"
    )
    assert report["summary"]["vector_window_fabric_checksum_row_count"] == 18_112
    assert report["summary"]["vector_window_fabric_checksum_vector_word_ops"] == 56_896
    assert report["summary"]["vector_window_fabric_checksum_merge_cycles"] == 18_395
    assert report["summary"]["vector_window_fabric_checksum_routing_colors"] == 24
    assert report["summary"]["vector_window_fabric_checksum"] == 15_818_110_737_476_397_592
    assert (
        report["summary"]["vector_window_fabric_checksum_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_shard_linkage_touched_shards"] == 1_169
    assert report["summary"]["window_shard_linkage_touched_loader_words"] == 11_060_496
    assert report["summary"]["window_shard_linkage_touched_bytes"] == 44_241_984
    assert (
        report["summary"]["window_shard_linkage_record_sha256"]
        == "1380e6e328093661e5e6b89502ec174551aaab8a3d6b75d4734b719af4afe47c"
    )
    assert (
        report["summary"]["window_shard_linkage_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_repair_linkage_touched_cores"] == 1_169
    assert report["summary"]["window_repair_linkage_normal_remapped"] == 2
    assert report["summary"]["window_repair_linkage_high_failure_remapped"] == 24
    assert report["summary"]["window_repair_linkage_high_vs_normal_ratio"] == 12.0
    assert (
        report["summary"]["window_repair_linkage_core_sha256"]
        == "1e05a2dbd9ff2b80f93060da822e8cc8cddcebde7ec6f3be11634e22774374a3"
    )
    assert (
        report["summary"]["window_repair_linkage_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_route_validation_neighbor_edges"] == 963
    assert report["summary"]["window_route_validation_normal_extra_hops"] == 185
    assert report["summary"]["window_route_validation_high_failure_extra_hops"] == 6_571
    assert (
        report["summary"]["window_route_validation_high_failure_route_checksum"]
        == 3_111_431_909_571_140_830
    )
    assert (
        report["summary"]["window_route_validation_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_repair_rom_linkage_normal_remap_words"] == 2
    assert report["summary"]["window_repair_rom_linkage_high_failure_remap_words"] == 24
    assert (
        report["summary"]["window_repair_rom_linkage_high_failure_remap_sha256"]
        == "9c1b36917508a10a43b22210e13945a189a96f1571e4fcee06a92e4fc14af3c4"
    )
    assert report["summary"]["window_repair_rom_linkage_high_failure_rom_words"] == 3_582
    assert (
        report["summary"]["window_repair_rom_linkage_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_execution_trace_normal_cycles"] == 47_501_642_583
    assert report["summary"]["window_execution_trace_high_failure_cycles"] == 63_132_355_414
    assert report["summary"]["window_execution_trace_cycle_ratio"] > 1.3
    assert report["summary"]["window_execution_trace_high_failure_checksum"] == 3_419_781_716_949_080_192
    assert (
        report["summary"]["window_execution_trace_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["fabric_reduction_total_reduction_wavelets"] == 2_608_640
    assert report["summary"]["fabric_reduction_total_fabric_wavelets"] == 270_586_961
    assert report["summary"]["fabric_reduction_peak_color_fabric_cycles"] == 260_428
    assert (
        report["summary"]["fabric_reduction_residual_blocker"]
        == "vectorized_full_tensor_fabric_executor_missing"
    )
    assert report["summary"]["power_thermal_peak_package_power_w"] < 23_000.0
    assert report["summary"]["power_thermal_peak_power_density_w_per_mm2"] < 0.5
    assert 0.0 < report["summary"]["power_thermal_schedule_energy_j"] < 1.0
    assert report["summary"]["dft_cocotb_testcases"] >= 7
    assert report["summary"]["dft_strategy_required_sections"] == 7
    assert report["summary"]["dft_strategy_blocked_marker_count"] >= 1
    assert report["summary"]["model_load_stream_programmed_shard_records"] == 151367
    assert report["summary"]["model_load_stream_loader_word_transactions"] >= 1626983040
    assert report["summary"]["model_load_stream_reserve_policy_mismatch_bytes"] == 0
    assert (
        report["summary"]["model_load_stream_residual_blocker"]
        == "cycle_accurate_full_tensor_executor_missing"
    )
    assert report["summary"]["fabric_cocotb_testcases"] >= 23
    assert report["summary"]["credit_router_cocotb_testcases"] >= 8
    assert report["summary"]["mesh_fabric_cocotb_testcases"] >= 4
    assert report["summary"]["mesh_liveness_formal_check_count"] >= 8
    assert report["summary"]["mesh_liveness_residual_blocker"] == "full_formal_network_liveness_proof_missing"
    assert report["summary"]["graph_mapper_passing_check_count"] >= 8
