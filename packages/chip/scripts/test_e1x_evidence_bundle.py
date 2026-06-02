from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_e1x_evidence_bundle_gate_is_actionable() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_e1x_evidence_bundle.py"],
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
    )
    report = json.loads((ROOT / "build/reports/e1x_evidence_bundle.json").read_text())
    flags = {key: value for key, value in report.items() if key.endswith("_claim_allowed")}
    assert flags
    assert all(value is False for value in flags.values())
    if result.returncode != 0:
        assert "BLOCKED: E1X evidence bundle" in result.stdout
        assert report["status"] == "BLOCKED"
        assert report["summary"]["failing_check_count"] > 0
        failing_checks = [check for check in report["checks"] if check["status"] != "pass"]
        assert len(failing_checks) == report["summary"]["failing_check_count"]
        if report["summary"]["missing_evidence_path_count"] > 0:
            assert report["blocked_reasons"]
            assert report["next_commands"]
            commands = {item["report"]: item["command"] for item in report["next_commands"]}
            assert commands["repair_rom_cocotb"] == "python3 scripts/check_e1x_repair_rom_cocotb.py"
        return
    assert "PASS: E1X evidence bundle" in result.stdout
    assert report["status"] == "PASS"
    assert report["summary"]["failing_check_count"] == 0
    assert report["summary"]["missing_evidence_path_count"] == 0
    assert report["summary"]["evidence_path_check_count"] == 62
    assert report["summary"]["freshness_check_count"] == 62
    assert report["summary"]["real_graph_model_required_vs_e1_sram"] > 100
    assert 0.0 < report["summary"]["real_graph_model_required_vs_e1x_sram"] < 1.0
    assert report["summary"]["e1_comparison_audit_sram_ratio"] == 128.25
    assert report["summary"]["e1_comparison_audit_model_required_vs_e1_sram"] > 100
    assert 0.86 < report["summary"]["e1_comparison_audit_model_required_vs_e1x_sram"] < 0.87
    assert report["summary"]["e1_comparison_audit_cycle_ratio"] > 1.3
    assert 0.75 < report["summary"]["e1_comparison_audit_decode_tps_ratio"] < 0.76
    assert report["summary"]["e1_comparison_audit_peak_power_density_w_per_mm2"] < 0.1
    assert (
        report["summary"]["e1_comparison_audit_tuple_sha256"]
        == "1ae2297132e3a59f826898b9e5dd85cbe82f25b16c438b127a60bb53075fa082"
    )
    assert (
        report["summary"]["e1_comparison_audit_residual_blocker"]
        == "comparison_is_architecture_model_not_silicon_benchmark"
    )
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
    assert report["summary"]["clustered_repair_cross_stripe_remapped_cores"] == 13_408
    assert report["summary"]["clustered_repair_cross_stripe_spare_margin"] == 512
    assert 0.96 < report["summary"]["clustered_repair_cross_stripe_spare_utilization"] < 0.97
    assert report["summary"]["clustered_repair_overload_case_count"] == 2
    assert (
        report["summary"]["clustered_repair_stress_case_sha256"]
        == "3fc4dfdc8cecb4a182cef27b4dd9b72f72982041494c1f5a87a571a86786cd06"
    )
    assert (
        report["summary"]["clustered_repair_residual_blocker"]
        == "clustered_stress_is_architecture_model_not_foundry_yield"
    )
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
    assert report["summary"]["execution_ladder_deterministic_window_rows"] == 2_608_640
    assert report["summary"]["execution_ladder_row_coverage_gain"] > 2300.0
    assert report["summary"]["execution_ladder_window_remaining_rows"] == 0
    assert report["summary"]["execution_ladder_routed_window_checksum"] == 4_718_384_912_712_357_942
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
    assert report["summary"]["full_output_checksum_manifest_rows"] == 2_608_640
    assert report["summary"]["full_output_checksum_manifest_macs"] == 13_015_864_320
    assert report["summary"]["full_output_checksum_manifest_probe_count"] == 849
    assert report["summary"]["full_output_checksum_manifest_checksum"] == 5_613_227_195_448_189_553
    assert (
        report["summary"]["full_output_checksum_manifest_layer_sha256"]
        == "58e4218553aae175a065025d4faa702f7da4e7721a798d88d6e5e7852ec154b5"
    )
    assert (
        report["summary"]["full_output_checksum_manifest_sampled_output_checksum"]
        == 14_414_877_542_268_347_137
    )
    assert (
        report["summary"]["full_output_checksum_manifest_routed_window_checksum"]
        == 4_718_384_912_712_357_942
    )
    assert (
        report["summary"]["full_output_checksum_manifest_normal_trace_checksum"]
        == 8_263_636_289_739_888_019
    )
    assert (
        report["summary"]["full_output_checksum_manifest_high_failure_trace_checksum"]
        == 3_419_781_716_949_080_192
    )
    assert (
        report["summary"]["full_output_checksum_manifest_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["expanded_real_weight_rows"] == 849
    assert report["summary"]["expanded_real_weight_macs"] == 4_147_443
    assert report["summary"]["expanded_real_weight_mac_gain"] > 158.0
    assert report["summary"]["expanded_real_weight_checksum"] == 11_081_612_788_320_878_322
    assert (
        report["summary"]["expanded_real_weight_result_sha256"]
        == "2abc4cb9334b939b0b230cca5d4ad605ea35aba13a5940948601e52dd25ed117"
    )
    assert (
        report["summary"]["expanded_real_weight_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["stratified_full_k_rows"] == 4_528
    assert report["summary"]["stratified_full_k_macs"] == 22_119_696
    assert report["summary"]["stratified_full_k_mac_gain"] == 5.333333333333333
    assert report["summary"]["stratified_full_k_checksum"] == 13_706_112_457_522_307_321
    assert (
        report["summary"]["stratified_full_k_result_sha256"]
        == "44653e48fe734bd4fd981b41484c6068ed7bdfeb67cee889e854d1649cf4ed91"
    )
    assert (
        report["summary"]["stratified_full_k_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["stratified_full_k_repair_rows"] == 4_528
    assert report["summary"]["stratified_full_k_repair_macs"] == 22_119_696
    assert report["summary"]["stratified_full_k_repair_touched_cores"] == 3_313
    assert (
        report["summary"]["stratified_full_k_repair_output_checksum"]
        == 1_101_709_542_541_624_471
    )
    assert (
        report["summary"]["stratified_full_k_repair_normal_route_checksum"]
        == 488_624_955_115_915_561
    )
    assert (
        report["summary"]["stratified_full_k_repair_high_failure_route_checksum"]
        == 11_749_464_960_701_465_404
    )
    assert report["summary"]["stratified_full_k_repair_high_failure_remapped_rows"] == 97
    assert (
        report["summary"]["stratified_full_k_repair_rows_sha256"]
        == "bde87dfb102b537486283d80fb831738b837fd56f332553f348beda75a132bb7"
    )
    assert (
        report["summary"]["stratified_full_k_repair_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["full_norm_real_weight_layers"] == 81
    assert report["summary"]["full_norm_real_weight_rows"] == 414_720
    assert report["summary"]["full_norm_real_weight_macs"] == 414_720
    assert 0.15 < report["summary"]["full_norm_real_weight_row_fraction"] < 0.17
    assert report["summary"]["full_norm_real_weight_checksum"] == 1_566_824_365_644_515_702
    assert (
        report["summary"]["full_norm_real_weight_result_sha256"]
        == "e83b0a710f70a39f82b10ff34593f0b0dc2ca95fd095e2b7ee76a5946bc9b488"
    )
    assert (
        report["summary"]["full_norm_real_weight_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["vocab_sampled_k_layers"] == 2
    assert report["summary"]["vocab_sampled_k_value"] == 128
    assert report["summary"]["vocab_sampled_k_rows"] == 64_000
    assert report["summary"]["vocab_sampled_k_macs"] == 8_192_000
    assert report["summary"]["vocab_sampled_k_represented_full_k_macs"] == 327_680_000
    assert 0.02 < report["summary"]["vocab_sampled_k_row_fraction"] < 0.03
    assert report["summary"]["vocab_sampled_k_checksum"] == 2_937_447_206_589_032_094
    assert (
        report["summary"]["vocab_sampled_k_result_sha256"]
        == "eefae909eba8d90f14e4b04daee33f994e791f8be981fd2dcfa1fe3fdc5bf084"
    )
    assert (
        report["summary"]["vocab_sampled_k_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["repaired_real_weight_rows"] == 2_608_640
    assert report["summary"]["repaired_real_weight_macs"] == 83_317_760
    assert report["summary"]["repaired_real_weight_touched_cores"] == 151_367
    assert report["summary"]["repaired_real_weight_output_checksum"] == 7_830_244_848_299_761_912
    assert (
        report["summary"]["repaired_real_weight_normal_route_checksum"] == 3_248_974_677_569_690_675
    )
    assert (
        report["summary"]["repaired_real_weight_high_failure_route_checksum"]
        == 36_983_080_900_949_662
    )
    assert report["summary"]["repaired_real_weight_high_failure_remapped_rows"] == 54_211
    assert report["summary"]["repaired_real_weight_remap_ratio"] > 13.0
    assert (
        report["summary"]["repaired_real_weight_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["real_weight_ladder_components"] == 7
    assert report["summary"]["real_weight_ladder_layers"] == 283
    assert report["summary"]["real_weight_ladder_rows"] == 2_608_640
    assert report["summary"]["real_weight_ladder_row_fraction"] == 1.0
    assert report["summary"]["real_weight_ladder_executed_macs"] == 83_317_760
    assert report["summary"]["real_weight_ladder_represented_full_k_macs"] == 13_015_864_320
    assert 0.006 < report["summary"]["real_weight_ladder_executed_mac_fraction"] < 0.007
    assert report["summary"]["real_weight_ladder_represented_full_k_fraction"] == 1.0
    assert report["summary"]["real_weight_ladder_missing_full_k_macs"] == 12_932_546_560
    assert (
        report["summary"]["real_weight_ladder_components_sha256"]
        == "e0b869c2f4976674d9bd0570f3b7b2be879cdc91169d524002bd46df44e73938"
    )
    assert (
        report["summary"]["real_weight_ladder_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["attn_out_sampled_k_layers"] == 40
    assert report["summary"]["attn_out_sampled_k_value"] == 64
    assert report["summary"]["attn_out_sampled_k_rows"] == 204_800
    assert report["summary"]["attn_out_sampled_k_macs"] == 13_107_200
    assert report["summary"]["attn_out_sampled_k_represented_full_k_macs"] == 1_048_576_000
    assert 0.07 < report["summary"]["attn_out_sampled_k_row_fraction"] < 0.09
    assert report["summary"]["attn_out_sampled_k_checksum"] == 6_608_415_098_217_527_669
    assert (
        report["summary"]["attn_out_sampled_k_result_sha256"]
        == "eb125c171f915724c435bb531c3e46399daeef673edb4e2c571b93b1fd0487aa"
    )
    assert (
        report["summary"]["attn_out_sampled_k_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["attn_qkv_sampled_k_layers"] == 40
    assert report["summary"]["attn_qkv_sampled_k_value"] == 32
    assert report["summary"]["attn_qkv_sampled_k_rows"] == 614_400
    assert report["summary"]["attn_qkv_sampled_k_macs"] == 19_660_800
    assert report["summary"]["attn_qkv_sampled_k_represented_full_k_macs"] == 3_145_728_000
    assert 0.23 < report["summary"]["attn_qkv_sampled_k_row_fraction"] < 0.24
    assert report["summary"]["attn_qkv_sampled_k_checksum"] == 16_749_998_878_173_451_739
    assert (
        report["summary"]["attn_qkv_sampled_k_result_sha256"]
        == "7774d62c42840b0bf66082fa7e072df8f4ee9067f659451e7195488f57f74940"
    )
    assert (
        report["summary"]["attn_qkv_sampled_k_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["mlp_gate_sampled_k_layers"] == 40
    assert report["summary"]["mlp_gate_sampled_k_value"] == 32
    assert report["summary"]["mlp_gate_sampled_k_rows"] == 552_960
    assert report["summary"]["mlp_gate_sampled_k_macs"] == 17_694_720
    assert report["summary"]["mlp_gate_sampled_k_represented_full_k_macs"] == 2_831_155_200
    assert 0.21 < report["summary"]["mlp_gate_sampled_k_row_fraction"] < 0.22
    assert report["summary"]["mlp_gate_sampled_k_checksum"] == 644_049_328_919_108_482
    assert (
        report["summary"]["mlp_gate_sampled_k_result_sha256"]
        == "042143af521f945995b1862636d90a6668be8a9fc68d776ff800251ffc4e3fc4"
    )
    assert (
        report["summary"]["mlp_gate_sampled_k_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["mlp_up_sampled_k_layers"] == 40
    assert report["summary"]["mlp_up_sampled_k_value"] == 32
    assert report["summary"]["mlp_up_sampled_k_rows"] == 552_960
    assert report["summary"]["mlp_up_sampled_k_macs"] == 17_694_720
    assert report["summary"]["mlp_up_sampled_k_represented_full_k_macs"] == 2_831_155_200
    assert 0.21 < report["summary"]["mlp_up_sampled_k_row_fraction"] < 0.22
    assert report["summary"]["mlp_up_sampled_k_checksum"] == 5_263_540_896_081_439_006
    assert (
        report["summary"]["mlp_up_sampled_k_result_sha256"]
        == "9886ad2306ea36a3d73135fea7ea73fad37f07ec6c891b5d5b10a94d4fac74c2"
    )
    assert (
        report["summary"]["mlp_up_sampled_k_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["mlp_down_sampled_k_layers"] == 40
    assert report["summary"]["mlp_down_sampled_k_value"] == 32
    assert report["summary"]["mlp_down_sampled_k_rows"] == 204_800
    assert report["summary"]["mlp_down_sampled_k_macs"] == 6_553_600
    assert report["summary"]["mlp_down_sampled_k_represented_full_k_macs"] == 2_831_155_200
    assert 0.07 < report["summary"]["mlp_down_sampled_k_row_fraction"] < 0.08
    assert report["summary"]["mlp_down_sampled_k_checksum"] == 3_360_713_502_265_478_628
    assert (
        report["summary"]["mlp_down_sampled_k_result_sha256"]
        == "a3d640fdc0ae8a55cacdaa0e61bfbfdade39cf9b30d14c291656d579a6b26495"
    )
    assert (
        report["summary"]["mlp_down_sampled_k_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
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
    assert (
        report["summary"]["per_layer_vector_codegen_total_instruction_estimate"] == 94_393_889_280
    )
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
    assert report["summary"]["vector_kernel_window_executor_row_count"] == 2_608_640
    assert report["summary"]["vector_kernel_window_executor_vector_word_ops"] == 9_190_400
    assert report["summary"]["vector_kernel_window_executor_lane_macs"] == 70_620_160
    assert report["summary"]["vector_kernel_window_executor_row_coverage_fraction"] == 1.0
    assert report["summary"]["vector_kernel_window_executor_checksum"] == 4_033_574_925_821_332_798
    assert (
        report["summary"]["vector_kernel_window_executor_residual_blocker"]
        == "full_output_vector_kernel_execution_missing"
    )
    assert report["summary"]["vector_window_fabric_checksum_row_count"] == 2_608_640
    assert report["summary"]["vector_window_fabric_checksum_vector_word_ops"] == 9_190_400
    assert report["summary"]["vector_window_fabric_checksum_merge_cycles"] == 2_608_923
    assert report["summary"]["vector_window_fabric_checksum_routing_colors"] == 24
    assert report["summary"]["vector_window_fabric_checksum"] == 4_718_384_912_712_357_942
    assert (
        report["summary"]["vector_window_fabric_checksum_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_shard_linkage_touched_shards"] == 151_367
    assert report["summary"]["window_shard_linkage_touched_loader_words"] == 1_627_034_880
    assert report["summary"]["window_shard_linkage_touched_bytes"] == 6_508_139_520
    assert (
        report["summary"]["window_shard_linkage_record_sha256"]
        == "2d65679ad9dfcfe90582587e7ed2912d0e72d1d09c0d795087cb0e4ccb9e1f68"
    )
    assert (
        report["summary"]["window_shard_linkage_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_repair_linkage_touched_cores"] == 151_367
    assert report["summary"]["window_repair_linkage_normal_remapped"] == 279
    assert report["summary"]["window_repair_linkage_high_failure_remapped"] == 3_012
    assert report["summary"]["window_repair_linkage_high_vs_normal_ratio"] > 10.0
    assert (
        report["summary"]["window_repair_linkage_core_sha256"]
        == "fc1928d24739ad1ee15f2c5d866850aa12cec35555fcc11109917898e42b0e6b"
    )
    assert (
        report["summary"]["window_repair_linkage_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_route_validation_neighbor_edges"] == 301_949
    assert report["summary"]["window_route_validation_normal_extra_hops"] == 167_619
    assert report["summary"]["window_route_validation_high_failure_extra_hops"] == 1_809_664
    assert (
        report["summary"]["window_route_validation_high_failure_route_checksum"]
        == 8_141_847_437_961_269_241
    )
    assert (
        report["summary"]["window_route_validation_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_repair_rom_linkage_normal_remap_words"] == 279
    assert report["summary"]["window_repair_rom_linkage_high_failure_remap_words"] == 3_012
    assert (
        report["summary"]["window_repair_rom_linkage_high_failure_remap_sha256"]
        == "ef3422c00ace7d7d61ff761036c028ef0d72b53e8f909238373b6ebfcc432fe8"
    )
    assert report["summary"]["window_repair_rom_linkage_high_failure_rom_words"] == 3_582
    assert (
        report["summary"]["window_repair_rom_linkage_residual_blocker"]
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    assert report["summary"]["window_execution_trace_normal_cycles"] == 47_501_642_583
    assert report["summary"]["window_execution_trace_high_failure_cycles"] == 63_132_355_414
    assert report["summary"]["window_execution_trace_cycle_ratio"] > 1.3
    assert (
        report["summary"]["window_execution_trace_high_failure_checksum"]
        == 3_419_781_716_949_080_192
    )
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
    assert report["summary"]["model_shard_sample_executor_words"] == 9_282
    assert report["summary"]["model_shard_sample_executor_shard_words"] == 9_281
    assert report["summary"]["model_shard_sample_executor_lane_macs"] == 74_256
    assert report["summary"]["model_shard_sample_executor_checksum"] == 6_658_997_565_743_609_885
    assert (
        report["summary"]["model_shard_sample_executor_payload_sha256"]
        == "f8fde8061d500fbef0cb3c6a4225e42abb11aba38da814b1c00a830c7dbf6910"
    )
    assert 0.0 < report["summary"]["model_shard_sample_executor_coverage_fraction"] < 0.00001
    assert (
        report["summary"]["model_shard_sample_executor_residual_blocker"]
        == "full_quantized_weight_payload_executor_missing"
    )
    assert report["summary"]["layer_shard_sweep_executor_layers"] == 283
    assert report["summary"]["layer_shard_sweep_executor_kinds"] == 8
    assert report["summary"]["layer_shard_sweep_executor_records"] == 687
    assert report["summary"]["layer_shard_sweep_executor_words"] == 5_064_960
    assert report["summary"]["layer_shard_sweep_executor_lane_macs"] == 40_519_680
    assert report["summary"]["layer_shard_sweep_executor_checksum"] == 7_249_510_583_533_139_077
    assert 0.001 < report["summary"]["layer_shard_sweep_executor_coverage_fraction"] < 0.01
    assert (
        report["summary"]["layer_shard_sweep_executor_result_sha256"]
        == "a411c16bcfd5388c12fcd4b68f962bf4f5560bc1ee5189a8c39eb1d9e6c4f5aa"
    )
    assert (
        report["summary"]["layer_shard_sweep_executor_residual_blocker"]
        == "full_quantized_weight_payload_executor_missing"
    )
    assert report["summary"]["full_payload_manifest_layers"] == 283
    assert report["summary"]["full_payload_manifest_shard_records"] == 151_367
    assert report["summary"]["full_payload_manifest_loader_words"] == 1_627_034_880
    assert report["summary"]["full_payload_manifest_stream_bytes"] == 6_508_139_520
    assert report["summary"]["full_payload_manifest_probe_words"] == 454_101
    assert 0.0 < report["summary"]["full_payload_manifest_probe_fraction"] < 0.001
    assert report["summary"]["full_payload_manifest_checksum"] == 15_384_439_414_980_776_514
    assert (
        report["summary"]["full_payload_manifest_layer_sha256"]
        == "be765abe713d8def565e0b95518738c2666c1b5a2707d5b11dd53ac64e5f9763"
    )
    assert (
        report["summary"]["full_payload_manifest_record_sha256"]
        == "77d20cb872cd4906fc1ff344c77fb0f40d1c9397fbb9142f9daf2d00e7a52dd7"
    )
    assert (
        report["summary"]["full_payload_manifest_residual_blocker"]
        == "full_quantized_weight_payload_executor_missing"
    )
    assert report["summary"]["full_payload_repair_mapping_shards"] == 151_367
    assert report["summary"]["full_payload_repair_mapping_loader_words"] == 1_627_034_880
    assert report["summary"]["full_payload_repair_mapping_normal_remaps"] == 279
    assert report["summary"]["full_payload_repair_mapping_high_failure_remaps"] == 3_012
    assert report["summary"]["full_payload_repair_mapping_remap_ratio"] > 10.0
    assert (
        report["summary"]["full_payload_repair_mapping_normal_checksum"]
        == 10_456_726_157_466_213_831
    )
    assert (
        report["summary"]["full_payload_repair_mapping_high_failure_checksum"]
        == 10_771_944_608_718_332_026
    )
    assert (
        report["summary"]["full_payload_repair_mapping_combined_checksum"]
        == 3_128_472_446_271_365_767
    )
    assert (
        report["summary"]["full_payload_repair_mapping_case_sha256"]
        == "41adf4631147bc4644543caa155e21e031cb721b39a7bd630fbf6e9a929c40ec"
    )
    assert (
        report["summary"]["full_payload_repair_mapping_residual_blocker"]
        == "full_quantized_weight_payload_executor_missing"
    )
    assert report["summary"]["full_payload_repair_rom_normal_remap_words"] == 279
    assert report["summary"]["full_payload_repair_rom_high_failure_remap_words"] == 3_012
    assert (
        report["summary"]["full_payload_repair_rom_normal_sha256"]
        == "b941ac08aa1daaa9037e57443bf1700625fb598d79f04de20240d60ea9ba6ddd"
    )
    assert (
        report["summary"]["full_payload_repair_rom_high_failure_sha256"]
        == "ef3422c00ace7d7d61ff761036c028ef0d72b53e8f909238373b6ebfcc432fe8"
    )
    assert (
        report["summary"]["full_payload_repair_rom_normal_program_checksum"]
        == 7_749_419_754_594_532_338
    )
    assert (
        report["summary"]["full_payload_repair_rom_high_failure_program_checksum"]
        == 6_557_843_250_509_347_312
    )
    assert (
        report["summary"]["full_payload_repair_rom_combined_checksum"] == 14_301_024_026_748_848_141
    )
    assert (
        report["summary"]["full_payload_repair_rom_case_sha256"]
        == "b3b796f0aaf4d36a02eb25a248fd20df1ff06afeb4af988c982cbd4b41b5f2d9"
    )
    assert (
        report["summary"]["full_payload_repair_rom_residual_blocker"]
        == "silicon_fuse_burning_and_foundry_otp_macro_missing"
    )
    assert report["summary"]["full_payload_repaired_run_normal_cycles"] == 47_501_642_583
    assert report["summary"]["full_payload_repaired_run_high_failure_cycles"] == 63_132_355_414
    assert report["summary"]["full_payload_repaired_run_cycle_ratio"] > 1.3
    assert 0.7 < report["summary"]["full_payload_repaired_run_decode_tps_ratio"] < 0.8
    assert (
        report["summary"]["full_payload_repaired_run_normal_output_checksum"]
        == 8_263_636_289_739_888_019
    )
    assert (
        report["summary"]["full_payload_repaired_run_high_failure_output_checksum"]
        == 3_419_781_716_949_080_192
    )
    assert (
        report["summary"]["full_payload_repaired_run_combined_checksum"]
        == 3_914_641_677_513_091_882
    )
    assert (
        report["summary"]["full_payload_repaired_run_normal_trace_sha256"]
        == "5fe31007632635c42efea77ca1f2ac2911d2584815ac74f5d2f7a6facf902af7"
    )
    assert (
        report["summary"]["full_payload_repaired_run_high_failure_trace_sha256"]
        == "0df46c3be0753a814b1f99a72f82f3c19cd4e67b1cbffede00f9c757106d7eb3"
    )
    assert (
        report["summary"]["full_payload_repaired_run_residual_blocker"]
        == "full_output_real_weight_checksum_missing"
    )
    assert report["summary"]["fabric_cocotb_testcases"] >= 23
    assert report["summary"]["credit_router_cocotb_testcases"] >= 8
    assert report["summary"]["mesh_fabric_cocotb_testcases"] >= 4
    assert report["summary"]["mesh_liveness_formal_check_count"] >= 8
    assert (
        report["summary"]["mesh_liveness_residual_blocker"]
        == "full_formal_network_liveness_proof_missing"
    )
    assert report["summary"]["graph_mapper_passing_check_count"] >= 8
