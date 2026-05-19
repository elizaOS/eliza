#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/spec-db/npu-2028-target.yaml"
DOC = ROOT / "docs/npu/2028-targets.md"
RTL = ROOT / "rtl/npu/e1_npu.sv"
COCOTB = ROOT / "verify/cocotb/test_e1_npu.py"
ARCH = ROOT / "docs/arch/npu.md"
MEMORY_MAP = ROOT / "docs/arch/memory-map.md"
CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
LOWERING = ROOT / "compiler/runtime/e1_npu_lowering.py"
BENCH_CONFIG = ROOT / "benchmarks/configs/benchmark_plan.json"
PROOF_TEMPLATE = ROOT / "docs/benchmarks/capabilities/e1_npu_nnapi.proof.template.json"
ANDROID_PROOF_TEMPLATE = (
    ROOT / "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json"
)
POWER_THERMAL_TEMPLATE = (
    ROOT / "docs/benchmarks/capabilities/e1_npu_power_thermal_manifest.template.json"
)
CAPABILITY_README = ROOT / "docs/benchmarks/capabilities/README.md"
REPORT_SCHEMA = ROOT / "docs/benchmarks/report-schema.yaml"


MIN_TARGETS = {
    "dense_int8_peak_tops_min": 160,
    "dense_int8_sustained_tops_min": 80,
    "sparse_int4_peak_tops_min": 512,
    "sparse_int4_sustained_tops_min": 200,
    "int2_bitnet_peak_tops_min": 900,
    "fp8_peak_tflops_min": 80,
    "sustained_perf_per_w_int8_tops_min": 18,
    "local_sram_mib_min": 64,
    "local_sram_bandwidth_tbps_min": 20,
    "shared_system_cache_mib_min": 32,
    "external_memory_bandwidth_gbps_min": 180,
    "command_queue_depth_min": 1024,
    "concurrent_contexts_min": 8,
}

RUNTIME_REGISTER_ALIASES = {
    "TRACE": "DEBUG",
}

REQUIRED_NPU_PROOF_FIELDS = {
    "capability.claim_level",
    "capability.precision",
    "capture.commands.adb_devices",
    "capture.commands.nnapi_accelerator_query",
    "capture.commands.benchmark_model_nnapi",
    "capture.commands.dma_trace",
    "dataflow.name",
    "dma.path",
    "dma.bytes_read",
    "dma.bytes_written",
    "dma.trace_bytes",
    "measurements.macs_per_inference",
    "measurements.npu_cycles",
    "measurements.npu_hz",
    "measurements.observed_tops",
    "measurements.tops_formula",
}

REQUIRED_NPU_PROOF_TRANSCRIPTS = {
    "adb_devices",
    "nnapi_accelerator_query",
    "benchmark_model_nnapi",
    "dma_trace",
}

SHA256_PLACEHOLDER = "64-character lowercase sha256"

REQUIRED_ANDROID_PROOF_STATUSES = {
    "aidl_or_hidl_hal_declared",
    "hal_binary_in_vendorimage",
    "vintf_check",
    "selinux_policy_build",
    "selinux_neverallow",
    "vts_e1_npu",
    "cts_nnapi_smoke",
    "nnapi_accelerator_query",
    "fail_closed_absent_device",
}

REQUIRED_ANDROID_PROOF_ARTIFACTS = {
    "vts_result",
    "cts_result",
    "selinux_policy_build_log",
    "selinux_neverallow_log",
    "vintf_check_log",
    "nnapi_query_log",
    "absent_device_probe_log",
}

REQUIRED_POWER_THERMAL_STATUSES = {
    "power_meter_calibrated",
    "thermal_sensor_calibrated",
    "npu_frequency_locked_or_recorded",
    "sustained_workload_trace",
    "throttle_state_recorded",
    "perf_per_watt_computed_from_trace",
}

REQUIRED_POWER_THERMAL_ARTIFACTS = {
    "power_trace",
    "thermal_trace",
    "frequency_trace",
    "calibration_record",
}


