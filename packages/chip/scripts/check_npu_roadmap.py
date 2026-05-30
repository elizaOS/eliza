#!/usr/bin/env python3
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
ROADMAP = ROOT / "docs/spec-db/npu-2028-roadmap.yaml"
TARGET = ROOT / "docs/spec-db/npu-2028-target.yaml"
RUNTIME_CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"

EXPECTED_PHASES = [
    "L0_MMIO_PROTOTYPE",
    "L1_DESCRIPTOR_DMA_RUNTIME",
    "L2_SINGLE_TILE_ACCELERATOR",
    "L3_TILED_MULTI_CONTEXT_NPU",
    "L4_ANDROID_HAL_DELEGATE",
    "L5_2028_PHONE_CLASS_EVIDENCE",
]

REQUIRED_L0_GATES = {
    "runtime_contract_checker",
    "npu_2028_target_checker",
    "verilator_gemm_smoke",
    "scratchpad_bytes",
    "gemm_s8_max_m",
    "gemm_s8_max_n",
    "gemm_s8_max_k",
}

REQUIRED_LATER_GATES = {
    "L1_DESCRIPTOR_DMA_RUNTIME": {
        "command_queue_depth_min",
        "descriptor_submission_smoke",
        "descriptor_timeout_error_status",
        "dma_tensor_streaming_trace",
        "dma_trace_bytes_read",
        "dma_trace_bytes_written",
        "perf_counter_dma_bytes_read",
        "perf_counter_dma_bytes_written",
        "unsupported_ops_for_descriptor_smoke",
    },
    "L2_SINGLE_TILE_ACCELERATOR": {
        "int8_mac_units_per_tile_min",
        "local_sram_kib_min",
        "precision_matrix_complete",
        "observed_macs_per_cycle_min",
        "perf_counter_cycles_macs_ops_errors",
        "cpu_fallback_percent",
    },
    "L3_TILED_MULTI_CONTEXT_NPU": {
        "tile_count_min",
        "command_queue_depth_min",
        "concurrent_contexts_min",
        "local_sram_mib_min",
        "per_context_fault_isolation",
        "queue_fairness_and_qos_trace",
        "modeled_context_queue_fairness_preflight",
    },
    "L4_ANDROID_HAL_DELEGATE": {
        "android_proof_manifest_template",
        "vts_result",
        "cts_result",
        "aidl_hal_service_declared",
        "selinux_fail_closed_policy",
        "nnapi_accelerator_query_e1_npu",
        "unsupported_operator_percent_max",
        "cpu_fallback_percent_max",
    },
    "L5_2028_PHONE_CLASS_EVIDENCE": {
        "dense_int8_peak_tops_min",
        "dense_int8_sustained_tops_min",
        "sparse_int4_peak_tops_min",
        "sustained_perf_per_w_int8_tops_min",
        "external_memory_bandwidth_gbps_min",
        "benchmark_model_hashes_present",
        "benchmark_transcript_hashes_present",
        "power_thermal_manifest_template",
        "power_thermal_trace_present",
    },
}

REQUIRED_CAPABILITY_TOKENS = {
    "L1_DESCRIPTOR_DMA_RUNTIME": {
        "descriptor_valid_ready_completion_semantics",
        "descriptor_timeout_and_fault_reporting",
        "tensor_dma_read_stream",
        "tensor_dma_write_stream",
        "dma_read_write_byte_counters",
    },
    "L2_SINGLE_TILE_ACCELERATOR": {
        "precision_matrix_int8_int4_int2_fp8_bf16_fp16_status",
        "runtime_perf_report_for_tile",
    },
    "L4_ANDROID_HAL_DELEGATE": {
        "AIDL_HAL",
        "SELinux_fail_closed_policy",
        "unsupported_operator_report",
        "CPU_fallback_report",
        "CTS_and_VTS_artifacts",
    },
    "L5_2028_PHONE_CLASS_EVIDENCE": {
        "power_trace",
        "thermal_trace",
        "MLPerf_Mobile_or_equivalent_closed_loop",
    },
}

FALSE_ROADMAP_CLAIM_FLAGS = {
    "android_boot_claim_allowed": False,
    "android_nnapi_claim_allowed": False,
    "phone_class_accelerator_claim_allowed": False,
    "release_claim_allowed": False,
    "sustained_performance_claim_allowed": False,
    "silicon_claim_allowed": False,
}


