#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]

OUT = ROOT / "build/reports/npu_scope.json"
NPU_TARGET = ROOT / "docs/spec-db/npu-2028-target.yaml"
NPU_ROADMAP = ROOT / "docs/spec-db/npu-2028-roadmap.yaml"
BENCHMARK_PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"
NNAPI_PROOF_TEMPLATE = ROOT / "docs/benchmarks/capabilities/e1_npu_nnapi.proof.template.json"
ANDROID_PROOF_TEMPLATE = (
    ROOT / "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json"
)
POWER_THERMAL_TEMPLATE = (
    ROOT / "docs/benchmarks/capabilities/e1_npu_power_thermal_manifest.template.json"
)
NNAPI_PROOF_CHECKER = ROOT / "scripts/check_e1_npu_nnapi_proof.py"
NPU_TARGET_CHECKER = ROOT / "scripts/check_npu_2028_targets.py"
NPU_ROADMAP_CHECKER = ROOT / "scripts/check_npu_roadmap.py"
NPU_SCALE_CHECKER = ROOT / "scripts/check_npu_scale_sim.py"
NPU_CONTEXT_QUEUE_CHECKER = ROOT / "scripts/check_npu_context_queue_sim.py"
NPU_RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
NPU_RTL = ROOT / "rtl/npu/e1_npu.sv"