def h(value: str) -> int:
    return int(value.replace("_", ""), 16)


def parse_runtime_constants(text: str) -> dict[str, int]:
    constants: dict[str, int] = {}
    for name, value in re.findall(r"(?m)^\s{4}([A-Z][A-Z0-9_]*)\s*=\s*([0-9A-Fa-f_x]+)", text):
        constants[name] = int(value.replace("_", ""), 0)
    return constants


def dotted_present(data: dict, path: str) -> bool:
    value = data
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return False
        value = value[part]
    return value not in (None, "", [], {})


def find_benchmark(config: dict, name: str) -> dict | None:
    for bench in config.get("benchmarks", []):
        if bench.get("name") == name:
            return bench
    return None


def check_template_statuses(
    errors: list[str],
    name: str,
    template: dict,
    required_statuses: set[str],
    required_artifacts: set[str],
) -> None:
    if template.get("status") != "blocked":
        errors.append(f"{name} template status must remain blocked")
    boundary = template.get("claim_boundary", "")
    if "template_only" not in boundary or "evidence" not in boundary:
        errors.append(f"{name} template must state a template-only evidence boundary")

    statuses = template.get("required_statuses", {})
    if not isinstance(statuses, dict):
        errors.append(f"{name} template required_statuses must be an object")
        statuses = {}
    missing_statuses = sorted(required_statuses - set(statuses))
    if missing_statuses:
        errors.append(f"{name} template missing status gate(s): " + ", ".join(missing_statuses))
    for key, status in statuses.items():
        if status != "blocked":
            errors.append(f"{name} template status {key} must remain blocked")

    artifacts = template.get("artifacts", {})
    if not isinstance(artifacts, dict):
        errors.append(f"{name} template artifacts must be an object")
        artifacts = {}
    missing_artifacts = sorted(required_artifacts - set(artifacts))
    if missing_artifacts:
        errors.append(f"{name} template missing artifact gate(s): " + ", ".join(missing_artifacts))
    for key, artifact in artifacts.items():
        if not isinstance(artifact, dict):
            errors.append(f"{name} template artifact {key} must be an object")
            continue
        path = artifact.get("path")
        if not isinstance(path, str) or path.startswith("/") or not path:
            errors.append(f"{name} template artifact {key}.path must be repo-relative")
        sha = artifact.get("sha256")
        if not isinstance(sha, str) or SHA256_PLACEHOLDER not in sha:
            errors.append(f"{name} template artifact {key}.sha256 must require a lowercase sha256")


def check_runtime_contract(errors: list[str]) -> None:
    contract = json.loads(CONTRACT.read_text())
    regions = {region["name"]: region for region in contract["e1_chip"]["regions"]}
    npu = regions["npu"]
    npu_base = h(npu["base"])
    constants = parse_runtime_constants(RUNTIME.read_text())

    for reg in npu["registers"]:
        name = reg["name"]
        if name.startswith("SCRATCH"):
            continue
        runtime_name = RUNTIME_REGISTER_ALIASES.get(name, name)
        expected = npu_base + h(reg["offset"])
        actual = constants.get(runtime_name)
        if actual != expected:
            errors.append(
                f"compiler/runtime/e1_npu_runtime.py constant {runtime_name} "
                f"must be 0x{expected:08X}; got {actual!r}"
            )

    if constants.get("SCRATCH") != npu_base + 0x80:
        errors.append("compiler/runtime/e1_npu_runtime.py SCRATCH must point to NPU offset 0x80")
    if constants.get("SCRATCH_BYTES") != 64:
        errors.append("compiler/runtime/e1_npu_runtime.py SCRATCH_BYTES must remain 64")
    if constants.get("OP_DOT8_S4") != 7:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_DOT8_S4 = 7")
    if constants.get("OP_GEMM_S4") != 9:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_GEMM_S4 = 9")
    if constants.get("OP_RELU4_S8") != 10:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_RELU4_S8 = 10")
    if constants.get("OP_VRELU_S8") != 11:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_VRELU_S8 = 11")
    if constants.get("OP_SDOT4_S4_2_4") != 12:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_SDOT4_S4_2_4 = 12")
    if constants.get("OP_DOT16_S2") != 13:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_DOT16_S2 = 13")
    if constants.get("OP_DOT4_FP8_E4M3") != 14:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_DOT4_FP8_E4M3 = 14")
    if constants.get("OP_EXP2_NEG_Q0_8") != 15:
        errors.append("compiler/runtime/e1_npu_runtime.py must expose OP_EXP2_NEG_Q0_8 = 15")