def main() -> int:
    errors: list[str] = []
    for path in (ROADMAP, TARGET, RUNTIME_CONTRACT):
        if not path.is_file():
            errors.append(f"missing required roadmap artifact: {path.relative_to(ROOT)}")
    if errors:
        return report(errors)

    roadmap = yaml.safe_load(ROADMAP.read_text())
    target = yaml.safe_load(TARGET.read_text())

    if roadmap.get("schema") != "eliza.npu_2028_roadmap.v1":
        errors.append("unexpected NPU roadmap schema")
    if roadmap.get("target_spec") != "docs/spec-db/npu-2028-target.yaml":
        errors.append("roadmap must point at docs/spec-db/npu-2028-target.yaml")
    if roadmap.get("runtime_contract") != "docs/spec-db/e1-npu-runtime-contract.json":
        errors.append("roadmap must point at the e1 NPU runtime contract")
    if "no_android_boot_or_phone_class_accelerator_claim" not in roadmap.get("claim_boundary", ""):
        errors.append(
            "roadmap claim_boundary must fail closed for Android boot and phone-class claims"
        )
    for flag, expected in FALSE_ROADMAP_CLAIM_FLAGS.items():
        if roadmap.get(flag) is not expected:
            errors.append(f"roadmap must keep {flag}=false")
    if roadmap.get("current_phase") != "L0_MMIO_PROTOTYPE":
        errors.append("current_phase must remain L0_MMIO_PROTOTYPE until higher evidence exists")
    if roadmap.get("phase_order") != EXPECTED_PHASES:
        errors.append("phase_order must preserve the measured path from L0 through L5")

    phases = roadmap.get("phases", [])
    phase_by_id = {phase.get("id"): phase for phase in phases}
    if list(phase_by_id) != EXPECTED_PHASES:
        errors.append("phases must be present once and in phase_order")

    for phase_id in EXPECTED_PHASES:
        phase = phase_by_id.get(phase_id)
        if not isinstance(phase, dict):
            continue
        status = phase.get("status")
        if phase_id == "L0_MMIO_PROTOTYPE":
            if status != "current_limited":
                errors.append("L0 status must be current_limited, not complete")
        elif status != "planned_blocked":
            errors.append(f"{phase_id} must remain planned_blocked until evidence artifacts exist")

        gates = phase.get("measurable_gates", [])
        if not gates:
            errors.append(f"{phase_id} must define measurable_gates")
            continue
        for gate in gates:
            for key in ("metric", "required", "evidence"):
                if key not in gate or gate[key] in (None, "", []):
                    errors.append(f"{phase_id} gate missing {key}")
            evidence = gate.get("evidence", "")
            if isinstance(evidence, str) and evidence.startswith("/"):
                errors.append(f"{phase_id} evidence path must be repo-relative: {evidence}")

        gate_metrics = {gate.get("metric") for gate in gates}
        if phase_id == "L0_MMIO_PROTOTYPE":
            missing = sorted(REQUIRED_L0_GATES - gate_metrics)
            if missing:
                errors.append("L0 roadmap missing gate(s): " + ", ".join(missing))
        else:
            missing = sorted(REQUIRED_LATER_GATES[phase_id] - gate_metrics)
            if missing:
                errors.append(f"{phase_id} roadmap missing gate(s): " + ", ".join(missing))

        blocked_claims = set(phase.get("blocked_claims", []))
        if phase_id != "L5_2028_PHONE_CLASS_EVIDENCE" and not blocked_claims:
            errors.append(f"{phase_id} must list blocked claims")

        capabilities = set(phase.get("required_capabilities", []))
        missing_capabilities = sorted(
            REQUIRED_CAPABILITY_TOKENS.get(phase_id, set()) - capabilities
        )
        if missing_capabilities:
            errors.append(
                f"{phase_id} missing required capability token(s): "
                + ", ".join(missing_capabilities)
            )

    numeric = target.get("numeric_targets", {})
    l5 = phase_by_id.get("L5_2028_PHONE_CLASS_EVIDENCE", {})
    l5_gates = {gate.get("metric"): gate for gate in l5.get("measurable_gates", [])}
    for metric in (
        "dense_int8_peak_tops_min",
        "dense_int8_sustained_tops_min",
        "sparse_int4_peak_tops_min",
        "sustained_perf_per_w_int8_tops_min",
        "external_memory_bandwidth_gbps_min",
    ):
        if l5_gates.get(metric, {}).get("required") != numeric.get(metric):
            errors.append(f"L5 roadmap gate {metric} must match NPU 2028 target spec")

    l3 = phase_by_id.get("L3_TILED_MULTI_CONTEXT_NPU", {})
    l3_gates = {gate.get("metric"): gate for gate in l3.get("measurable_gates", [])}
    tiles = target.get("microarchitecture_targets", {}).get("tiles", {})
    if l3_gates.get("tile_count_min", {}).get("required") != tiles.get("count_range", [None])[0]:
        errors.append("L3 tile_count_min must match the lower bound of target tile count_range")
    for metric in ("command_queue_depth_min", "concurrent_contexts_min", "local_sram_mib_min"):
        if l3_gates.get(metric, {}).get("required") != numeric.get(metric):
            errors.append(f"L3 roadmap gate {metric} must match NPU 2028 target spec")

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("NPU 2028 roadmap check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