REQUIRED_NUMERIC_TARGETS = {
    "dense_int8_peak_tops_min": 160,
    "dense_int8_sustained_tops_min": 80,
    "sparse_int4_peak_tops_min": 512,
    "sparse_int4_sustained_tops_min": 200,
    "int2_bitnet_peak_tops_min": 900,
    "fp8_peak_tflops_min": 80,
    "sustained_perf_per_w_int8_tops_min": 18,
    "local_sram_mib_min": 64,
    "external_memory_bandwidth_gbps_min": 180,
    "command_queue_depth_min": 1024,
    "concurrent_contexts_min": 8,
}
REQUIRED_NNAPI_TRANSCRIPTS = {
    "adb_devices",
    "nnapi_accelerator_query",
    "benchmark_model_nnapi",
    "dma_trace",
}
REQUIRED_BENCHMARK_METRICS = {
    "avg_latency_us",
    "unsupported_op_count",
    "cpu_fallback_percent",
}
REQUIRED_ANDROID_STATUSES = {
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
REQUIRED_ANDROID_ARTIFACTS = {
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


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def find_benchmark(config: dict[str, Any], name: str) -> dict[str, Any]:
    for bench in list_values(config.get("benchmarks")):
        if isinstance(bench, dict) and bench.get("name") == name:
            return bench
    return {}


def npu_target_is_scaffold_only(target: dict[str, Any]) -> bool:
    numeric = mapping(target.get("numeric_targets"))
    classification = mapping(target.get("current_repo_classification"))
    gaps = set(str(gap) for gap in list_values(classification.get("explicit_gaps")))
    return (
        target.get("schema") == "eliza.npu_2028_target.v1"
        and target.get("target_year") == 2028
        and "validation gates, not completion claims" in str(target.get("positioning", ""))
        and classification.get("level") == "L0_RTL_UNIT"
        and {
            "no_systolic_array",
            "no_production_compiler_backend",
            "no_NNAPI_delegate",
            "no_sustained_benchmark_evidence",
            "no_INT2_tensor_path",
            "no_FP8_tensor_path",
        }
        <= gaps
        and all(
            isinstance(numeric.get(metric), int | float) and numeric[metric] >= minimum
            for metric, minimum in REQUIRED_NUMERIC_TARGETS.items()
        )
    )


def npu_roadmap_blocks_l4_l5_claims(roadmap: dict[str, Any]) -> bool:
    phases = {
        str(phase.get("id")): phase for phase in list_values(roadmap.get("phases")) if isinstance(phase, dict)
    }
    l4 = mapping(phases.get("L4_ANDROID_HAL_DELEGATE"))
    l5 = mapping(phases.get("L5_2028_PHONE_CLASS_EVIDENCE"))
    return (
        roadmap.get("schema") == "eliza.npu_2028_roadmap.v1"
        and roadmap.get("current_phase") == "L0_MMIO_PROTOTYPE"
        and "no_android_boot_or_phone_class_accelerator_claim"
        in str(roadmap.get("claim_boundary", ""))
        and l4.get("status") == "planned_blocked"
        and l5.get("status") == "planned_blocked"
        and "CTS_and_VTS_artifacts" in set(list_values(l4.get("required_capabilities")))
        and "MLPerf_Mobile_or_equivalent_closed_loop"
        in set(list_values(l5.get("required_capabilities")))
    )


def nnapi_template_is_fail_closed(template: dict[str, Any]) -> bool:
    transcripts = mapping(template.get("transcripts"))
    nnapi = mapping(template.get("nnapi"))
    capture = mapping(mapping(template.get("capture")).get("commands"))
    model_artifacts = mapping(template.get("model_artifacts"))
    return (
        template.get("schema") == "eliza.e1_npu_nnapi_capability.v1"
        and mapping(template.get("capability")).get("claim_level") == "L4_DEV_BOARD"
        and template.get("accelerator_name") == "e1-npu"
        and nnapi.get("cpu_fallback_percent") == 0
        and nnapi.get("unsupported_op_count") == 0
        and set(transcripts) >= REQUIRED_NNAPI_TRANSCRIPTS
        and set(capture) >= REQUIRED_NNAPI_TRANSCRIPTS
        and "benchmarks/models/mobile_smoke.tflite" in model_artifacts
        and all(
            "64-character lowercase sha256" in str(mapping(transcripts[name]).get("sha256", ""))
            for name in REQUIRED_NNAPI_TRANSCRIPTS
        )
        and contains_all(
            capture.get("benchmark_model_nnapi", ""),
            ("--use_nnapi=true", "--nnapi_accelerator_name=e1-npu"),
        )
    )


def android_template_is_fail_closed(template: dict[str, Any]) -> bool:
    gate = mapping(template.get("proof_gate"))
    statuses = mapping(template.get("required_statuses"))
    artifacts = mapping(template.get("artifacts"))
    return (
        template.get("schema") == "eliza.e1_npu_android_proof_manifest.v1"
        and template.get("status") == "blocked"
        and template.get("claim_boundary")
        == "template_only_not_android_boot_cts_vts_or_nnapi_evidence"
        and gate.get("android_boot_claim") == "none"
        and gate.get("compatibility_claim") == "none"
        and gate.get("nnapi_acceleration_claim")
        == "none_without_all_required_artifacts_passed"
        and set(statuses) >= REQUIRED_ANDROID_STATUSES
        and all(status == "blocked" for status in statuses.values())
        and set(artifacts) >= REQUIRED_ANDROID_ARTIFACTS
        and all(
            "64-character lowercase sha256" in str(mapping(artifacts[name]).get("sha256", ""))
            for name in REQUIRED_ANDROID_ARTIFACTS
        )
    )


def power_thermal_template_is_fail_closed(template: dict[str, Any]) -> bool:
    statuses = mapping(template.get("required_statuses"))
    artifacts = mapping(template.get("artifacts"))
    metrics = mapping(template.get("computed_metrics"))
    return (
        template.get("schema") == "eliza.e1_npu_power_thermal_manifest.v1"
        and template.get("status") == "blocked"
        and "template_only" in str(template.get("claim_boundary", ""))
        and set(statuses) >= REQUIRED_POWER_THERMAL_STATUSES
        and all(status == "blocked" for status in statuses.values())
        and set(artifacts) >= REQUIRED_POWER_THERMAL_ARTIFACTS
        and {
            "sustained_int8_tops",
            "average_watts",
            "sustained_perf_per_w_int8_tops",
            "max_die_c",
            "throttle_state",
        }
        <= set(metrics)
    )


def benchmark_plan_blocks_unproven_nnapi(config: dict[str, Any]) -> bool:
    bench = find_benchmark(config, "tflite_e1_npu")
    artifacts = list_values(bench.get("capability_artifacts"))
    model_artifacts = list_values(bench.get("model_artifacts"))
    proof = mapping(mapping(artifacts[0]).get("proof")) if len(artifacts) == 1 else {}
    gates = {
        (gate.get("metric"), gate.get("op"), gate.get("value"))
        for gate in list_values(bench.get("metric_gates"))
        if isinstance(gate, dict)
    }
    return (
        bench.get("name") == "tflite_e1_npu"
        and "--use_nnapi=true" in list_values(bench.get("command"))
        and "--nnapi_accelerator_name=e1-npu" in list_values(bench.get("command"))
        and len(artifacts) == 1
        and mapping(artifacts[0]).get("path")
        == "benchmarks/capabilities/e1_npu_nnapi.proof.json"
        and mapping(artifacts[0]).get("release_blocking") is True
        and mapping(artifacts[0]).get("blocked_reason") == "missing_e1_npu_nnapi_accelerator"
        and set(list_values(bench.get("required_metrics"))) >= REQUIRED_BENCHMARK_METRICS
        and proof.get("max_cpu_fallback_percent") == 0
        and proof.get("max_unsupported_op_count") == 0
        and set(list_values(proof.get("required_files"))) >= REQUIRED_NNAPI_TRANSCRIPTS
        and any(
            isinstance(artifact, dict)
            and artifact.get("path") == "benchmarks/models/mobile_smoke.tflite"
            and artifact.get("placeholder_allowed") is False
            for artifact in model_artifacts
        )
        and ("unsupported_op_count", "==", 0) in gates
        and ("cpu_fallback_percent", "<=", 0) in gates
    )


def current_scaffolds_are_not_silicon_proof() -> bool:
    text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (
            NNAPI_PROOF_CHECKER,
            NPU_SCALE_CHECKER,
            NPU_CONTEXT_QUEUE_CHECKER,
            NPU_RUNTIME,
            NPU_RTL,
        )
    )
    return contains_all(
        text,
        (
            "readiness and validation check, not a proof generator",
            "missing_e1_npu_nnapi_accelerator",
            "modeled",
            "command",
            "scratch",
        ),
    )


def build_report() -> dict[str, Any]:
    target = load_yaml_object(NPU_TARGET)
    roadmap = load_yaml_object(NPU_ROADMAP)
    benchmark_plan = load_json_object(BENCHMARK_PLAN)
    nnapi_template = load_json_object(NNAPI_PROOF_TEMPLATE)
    android_template = load_json_object(ANDROID_PROOF_TEMPLATE)
    power_thermal_template = load_json_object(POWER_THERMAL_TEMPLATE)
    checks = [
        {
            "id": "npu_2028_target_is_scaffold_only",
            "status": "pass" if npu_target_is_scaffold_only(target) else "fail",
            "evidence": rel(NPU_TARGET),
        },
        {
            "id": "npu_roadmap_blocks_l4_l5_claims",
            "status": "pass" if npu_roadmap_blocks_l4_l5_claims(roadmap) else "fail",
            "evidence": rel(NPU_ROADMAP),
        },
        {
            "id": "nnapi_proof_template_requires_real_target_transcripts",
            "status": "pass" if nnapi_template_is_fail_closed(nnapi_template) else "fail",
            "evidence": rel(NNAPI_PROOF_TEMPLATE),
        },
        {
            "id": "android_proof_manifest_template_blocks_boot_compat_and_nnapi_claims",
            "status": "pass" if android_template_is_fail_closed(android_template) else "fail",
            "evidence": rel(ANDROID_PROOF_TEMPLATE),
        },
        {
            "id": "power_thermal_template_blocks_sustained_efficiency_claims",
            "status": "pass"
            if power_thermal_template_is_fail_closed(power_thermal_template)
            else "fail",
            "evidence": rel(POWER_THERMAL_TEMPLATE),
        },
        {
            "id": "benchmark_plan_blocks_unproven_nnapi_acceleration",
            "status": "pass" if benchmark_plan_blocks_unproven_nnapi(benchmark_plan) else "fail",
            "evidence": rel(BENCHMARK_PLAN),
        },
        {
            "id": "current_runtime_and_sim_scaffolds_are_not_silicon_proof",
            "status": "pass" if current_scaffolds_are_not_silicon_proof() else "fail",
            "evidence": rel(NNAPI_PROOF_CHECKER),
        },
    ]
    return {
        "schema": "eliza.npu_scope.v1",
        "status": "npu_scope_release_blocked",
        "claim_boundary": (
            "NPU scope audit only; not Android boot evidence, not CTS/VTS evidence, "
            "not NNAPI accelerator proof, not DMA transcript evidence, not measured "
            "TOPS/latency evidence, not sustained power/thermal evidence, not MLPerf "
            "Mobile evidence, and not a 2028 phone-class NPU claim."
        ),
        "current_scaffolds": {
            "npu_target": rel(NPU_TARGET),
            "npu_roadmap": rel(NPU_ROADMAP),
            "benchmark_plan": rel(BENCHMARK_PLAN),
            "nnapi_proof_template": rel(NNAPI_PROOF_TEMPLATE),
            "android_proof_template": rel(ANDROID_PROOF_TEMPLATE),
            "power_thermal_template": rel(POWER_THERMAL_TEMPLATE),
            "nnapi_proof_checker": rel(NNAPI_PROOF_CHECKER),
            "npu_target_checker": rel(NPU_TARGET_CHECKER),
            "npu_roadmap_checker": rel(NPU_ROADMAP_CHECKER),
            "npu_scale_checker": rel(NPU_SCALE_CHECKER),
            "npu_context_queue_checker": rel(NPU_CONTEXT_QUEUE_CHECKER),
        },
        "required_real_evidence": [
            "Android or Linux target enumerates a real e1-npu accelerator or delegate",
            "adb devices transcript identifies the exact validation target",
            "NNAPI accelerator query transcript lists e1-npu",
            "benchmark_model transcript uses --use_nnapi=true and --nnapi_accelerator_name=e1-npu",
            "DMA trace transcript records e1-npu bytes_read and bytes_written from hardware DMA",
            "capability proof JSON pins model hashes, transcript hashes, MAC count, cycles, frequency, and observed TOPS",
            "unsupported_op_count is zero and cpu_fallback_percent is zero for the released benchmark",
            "Android proof manifest contains passing VTS, CTS, VINTF, SELinux, NNAPI query, and fail-closed absent-device artifacts",
            "power/thermal manifest contains calibrated sustained workload traces and computed perf-per-watt",
            "reviewed MLPerf Mobile or equivalent closed-loop workload evidence covers latency, power, thermals, clocks, memory, and process state",
        ],
        "proof_artifacts": {
            "required_capability_json": "benchmarks/capabilities/e1_npu_nnapi.proof.json",
            "required_android_manifest": "docs/evidence/android/e1-npu/android-proof-manifest.json",
            "template_transcripts": sorted(REQUIRED_NNAPI_TRANSCRIPTS),
            "required_benchmark_metrics": sorted(REQUIRED_BENCHMARK_METRICS),
        },
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "current_npu_level": mapping(target.get("current_repo_classification")).get("level"),
            "android_nnapi_claim_allowed": False,
            "measured_silicon_claim_allowed": False,
            "phone_2028_claim_allowed": False,
            "release_claim_allowed": False,
        },
        "checks": checks,
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.npu_scope.v1", "schema mismatch", errors)
    require(
        data.get("status") == "npu_scope_release_blocked",
        "status must remain npu_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not Android boot evidence",
        "not CTS/VTS evidence",
        "not NNAPI accelerator proof",
        "not DMA transcript evidence",
        "not measured TOPS/latency evidence",
        "not sustained power/thermal evidence",
        "not MLPerf Mobile evidence",
        "not a 2028 phone-class NPU claim",
    ):
        require(token in boundary, f"claim boundary missing {token}", errors)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    for key in (
        "android_nnapi_claim_allowed",
        "measured_silicon_claim_allowed",
        "phone_2028_claim_allowed",
        "release_claim_allowed",
    ):
        require(summary.get(key) is False, f"{key} must stay false", errors)
    require(
        summary.get("current_npu_level") == "L0_RTL_UNIT",
        "current_npu_level must remain L0_RTL_UNIT until real evidence lands",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
        return errors
    for check in checks:
        if not isinstance(check, dict):
            errors.append("checks entries must be mappings")
            continue
        if check.get("status") != "pass":
            errors.append(f"{check.get('id')}: must pass structural scope check")
    blocked = data.get("required_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 10:
        errors.append("NPU scope must enumerate blocked real-evidence items")
    proof = data.get("proof_artifacts")
    if not isinstance(proof, dict):
        errors.append("proof_artifacts must be a mapping")
    else:
        require(
            proof.get("required_capability_json")
            == "benchmarks/capabilities/e1_npu_nnapi.proof.json",
            "proof_artifacts missing required capability JSON",
            errors,
        )
        require(
            proof.get("required_android_manifest")
            == "docs/evidence/android/e1-npu/android-proof-manifest.json",
            "proof_artifacts missing required Android manifest",
            errors,
        )
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in (
            "npu_target",
            "npu_roadmap",
            "benchmark_plan",
            "nnapi_proof_template",
            "android_proof_template",
            "power_thermal_template",
            "nnapi_proof_checker",
            "npu_target_checker",
            "npu_roadmap_checker",
            "npu_scale_checker",
            "npu_context_queue_checker",
        ):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"NPU scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