def check_benchmark_evidence_gates(errors: list[str]) -> None:
    config = json.loads(BENCH_CONFIG.read_text())
    bench = find_benchmark(config, "tflite_e1_npu")
    if bench is None:
        errors.append("benchmark plan missing tflite_e1_npu")
        return
    artifacts = bench.get("capability_artifacts", [])
    if len(artifacts) != 1:
        errors.append("tflite_e1_npu must have exactly one capability_artifact")
        return
    proof = artifacts[0].get("proof", {})
    required_fields = set(proof.get("required_json_fields", []))
    missing_fields = sorted(REQUIRED_NPU_PROOF_FIELDS - required_fields)
    if missing_fields:
        errors.append(
            "tflite_e1_npu proof missing required_json_fields: " + ", ".join(missing_fields)
        )
    required_files = set(proof.get("required_files", []))
    missing_files = sorted(REQUIRED_NPU_PROOF_TRANSCRIPTS - required_files)
    if missing_files:
        errors.append(
            "tflite_e1_npu proof missing required transcript(s): " + ", ".join(missing_files)
        )
    markers = proof.get("required_transcript_markers", {})
    for transcript in REQUIRED_NPU_PROOF_TRANSCRIPTS:
        if transcript not in markers:
            errors.append(f"tflite_e1_npu proof missing markers for {transcript}")
    for token in ("bytes_read", "bytes_written", "e1-npu", "DMA"):
        if token not in markers.get("dma_trace", []):
            errors.append(f"tflite_e1_npu dma_trace markers must include {token!r}")

    template = json.loads(PROOF_TEMPLATE.read_text())
    for field in REQUIRED_NPU_PROOF_FIELDS:
        if not dotted_present(template, field):
            errors.append(f"proof template missing required field {field}")
    transcripts = set(template.get("transcripts", {}))
    missing_template_transcripts = sorted(REQUIRED_NPU_PROOF_TRANSCRIPTS - transcripts)
    if missing_template_transcripts:
        errors.append(
            "proof template missing transcript(s): " + ", ".join(missing_template_transcripts)
        )
    for transcript_name in REQUIRED_NPU_PROOF_TRANSCRIPTS & transcripts:
        entry = template.get("transcripts", {}).get(transcript_name)
        if not isinstance(entry, dict):
            errors.append(f"proof template transcript {transcript_name} must be an object")
            continue
        if not isinstance(entry.get("path"), str) or not entry["path"]:
            errors.append(f"proof template transcript {transcript_name}.path must be non-empty")
        if SHA256_PLACEHOLDER not in str(entry.get("sha256", "")):
            errors.append(
                f"proof template transcript {transcript_name}.sha256 must require lowercase sha256"
            )
        if not isinstance(entry.get("bytes"), int) or entry.get("bytes", 0) <= 0:
            errors.append(f"proof template transcript {transcript_name}.bytes must be positive")

    for token, path in (
        ("observed_tops", CAPABILITY_README),
        ("macs_per_inference", CAPABILITY_README),
        ("dma_trace", CAPABILITY_README),
        ("e1_npu_android_proof_manifest", CAPABILITY_README),
        ("e1_npu_power_thermal_manifest", CAPABILITY_README),
        ("MAC/cycle", REPORT_SCHEMA),
    ):
        if token not in path.read_text():
            errors.append(f"{path.relative_to(ROOT)} missing NPU evidence token {token!r}")

    android_template = json.loads(ANDROID_PROOF_TEMPLATE.read_text())
    if android_template.get("schema") != "eliza.e1_npu_android_proof_manifest.v1":
        errors.append("Android proof manifest template has unexpected schema")
    gate = android_template.get("proof_gate", {})
    if gate.get("android_boot_claim") != "none" or gate.get("compatibility_claim") != "none":
        errors.append("Android proof manifest template must not claim boot or compatibility")
    if "none_without_all_required_artifacts_passed" not in gate.get("nnapi_acceleration_claim", ""):
        errors.append("Android proof manifest template must gate NNAPI acceleration claims")
    check_template_statuses(
        errors,
        "Android proof manifest",
        android_template,
        REQUIRED_ANDROID_PROOF_STATUSES,
        REQUIRED_ANDROID_PROOF_ARTIFACTS,
    )

    power_template = json.loads(POWER_THERMAL_TEMPLATE.read_text())
    if power_template.get("schema") != "eliza.e1_npu_power_thermal_manifest.v1":
        errors.append("power/thermal manifest template has unexpected schema")
    check_template_statuses(
        errors,
        "power/thermal manifest",
        power_template,
        REQUIRED_POWER_THERMAL_STATUSES,
        REQUIRED_POWER_THERMAL_ARTIFACTS,
    )
    metrics = power_template.get("computed_metrics", {})
    for metric in (
        "sustained_int8_tops",
        "average_watts",
        "sustained_perf_per_w_int8_tops",
        "max_die_c",
        "throttle_state",
    ):
        if metric not in metrics:
            errors.append(f"power/thermal manifest missing computed metric {metric}")
    power_artifacts = power_template.get("artifacts", {})
    for trace_name in ("power_trace", "thermal_trace", "frequency_trace"):
        trace = power_artifacts.get(trace_name, {})
        if not isinstance(trace.get("required_columns"), list) or not trace["required_columns"]:
            errors.append(f"power/thermal manifest {trace_name} must define required_columns")
        if not isinstance(trace.get("min_samples"), int) or trace.get("min_samples", 0) <= 0:
            errors.append(f"power/thermal manifest {trace_name} must define positive min_samples")
    calibration = power_artifacts.get("calibration_record", {})
    if (
        not isinstance(calibration.get("required_fields"), list)
        or not calibration["required_fields"]
    ):
        errors.append("power/thermal manifest calibration_record must define required_fields")


