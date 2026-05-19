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
STABLEHLO = ROOT / "compiler/runtime/e1_npu_stablehlo.py"
RUNTIME_TEST = ROOT / "compiler/runtime/test_e1_npu_runtime.py"
COMMAND_BUFFER_TEST = ROOT / "compiler/runtime/test_e1_npu_runtime_commandbuffer.py"
STABLEHLO_TEST = ROOT / "compiler/runtime/test_e1_npu_stablehlo.py"
PARTITIONER = ROOT / "compiler/runtime/e1_npu_partitioner.py"
PARTITIONER_TEST = ROOT / "compiler/runtime/test_e1_partitioner.py"
EXECUTORCH_DELEGATE = ROOT / "compiler/runtime/e1_executorch_delegate.py"
EXECUTORCH_DELEGATE_TEST = ROOT / "compiler/runtime/test_e1_executorch_delegate.py"
LITERT_DELEGATE = ROOT / "compiler/runtime/e1_litert_delegate.py"
LITERT_DELEGATE_TEST = ROOT / "compiler/runtime/test_e1_litert_delegate.py"
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
    for name, value in re.findall(
        r"(?m)^\s{4}([A-Z][A-Z0-9_]*)\s*=\s*(0x[0-9A-Fa-f_]+|\d[\d_]*)", text
    ):
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
        STABLEHLO,
        RUNTIME_TEST,
        COMMAND_BUFFER_TEST,
        STABLEHLO_TEST,
        PARTITIONER,
        PARTITIONER_TEST,
        EXECUTORCH_DELEGATE,
        EXECUTORCH_DELEGATE_TEST,
        LITERT_DELEGATE,
        LITERT_DELEGATE_TEST,
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
    runtime_text = RUNTIME.read_text()
    lowering_text = LOWERING.read_text()
    runtime_test_text = RUNTIME_TEST.read_text()
    command_buffer_test_text = COMMAND_BUFFER_TEST.read_text()
    stablehlo_text = STABLEHLO.read_text()
    stablehlo_test_text = STABLEHLO_TEST.read_text()
    partitioner_text = PARTITIONER.read_text()
    partitioner_test_text = PARTITIONER_TEST.read_text()
    executorch_text = EXECUTORCH_DELEGATE.read_text()
    executorch_test_text = EXECUTORCH_DELEGATE_TEST.read_text()
    litert_text = LITERT_DELEGATE.read_text()
    litert_test_text = LITERT_DELEGATE_TEST.read_text()
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
        ("lower_sparse_int4_matmul_smoke", arch_text, ARCH),
        ("sparse_int4_2_4_matmul_sdot4_smoke_only", arch_text, ARCH),
        ("lower_group_scaled_int4_matmul_smoke", arch_text, ARCH),
        ("group_scaled_int4_matmul_q8_8_scalar_smoke_only", arch_text, ARCH),
        ("group-scaled INT4 scalar runtime orchestration", arch_text, ARCH),
        ("DOT16_S2", arch_text, ARCH),
        ("lower_int2_matmul_smoke", arch_text, ARCH),
        ("int2_matmul_dot16_smoke_only", arch_text, ARCH),
        ("DOT4_FP8_E4M3", arch_text, ARCH),
        ("lower_fp8_matmul_smoke", arch_text, ARCH),
        ("fp8_e4m3_matmul_dot4_smoke_only", arch_text, ARCH),
        ("lower_fp16_matmul_smoke", arch_text, ARCH),
        ("lower_bf16_matmul_smoke", arch_text, ARCH),
        ("fp16_matmul_q8_8_scalar_smoke_only", arch_text, ARCH),
        ("bf16_matmul_q8_8_scalar_smoke_only", arch_text, ARCH),
        ("EXP2_NEG_Q0_8", arch_text, ARCH),
        ("VRELU_S8", arch_text, ARCH),
        ("lower_matmul_smoke", lowering_text, LOWERING),
        ("lower_sparse_int4_matmul_smoke", lowering_text, LOWERING),
        ("host_uses_2_4_metadata", lowering_text, LOWERING),
        ("eliza.sparse_2_4_matmul", lowering_text, LOWERING),
        ("lower_group_scaled_int4_matmul_smoke", lowering_text, LOWERING),
        ("_validate_group_scaled_int4_matmul_shape", lowering_text, LOWERING),
        ("host_applies_group_scales", lowering_text, LOWERING),
        ("host_uses_q8_8_scales", lowering_text, LOWERING),
        ("scales_q8_8", lowering_text, LOWERING),
        ("eliza.group_scaled_int4_matmul", lowering_text, LOWERING),
        ("eliza.awq_int4_matmul", lowering_text, LOWERING),
        ("lower_int2_matmul_smoke", lowering_text, LOWERING),
        ("host_pads_k_to_dot16", lowering_text, LOWERING),
        ("eliza.bitnet_matmul", lowering_text, LOWERING),
        ("lower_fp8_matmul_smoke", lowering_text, LOWERING),
        ("host_pads_k_to_dot4", lowering_text, LOWERING),
        ("eliza.fp8_matmul", lowering_text, LOWERING),
        ("lower_fp16_matmul_smoke", lowering_text, LOWERING),
        ("lower_bf16_matmul_smoke", lowering_text, LOWERING),
        ("_fp16_bits_to_q8_8", lowering_text, LOWERING),
        ("_bf16_bits_to_q8_8", lowering_text, LOWERING),
        ("host_converts_float16_to_q8_8", lowering_text, LOWERING),
        ("host_requantizes_products", lowering_text, LOWERING),
        ("eliza.fp16_matmul", lowering_text, LOWERING),
        ("eliza.bf16_matmul", lowering_text, LOWERING),
        ("CommandBuffer", runtime_text, RUNTIME),
        ("descriptor_image", runtime_text, RUNTIME),
        ("stage", runtime_text, RUNTIME),
        ("NpuStreamDescriptor", runtime_text, RUNTIME),
        (
            "test_command_buffer_descriptor_image_is_word_addressed_and_contiguous",
            command_buffer_test_text,
            COMMAND_BUFFER_TEST,
        ),
        (
            "test_command_buffer_stage_writes_descriptor_image_once",
            command_buffer_test_text,
            COMMAND_BUFFER_TEST,
        ),
        (
            "test_runtime_submit_dispatches_multi_entry_buffer_with_one_completion_wait",
            command_buffer_test_text,
            COMMAND_BUFFER_TEST,
        ),
        ("PartitionCommandBufferBatch", partitioner_text, PARTITIONER),
        ("command_buffer_batches", partitioner_text, PARTITIONER),
        ("CommandBuffer.MAX_ENTRIES", partitioner_text, PARTITIONER),
        ("TensorArenaPlan", partitioner_text, PARTITIONER),
        ("TensorArenaAllocation", partitioner_text, PARTITIONER),
        ("tensor_arena_plan", partitioner_text, PARTITIONER),
        ("eliza.e1_npu_tensor_arena_plan.v1", partitioner_text, PARTITIONER),
        ("storage_dtype", partitioner_text, PARTITIONER),
        ("int32_accumulator", partitioner_text, PARTITIONER),
        ("RuntimeBindingPlan", partitioner_text, PARTITIONER),
        ("RuntimeTensorBinding", partitioner_text, PARTITIONER),
        ("RuntimeUnresolvedBinding", partitioner_text, PARTITIONER),
        ("runtime_binding_plan", partitioner_text, PARTITIONER),
        ("eliza.e1_npu_runtime_binding_plan.v1", partitioner_text, PARTITIONER),
        ("RuntimeDescriptorStagingPlan", partitioner_text, PARTITIONER),
        ("RuntimeDescriptorStagingOp", partitioner_text, PARTITIONER),
        ("RuntimeDescriptorInput", partitioner_text, PARTITIONER),
        ("descriptor_staging_plan", partitioner_text, PARTITIONER),
        ("eliza.e1_npu_descriptor_staging_plan.v1", partitioner_text, PARTITIONER),
        ("descriptor_codegen_ready", partitioner_text, PARTITIONER),
        ("input_stream_ready", partitioner_text, PARTITIONER),
        ("writeback_ready", partitioner_text, PARTITIONER),
        ("blocking_reasons", partitioner_text, PARTITIONER),
        ("unresolved_inputs", partitioner_text, PARTITIONER),
        (
            "test_partition_report_groups_contiguous_supported_ops_into_command_buffer_batches",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        (
            "test_partition_report_emits_deterministic_tensor_arena_plan",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        (
            "test_partition_report_tensor_arena_uses_packed_low_precision_sizes",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        (
            "test_partition_report_emits_runtime_binding_plan_from_arena_offsets",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        (
            "test_partition_report_runtime_binding_plan_records_unresolved_metadata_fields",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        (
            "test_partition_report_emits_descriptor_staging_plan_for_ready_input_streams",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        (
            "test_partition_report_descriptor_staging_plan_blocks_unresolved_inputs",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        (
            "test_partition_report_does_not_batch_across_cpu_fallback_ops",
            partitioner_test_text,
            PARTITIONER_TEST,
        ),
        ("command_buffer_batches", executorch_text, EXECUTORCH_DELEGATE),
        ("tensor_arena_plan", executorch_text, EXECUTORCH_DELEGATE),
        ("runtime_binding_plan", executorch_text, EXECUTORCH_DELEGATE),
        ("descriptor_staging_plan", executorch_text, EXECUTORCH_DELEGATE),
        ("descriptor_codegen_ready", executorch_test_text, EXECUTORCH_DELEGATE_TEST),
        ("input_stream_ready", executorch_test_text, EXECUTORCH_DELEGATE_TEST),
        ("unresolved_inputs", executorch_test_text, EXECUTORCH_DELEGATE_TEST),
        ("partition_report.command_buffer_batches", executorch_text, EXECUTORCH_DELEGATE),
        ("partition_report.tensor_arena_plan", executorch_text, EXECUTORCH_DELEGATE),
        ("partition_report.runtime_binding_plan", executorch_text, EXECUTORCH_DELEGATE),
        ("command_buffer_batches", litert_text, LITERT_DELEGATE),
        ("tensor_arena_plan", litert_text, LITERT_DELEGATE),
        ("runtime_binding_plan", litert_text, LITERT_DELEGATE),
        ("descriptor_staging_plan", litert_text, LITERT_DELEGATE),
        ("descriptor_codegen_ready", litert_test_text, LITERT_DELEGATE_TEST),
        ("blocking_reasons", litert_test_text, LITERT_DELEGATE_TEST),
        ("partition_report.command_buffer_batches", litert_text, LITERT_DELEGATE),
        ("partition_report.tensor_arena_plan", litert_text, LITERT_DELEGATE),
        ("partition_report.runtime_binding_plan", litert_text, LITERT_DELEGATE),
        ("command_buffer_batches", executorch_test_text, EXECUTORCH_DELEGATE_TEST),
        ("tensor_arena_plan", executorch_test_text, EXECUTORCH_DELEGATE_TEST),
        ("runtime_binding_plan", executorch_test_text, EXECUTORCH_DELEGATE_TEST),
        ("command_buffer_batches", litert_test_text, LITERT_DELEGATE_TEST),
        ("tensor_arena_plan", litert_test_text, LITERT_DELEGATE_TEST),
        ("runtime_binding_plan", litert_test_text, LITERT_DELEGATE_TEST),
        ("SUPPORTED_PRECISIONS", stablehlo_text, STABLEHLO),
        ("OP_ADD", stablehlo_text, STABLEHLO),
        ("OP_BIAS_ADD", stablehlo_text, STABLEHLO),
        ("OP_RESIDUAL_ADD", stablehlo_text, STABLEHLO),
        ("OP_MLP", stablehlo_text, STABLEHLO),
        ("OP_ATTENTION_QK", stablehlo_text, STABLEHLO),
        ("OP_ATTENTION_AV", stablehlo_text, STABLEHLO),
        ("Add", stablehlo_text, STABLEHLO),
        ("BiasAdd", stablehlo_text, STABLEHLO),
        ("ResidualAdd", stablehlo_text, STABLEHLO),
        ("Mlp", stablehlo_text, STABLEHLO),
        ("AttentionQk", stablehlo_text, STABLEHLO),
        ("AttentionAv", stablehlo_text, STABLEHLO),
        ("OP_BATCH_MATMUL", stablehlo_text, STABLEHLO),
        ("OP_CONVOLUTION", stablehlo_text, STABLEHLO),
        ("BatchMatmul", stablehlo_text, STABLEHLO),
        ("Convolution", stablehlo_text, STABLEHLO),
        ("LoweringPlan", stablehlo_text, STABLEHLO),
        ("plan_module_lowerings", stablehlo_text, STABLEHLO),
        ("materialize_lowering_graph", stablehlo_text, STABLEHLO),
        ("materialize_op_lowering_graph", stablehlo_text, STABLEHLO),
        ("materialize_module_lowering_graphs", stablehlo_text, STABLEHLO),
        ("MODULE_EMPTY", stablehlo_text, STABLEHLO),
        ("DUPLICATE_OP_NAME", stablehlo_text, STABLEHLO),
        ("_BATCH_MATMUL_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("_CONVOLUTION_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("_RESIDUAL_ADD_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("_BIAS_ADD_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("_MLP_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("_ATTENTION_QK_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("_ATTENTION_AV_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("_validate_batch_matmul", stablehlo_text, STABLEHLO),
        ("_validate_convolution", stablehlo_text, STABLEHLO),
        ("_validate_add", stablehlo_text, STABLEHLO),
        ("_validate_bias_add", stablehlo_text, STABLEHLO),
        ("_validate_residual_add", stablehlo_text, STABLEHLO),
        ("_validate_mlp", stablehlo_text, STABLEHLO),
        ("_validate_attention_qk", stablehlo_text, STABLEHLO),
        ("_validate_attention_av", stablehlo_text, STABLEHLO),
        ("LoweredBatchMatmulResult", lowering_text, LOWERING),
        ("lower_batch_matmul_smoke", lowering_text, LOWERING),
        ("lower_conv2d_smoke", lowering_text, LOWERING),
        ("lower_residual_add_smoke", lowering_text, LOWERING),
        ("lower_bias_add_smoke", lowering_text, LOWERING),
        ("lower_mlp_smoke", lowering_text, LOWERING),
        ("lower_attention_qk_smoke", lowering_text, LOWERING),
        ("lower_attention_av_smoke", lowering_text, LOWERING),
        ("SUPPORTED_BATCH_MATMUL_SCHEMA", lowering_text, LOWERING),
        ("SUPPORTED_CONV2D_SCHEMA", lowering_text, LOWERING),
        ("host_iterates_batch_heads", lowering_text, LOWERING),
        ("host_materializes_im2col", lowering_text, LOWERING),
        (
            "batch_matmul_reuses_tiled_matmul_smoke_only_not_tensor_batch_gemm",
            lowering_text,
            LOWERING,
        ),
        ("LoweredStableHloModuleResult", lowering_text, LOWERING),
        ("lower_stablehlo_module_smoke", lowering_text, LOWERING),
        ("dispatch_order", lowering_text, LOWERING),
        ("lowering_plans", lowering_text, LOWERING),
        ("all_npu_dispatch", lowering_text, LOWERING),
        (
            "stablehlo_smoke_module_dispatch_only_not_mlir_pipeline_graph_partitioner",
            lowering_text,
            LOWERING,
        ),
        ("_DOT_LOWERING_TARGETS", stablehlo_text, STABLEHLO),
        ("OP_DOT", stablehlo_text, STABLEHLO),
        ("bitnet_int2", stablehlo_text, STABLEHLO),
        ("fp8_e4m3", stablehlo_text, STABLEHLO),
        ("fp16", stablehlo_text, STABLEHLO),
        ("bf16", stablehlo_text, STABLEHLO),
        ("sparse_int4_2_4", stablehlo_text, STABLEHLO),
        ("int4_group_scaled", stablehlo_text, STABLEHLO),
        ("stablehlo.attention_qk", stablehlo_text, STABLEHLO),
        ("stablehlo.attention_av", stablehlo_text, STABLEHLO),
        (
            "test_stablehlo_subset_accepts_low_precision_rank2_dot_smoke_precisions",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_accepts_stablehlo_dot_alias_for_matmul_smoke",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_plans_runtime_lowering_targets_for_low_precision_dot_modes",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_plans_bounded_batch_matmul_runtime_lowering",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_plans_bounded_convolution_runtime_lowering",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_plans_add_and_bias_add_runtime_lowering",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_plans_mlp_runtime_lowering",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_accepts_attention_qk_and_av_smoke_records",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_plans_attention_qk_and_av_runtime_lowering",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_rejects_batch_matmul_unsupported_precision_and_shape",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_rejects_convolution_unsupported_precision_and_shape",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_rejects_add_and_bias_add_unsupported_shapes",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_rejects_mlp_unsupported_activation_precision_and_shape",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_rejects_attention_unsupported_precision_and_shape",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_materializes_runtime_smoke_graph_from_plan",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_materializes_batch_matmul_smoke_graph_from_plan",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_materializes_convolution_smoke_graph_from_plan",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_materializes_add_and_bias_add_smoke_graphs_from_plan",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_materializes_mlp_smoke_graph_from_plan",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_materializes_attention_qk_and_av_smoke_graphs_from_plan",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_materializes_metadata_backed_runtime_graphs",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_subset_rejects_empty_modules_and_duplicate_op_names",
            stablehlo_test_text,
            STABLEHLO_TEST,
        ),
        (
            "test_stablehlo_module_smoke_dispatches_materialized_dot_graphs_without_cpu_fallback",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_batch_matmul_smoke_reuses_tiled_matmul_without_cpu_fallback",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_stablehlo_module_smoke_dispatches_batch_matmul_graph_without_cpu_fallback",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_stablehlo_module_smoke_dispatches_convolution_graph_without_cpu_fallback",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_stablehlo_module_smoke_dispatches_add_and_bias_add_without_cpu_fallback",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_stablehlo_module_smoke_dispatches_mlp_without_cpu_fallback",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_stablehlo_module_smoke_dispatches_attention_qk_and_av_without_cpu_fallback",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_batch_matmul_smoke_rejects_unsupported_graphs_before_touching_mmio",
            runtime_test_text,
            RUNTIME_TEST,
        ),
        (
            "test_stablehlo_module_smoke_rejects_invalid_import_before_touching_mmio",
            runtime_test_text,
            RUNTIME_TEST,
        ),
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
        ("lower_depthwise_conv2d_smoke", lowering_text, LOWERING),
        ("_depthwise_conv2d_direct", lowering_text, LOWERING),
        ("host_uses_direct_depthwise_loops", lowering_text, LOWERING),
        ("eliza.depthwise_conv2d", lowering_text, LOWERING),
        ("lower_grouped_conv2d_smoke", lowering_text, LOWERING),
        ("_grouped_conv2d_direct", lowering_text, LOWERING),
        ("host_uses_direct_grouped_loops", lowering_text, LOWERING),
        ("eliza.grouped_conv2d", lowering_text, LOWERING),
        ("lower_attention_qk_smoke", lowering_text, LOWERING),
        ("_validate_attention_qk_shape", lowering_text, LOWERING),
        ("host_transposes_keys", lowering_text, LOWERING),
        ("host_iterates_heads", lowering_text, LOWERING),
        ("stablehlo.attention_qk", lowering_text, LOWERING),
        ("eliza.attention_qk", lowering_text, LOWERING),
        ("lower_attention_smoke", lowering_text, LOWERING),
        ("computes_attention_softmax", lowering_text, LOWERING),
        ("requires_prequantized_attention", lowering_text, LOWERING),
        ("_causal_attention_mask", lowering_text, LOWERING),
        ("_sliding_window_attention_mask", lowering_text, LOWERING),
        ("mask_mode", lowering_text, LOWERING),
        ("mask_window", lowering_text, LOWERING),
        ("host_generates_causal_mask", lowering_text, LOWERING),
        ("host_generates_sliding_window_mask", lowering_text, LOWERING),
        ("eliza.attention", lowering_text, LOWERING),
        ("lower_attention_softmax_smoke", lowering_text, LOWERING),
        ("_validate_attention_softmax_shape", lowering_text, LOWERING),
        ("runtime.exp2_neg_q0_8", lowering_text, LOWERING),
        ("host_divides_by_row_sum", lowering_text, LOWERING),
        ("eliza.attention_softmax", lowering_text, LOWERING),
        ("lower_attention_av_smoke", lowering_text, LOWERING),
        ("_validate_attention_av_shape", lowering_text, LOWERING),
        ("requires_prequantized_attention", lowering_text, LOWERING),
        ("stablehlo.attention_av", lowering_text, LOWERING),
        ("eliza.attention_av", lowering_text, LOWERING),
        ("lower_kv_cache_update_smoke", lowering_text, LOWERING),
        ("_validate_kv_cache_update_shape", lowering_text, LOWERING),
        ("host_tracks_cache_lengths", lowering_text, LOWERING),
        ("eliza.kv_cache_update", lowering_text, LOWERING),
        ("lower_qkv_projection_smoke", lowering_text, LOWERING),
        ("_validate_qkv_projection_shape", lowering_text, LOWERING),
        ("_slice_columns", lowering_text, LOWERING),
        ("host_slices_packed_qkv", lowering_text, LOWERING),
        ("eliza.qkv_projection", lowering_text, LOWERING),
        ("lower_decode_attention_smoke", lowering_text, LOWERING),
        ("updates_kv_cache", lowering_text, LOWERING),
        ("host_materializes_cache_view", lowering_text, LOWERING),
        ("host_applies_decode_cache_window", lowering_text, LOWERING),
        ("decode_cache_window", lowering_text, LOWERING),
        ("cache_window", lowering_text, LOWERING),
        ("eliza.decode_attention", lowering_text, LOWERING),
        ("lower_mlp_smoke", lowering_text, LOWERING),
        ("_validate_mlp_shape", lowering_text, LOWERING),
        ("host_requantizes_hidden", lowering_text, LOWERING),
        ("activation_opcode", lowering_text, LOWERING),
        ("eliza.transformer_mlp", lowering_text, LOWERING),
        ("lower_swiglu_smoke", lowering_text, LOWERING),
        ("_validate_swiglu_shape", lowering_text, LOWERING),
        ("eliza.swiglu", lowering_text, LOWERING),
        ("gate_activated", lowering_text, LOWERING),
        ("gate_activation_result", lowering_text, LOWERING),
        ("swiglu_s8_silu_gate_smoke_only", lowering_text, LOWERING),
        ("lower_silu_smoke", lowering_text, LOWERING),
        ("_silu_s8_scalar_approx", lowering_text, LOWERING),
        ("EXP2_NEG_Q0_8", lowering_text, LOWERING),
        ("eliza.approx_silu", lowering_text, LOWERING),
        ("lower_gelu_smoke", lowering_text, LOWERING),
        ("_quick_gelu_s8_scalar_approx", lowering_text, LOWERING),
        ("scalar_gate_mul_count", lowering_text, LOWERING),
        ("eliza.quick_gelu", lowering_text, LOWERING),
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
        ("packed_qkv_weight", lowering_text, LOWERING),
        ("qkv_projection", lowering_text, LOWERING),
        ("host_slices_packed_qkv", lowering_text, LOWERING),
        ("attention_mask_mode", lowering_text, LOWERING),
        ("attention_mask_window", lowering_text, LOWERING),
        ("host_generates_causal_mask", lowering_text, LOWERING),
        ("host_generates_sliding_window_mask", lowering_text, LOWERING),
        ("swiglu_activation", lowering_text, LOWERING),
        ("gate_activation_result", lowering_text, LOWERING),
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
        ("scalar-dot sparse INT4 matmul orchestration", arch_text, ARCH),
        ("sparse_INT4_2_4_scalar_dot_matmul_lowering_smoke", SPEC.read_text(), SPEC),
        ("group_scaled_INT4_q8_8_scalar_matmul_lowering_smoke", SPEC.read_text(), SPEC),
        ("scalar-dot INT2 matmul orchestration", arch_text, ARCH),
        ("INT2_scalar_dot_matmul_lowering_smoke", SPEC.read_text(), SPEC),
        ("scalar-dot FP8 matmul orchestration", arch_text, ARCH),
        ("FP8_E4M3_scalar_dot_matmul_lowering_smoke", SPEC.read_text(), SPEC),
        ("scalar FP16/BF16 smoke orchestration", arch_text, ARCH),
        ("FP16_scalar_q8_8_matmul_lowering_smoke", SPEC.read_text(), SPEC),
        ("BF16_scalar_q8_8_matmul_lowering_smoke", SPEC.read_text(), SPEC),
        ("CommandBuffer", arch_text, ARCH),
        ("descriptor_image", arch_text, ARCH),
        ("CommandBuffer", doc_text, DOC),
        ("descriptor-image staging", doc_text, DOC),
        ("command_buffer_batches", doc_text, DOC),
        ("command_buffer_batches", arch_text, ARCH),
        ("ExecuTorch", arch_text, ARCH),
        ("LiteRT", arch_text, ARCH),
        ("ExecuTorch", doc_text, DOC),
        ("LiteRT", doc_text, DOC),
        ("tensor_arena_plan", arch_text, ARCH),
        ("tensor_arena_plan", doc_text, DOC),
        ("storage_dtype", arch_text, ARCH),
        ("storage_dtype", doc_text, DOC),
        ("int32_accumulator", arch_text, ARCH),
        ("int32_accumulator", doc_text, DOC),
        ("runtime_binding_plan", arch_text, ARCH),
        ("runtime_binding_plan", doc_text, DOC),
        ("descriptor_staging_plan", arch_text, ARCH),
        ("descriptor_staging_plan", doc_text, DOC),
        ("unresolved_inputs", arch_text, ARCH),
        ("unresolved_inputs", doc_text, DOC),
        ("StableHLO subset", arch_text, ARCH),
        ("stablehlo.dot", arch_text, ARCH),
        ("stablehlo.attention_qk", arch_text, ARCH),
        ("stablehlo.attention_av", arch_text, ARCH),
        ("parser/import contract only", arch_text, ARCH),
        ("single_conv2d_im2col_smoke_only", arch_text, ARCH),
        ("single-Conv2D im2col runtime orchestration", arch_text, ARCH),
        ("depthwise_conv2d_direct_scalar_smoke_only", arch_text, ARCH),
        ("direct depthwise-Conv2D runtime orchestration", arch_text, ARCH),
        ("depthwise_conv2d_direct_scalar_lowering_smoke", SPEC.read_text(), SPEC),
        ("grouped_conv2d_direct_scalar_smoke_only", arch_text, ARCH),
        ("direct grouped-Conv2D runtime orchestration", arch_text, ARCH),
        ("grouped_conv2d_direct_scalar_lowering_smoke", SPEC.read_text(), SPEC),
        ("attention_qk_scores_smoke_only", arch_text, ARCH),
        ("attention-QK score runtime orchestration", arch_text, ARCH),
        ("attention_softmax_exp2_q0_8_smoke_only", arch_text, ARCH),
        ("attention-softmax scalar runtime orchestration", arch_text, ARCH),
        ("attention_softmax_exp2_q0_8_lowering_smoke", SPEC.read_text(), SPEC),
        ("attention_av_context_smoke_only", arch_text, ARCH),
        ("attention-AV context runtime orchestration", arch_text, ARCH),
        ("multihead_attention_qk_exp2_softmax_av_smoke_only", arch_text, ARCH),
        ("multi-head attention runtime orchestration", arch_text, ARCH),
        ("multihead_attention_qk_softmax_av_lowering_smoke", SPEC.read_text(), SPEC),
        ("kv_cache_update_s8_scalar_append_smoke_only", arch_text, ARCH),
        ("append-only KV-cache runtime orchestration", arch_text, ARCH),
        ("KV_cache_s8_scalar_append_lowering_smoke", SPEC.read_text(), SPEC),
        ("qkv_projection_packed_gemm_smoke_only", arch_text, ARCH),
        ("packed-QKV projection runtime orchestration", arch_text, ARCH),
        ("QKV_projection_packed_gemm_lowering_smoke", SPEC.read_text(), SPEC),
        ("decode_attention_kv_append_qk_softmax_av_smoke_only", arch_text, ARCH),
        ("decode-attention runtime orchestration", arch_text, ARCH),
        ("host_applies_decode_cache_window=true", arch_text, ARCH),
        ("decode_attention_kv_append_lowering_smoke", SPEC.read_text(), SPEC),
        ("decode_attention_recent_cache_window_lowering_smoke", SPEC.read_text(), SPEC),
        ("transformer_mlp_relu_smoke_only", arch_text, ARCH),
        ("transformer-MLP ReLU runtime orchestration", arch_text, ARCH),
        ("swiglu_s8_scalar_gate_smoke_only", arch_text, ARCH),
        ("gated-MLP scalar runtime orchestration", arch_text, ARCH),
        ("SwiGLU_s8_scalar_gate_lowering_smoke", SPEC.read_text(), SPEC),
        ("swiglu_s8_silu_gate_smoke_only", arch_text, ARCH),
        ("scalar SiLU-gated SwiGLU smoke path", arch_text, ARCH),
        ("SwiGLU_s8_silu_gate_lowering_smoke", SPEC.read_text(), SPEC),
        ("silu_s8_exp2_piecewise_smoke_only", arch_text, ARCH),
        ("scalar SiLU-approximation orchestration", arch_text, ARCH),
        ("SiLU_s8_exp2_piecewise_lowering_smoke", SPEC.read_text(), SPEC),
        ("gelu_s8_quick_exp2_piecewise_smoke_only", arch_text, ARCH),
        ("scalar QuickGELU-approximation orchestration", arch_text, ARCH),
        ("GELU_s8_quick_exp2_piecewise_lowering_smoke", SPEC.read_text(), SPEC),
        ("bias_add_s8_scalar_broadcast_smoke_only", arch_text, ARCH),
        ("row-wise bias-add scalar broadcast orchestration", arch_text, ARCH),
        ("residual_add_s8_scalar_smoke_only", arch_text, ARCH),
        ("residual-add scalar runtime orchestration", arch_text, ARCH),
        ("single_head_transformer_block_smoke_only", arch_text, ARCH),
        ("single-head transformer-block runtime orchestration", arch_text, ARCH),
        ("modern_decoder_block_single_head_exp2_softmax_smoke_only", arch_text, ARCH),
        ("host_generates_causal_mask=true", arch_text, ARCH),
        ("host_generates_sliding_window_mask=true", arch_text, ARCH),
        ("host_slices_packed_qkv=true", arch_text, ARCH),
        ("swiglu.gate_activation_result", arch_text, ARCH),
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