REQUIRED_PRECISIONS = {
    "int8",
    "int4",
    "int2",
    "fp8",
    "bf16",
    "fp16",
    "int32_accumulate",
}

REQUIRED_SOURCES = {
    "https://www.qualcomm.com/smartphones/products/8-series/snapdragon-8-elite-gen-5",
    "https://www.mediatek.com/products/smartphones/mediatek-dimensity-9500",
    "https://semiconductor.samsung.com/processor/mobile-processor/exynos-2600/",
    "https://www.qualcomm.com/laptops/products/snapdragon-x-elite",
    "https://support.apple.com/en-us/125090",
}


def main() -> int:
    errors: list[str] = []

    for path in (
        SPEC,
        DOC,
        RTL,
        COCOTB,
        ARCH,
        MEMORY_MAP,
        CONTRACT,
        RUNTIME,
        LOWERING,
        BENCH_CONFIG,
        PROOF_TEMPLATE,
        ANDROID_PROOF_TEMPLATE,
        POWER_THERMAL_TEMPLATE,
        CAPABILITY_README,
        REPORT_SCHEMA,
    ):
        if not path.is_file():
            errors.append(f"missing required NPU target artifact: {path.relative_to(ROOT)}")
    if errors:
        return report(errors)

    spec = yaml.safe_load(SPEC.read_text())
    if spec.get("schema") != "eliza.npu_2028_target.v1":
        errors.append("unexpected NPU target schema")
    if spec.get("target_year") != 2028:
        errors.append("NPU target_year must remain 2028")
    if spec.get("target_class") != "performance_heavy_android_phone_ap":
        errors.append("NPU target_class must identify the performance-heavy Android phone AP goal")

    numeric = spec.get("numeric_targets", {})
    for key, minimum in MIN_TARGETS.items():
        value = numeric.get(key)
        if not isinstance(value, (int, float)) or value < minimum:
            errors.append(f"numeric target {key} must be >= {minimum}; got {value!r}")

    precisions = set(spec.get("precision_requirements", {}).get("required", []))
    missing_precision = sorted(REQUIRED_PRECISIONS - precisions)
    if missing_precision:
        errors.append("missing required precision target(s): " + ", ".join(missing_precision))

    source_urls = {entry.get("source_url") for entry in spec.get("source_anchors", [])}
    missing_sources = sorted(REQUIRED_SOURCES - source_urls)
    if missing_sources:
        errors.append("missing source anchor(s): " + ", ".join(missing_sources))

    classification = spec.get("current_repo_classification", {})
    if classification.get("level") != "L0_RTL_UNIT":
        errors.append(
            "current repo NPU classification must stay L0_RTL_UNIT until higher evidence exists"
        )
    gaps = set(classification.get("explicit_gaps", []))
    for gap in (
        "no_systolic_array",
        "no_production_compiler_backend",
        "no_NNAPI_delegate",
        "no_sustained_benchmark_evidence",
        "no_INT2_tensor_path",
        "no_FP8_tensor_path",
    ):
        if gap not in gaps:
            errors.append(f"current repo classification must explicitly retain gap: {gap}")

    rtl_text = RTL.read_text()
    cocotb_text = COCOTB.read_text()
    arch_text = ARCH.read_text()
    lowering_text = LOWERING.read_text()
    doc_text = DOC.read_text()
    memory_map_text = MEMORY_MAP.read_text()
    for token, path_text, path in (
        ("OP_DOT8_S4", rtl_text, RTL),
        ("OP_GEMM_S4", rtl_text, RTL),
        ("OP_RELU4_S8", rtl_text, RTL),
        ("OP_VRELU_S8", rtl_text, RTL),
        ("OP_SDOT4_S4_2_4", rtl_text, RTL),
        ("OP_DOT16_S2", rtl_text, RTL),
        ("OP_DOT4_FP8_E4M3", rtl_text, RTL),
        ("OP_EXP2_NEG_Q0_8", rtl_text, RTL),
        ("exp2_neg_q0_8", rtl_text, RTL),
        ("dot8_s4_sum", rtl_text, RTL),
        ("pack_s4", cocotb_text, COCOTB),
        ("pack_s2", cocotb_text, COCOTB),
        ("pack_fp8", cocotb_text, COCOTB),
        ("gemm_s4", cocotb_text, COCOTB),
        ("sdot4_s4_2_4", cocotb_text, COCOTB),
        ("dot16_s2", cocotb_text, COCOTB),
        ("dot4_fp8_e4m3", cocotb_text, COCOTB),
        ("vrelu_s8", cocotb_text, COCOTB),
        ("DOT8_S4", arch_text, ARCH),
        ("GEMM_S4", arch_text, ARCH),
        ("SDOT4_S4_2_4", arch_text, ARCH),
        ("DOT16_S2", arch_text, ARCH),
        ("DOT4_FP8_E4M3", arch_text, ARCH),
        ("lower_fp8_matmul_smoke", arch_text, ARCH),
        ("fp8_e4m3_matmul_dot4_smoke_only", arch_text, ARCH),
        ("EXP2_NEG_Q0_8", arch_text, ARCH),
        ("VRELU_S8", arch_text, ARCH),
        ("lower_matmul_smoke", lowering_text, LOWERING),
        ("lower_fp8_matmul_smoke", lowering_text, LOWERING),
        ("host_pads_k_to_dot4", lowering_text, LOWERING),
        ("eliza.fp8_matmul", lowering_text, LOWERING),
        ("_dispatch_tiled", lowering_text, LOWERING),
        ("tile_count", lowering_text, LOWERING),
        ("tiled_dispatch", lowering_text, LOWERING),
        ("split_k", lowering_text, LOWERING),
        ("host_accumulates_partials", lowering_text, LOWERING),
        ("stablehlo.dot_general", lowering_text, LOWERING),
        ("tflite.fully_connected", lowering_text, LOWERING),
        ("lower_conv2d_smoke", lowering_text, LOWERING),
        ("_conv2d_im2col_valid", lowering_text, LOWERING),
        ("host_materializes_im2col", lowering_text, LOWERING),
        ("stablehlo.convolution", lowering_text, LOWERING),
        ("tflite.conv_2d", lowering_text, LOWERING),
        ("lower_attention_qk_smoke", lowering_text, LOWERING),
        ("_validate_attention_qk_shape", lowering_text, LOWERING),
        ("host_transposes_keys", lowering_text, LOWERING),
        ("host_iterates_heads", lowering_text, LOWERING),
        ("eliza.attention_qk", lowering_text, LOWERING),
        ("lower_attention_softmax_smoke", lowering_text, LOWERING),
        ("_validate_attention_softmax_shape", lowering_text, LOWERING),
        ("runtime.exp2_neg_q0_8", lowering_text, LOWERING),
        ("host_divides_by_row_sum", lowering_text, LOWERING),
        ("eliza.attention_softmax", lowering_text, LOWERING),
        ("lower_attention_av_smoke", lowering_text, LOWERING),
        ("_validate_attention_av_shape", lowering_text, LOWERING),
        ("requires_prequantized_attention", lowering_text, LOWERING),
        ("eliza.attention_av", lowering_text, LOWERING),
        ("lower_kv_cache_update_smoke", lowering_text, LOWERING),
        ("_validate_kv_cache_update_shape", lowering_text, LOWERING),
        ("host_tracks_cache_lengths", lowering_text, LOWERING),
        ("eliza.kv_cache_update", lowering_text, LOWERING),
        ("lower_mlp_smoke", lowering_text, LOWERING),
        ("_validate_mlp_shape", lowering_text, LOWERING),
        ("host_requantizes_hidden", lowering_text, LOWERING),
        ("activation_opcode", lowering_text, LOWERING),
        ("eliza.transformer_mlp", lowering_text, LOWERING),
        ("lower_swiglu_smoke", lowering_text, LOWERING),
        ("_validate_swiglu_shape", lowering_text, LOWERING),
        ("eliza.swiglu", lowering_text, LOWERING),
        ("lower_bias_add_smoke", lowering_text, LOWERING),
        ("_validate_vector_range", lowering_text, LOWERING),
        ("host_broadcasts_bias", lowering_text, LOWERING),
        ("eliza.bias_add", lowering_text, LOWERING),
        ("lower_residual_add_smoke", lowering_text, LOWERING),
        ("_validate_same_shape", lowering_text, LOWERING),
        ("host_saturates_int8", lowering_text, LOWERING),
        ("scalar_add_count", lowering_text, LOWERING),
        ("eliza.residual_add", lowering_text, LOWERING),
        ("lower_transformer_block_smoke", lowering_text, LOWERING),
        ("_validate_transformer_block_shape", lowering_text, LOWERING),
        ("requires_prequantized_attention", lowering_text, LOWERING),
        ("eliza.transformer_block", lowering_text, LOWERING),
        ("lower_modern_decoder_block_smoke", lowering_text, LOWERING),
        ("_validate_modern_decoder_block_shape", lowering_text, LOWERING),
        ("computes_qk_scores", lowering_text, LOWERING),
        ("computes_attention_softmax", lowering_text, LOWERING),
        ("host_requantizes_qkv", lowering_text, LOWERING),
        ("host_requantizes_qk_scores", lowering_text, LOWERING),
        ("host_requantizes_attention_weights", lowering_text, LOWERING),
        ("eliza.decoder_block", lowering_text, LOWERING),
        ("lower_rope_smoke", lowering_text, LOWERING),
        ("_validate_rope_shape", lowering_text, LOWERING),
        ("eliza.rope", lowering_text, LOWERING),
        ("lower_rmsnorm_smoke", lowering_text, LOWERING),
        ("_validate_rmsnorm_shape", lowering_text, LOWERING),
        ("eliza.rms_norm", lowering_text, LOWERING),
        ("single_matmul_tiled_smoke_only", arch_text, ARCH),
        ("scalar-dot FP8 matmul orchestration", arch_text, ARCH),
        ("FP8_E4M3_scalar_dot_matmul_lowering_smoke", SPEC.read_text(), SPEC),
        ("single_conv2d_im2col_smoke_only", arch_text, ARCH),
        ("single-Conv2D im2col runtime orchestration", arch_text, ARCH),
        ("attention_qk_scores_smoke_only", arch_text, ARCH),
        ("attention-QK score runtime orchestration", arch_text, ARCH),
        ("attention_softmax_exp2_q0_8_smoke_only", arch_text, ARCH),
        ("attention-softmax scalar runtime orchestration", arch_text, ARCH),
        ("attention_softmax_exp2_q0_8_lowering_smoke", SPEC.read_text(), SPEC),
        ("attention_av_context_smoke_only", arch_text, ARCH),
        ("attention-AV context runtime orchestration", arch_text, ARCH),
        ("kv_cache_update_s8_scalar_append_smoke_only", arch_text, ARCH),
        ("append-only KV-cache runtime orchestration", arch_text, ARCH),
        ("KV_cache_s8_scalar_append_lowering_smoke", SPEC.read_text(), SPEC),
        ("transformer_mlp_relu_smoke_only", arch_text, ARCH),
        ("transformer-MLP ReLU runtime orchestration", arch_text, ARCH),
        ("swiglu_s8_scalar_gate_smoke_only", arch_text, ARCH),
        ("gated-MLP scalar runtime orchestration", arch_text, ARCH),
        ("SwiGLU_s8_scalar_gate_lowering_smoke", SPEC.read_text(), SPEC),
        ("bias_add_s8_scalar_broadcast_smoke_only", arch_text, ARCH),
        ("row-wise bias-add scalar broadcast orchestration", arch_text, ARCH),
        ("residual_add_s8_scalar_smoke_only", arch_text, ARCH),
        ("residual-add scalar runtime orchestration", arch_text, ARCH),
        ("single_head_transformer_block_smoke_only", arch_text, ARCH),
        ("single-head transformer-block runtime orchestration", arch_text, ARCH),
        ("modern_decoder_block_single_head_exp2_softmax_smoke_only", arch_text, ARCH),
        ("modern decoder-block runtime orchestration", arch_text, ARCH),
        ("modern_decoder_block_single_head_lowering_smoke", SPEC.read_text(), SPEC),
        ("rope_s8_scalar_smoke_only", arch_text, ARCH),
        ("RoPE scalar runtime orchestration", arch_text, ARCH),
        ("RoPE_s8_scalar_lowering_smoke", SPEC.read_text(), SPEC),
        ("rmsnorm_s8_scalar_smoke_only", arch_text, ARCH),
        ("RMSNorm scalar runtime orchestration", arch_text, ARCH),
        ("RMSNorm_s8_scalar_lowering_smoke", SPEC.read_text(), SPEC),
        ("split-K chunks", arch_text, ARCH),
        ("multi-tile runtime orchestration", arch_text, ARCH),
        ("PERF_UNSUPPORTED_OPS", memory_map_text, MEMORY_MAP),
        ("SCRATCH[0..15]", memory_map_text, MEMORY_MAP),
        ("Dense INT8 peak", doc_text, DOC),
        ("CPU fallback", doc_text, DOC),
        ("observed_tops", doc_text, DOC),
        ("macs_per_inference", doc_text, DOC),
        ("dma", doc_text.lower(), DOC),
    ):
        if token not in path_text:
            errors.append(f"{path.relative_to(ROOT)} missing required token {token!r}")

    check_runtime_contract(errors)
    check_benchmark_evidence_gates(errors)

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("NPU 2028 target check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
