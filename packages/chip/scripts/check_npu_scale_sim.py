#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIM = ROOT / "benchmarks/sim/run_npu_scale_sim.py"


REQUIRED_KERNEL_KEYS = {
    "kernel",
    "target_cycles",
    "npu_cycles",
    "macs",
    "bytes_read",
    "bytes_written",
    "external_bytes_read",
    "external_bytes_written",
    "local_sram_bytes",
    "compute_cycles",
    "memory_cycles",
    "memory_wait_cycles",
    "stall_cycles",
    "utilization_percent",
    "modeled_frequency_hz",
    "throughput_ops_s",
    "observed_tops",
    "energy_nj",
    "average_power_w",
    "tops_per_watt",
    "arithmetic_intensity_macs_per_external_byte",
}
REQUIRED_PRECISIONS = {"INT4", "INT8", "FP16", "BF16", "FP8"}
REQUIRED_PROCESS_CORNERS = {
    "14a_tt_0p70v_25c_frontside_pdn",
    "14a_ss_0p63v_105c_frontside_pdn",
    "14a_ff_0p77v_0c_frontside_pdn",
    "14a_bspdn_follow_on_hot_ir_em_stress",
}
REQUIRED_PROCESS_CORNER_KEYS = {
    "name",
    "voltage_v",
    "temperature_c",
    "frequency_derate",
    "interconnect_rc_derate",
    "dynamic_power_scale",
    "leakage_power_scale",
    "thermal_margin_derate",
    "effective_clock_hz",
    "effective_dma_bytes_per_cycle",
    "dense_int8_peak_tops",
    "min_observed_tops",
    "max_observed_tops",
    "min_utilization_percent",
    "min_tops_per_watt",
    "max_average_power_w",
    "kernels",
    "claim_boundary",
    "release_use",
}


def main() -> int:
    errors: list[str] = []
    if not SIM.is_file():
        return report([f"missing simulator: {SIM.relative_to(ROOT)}"])

    completed = subprocess.run(
        [sys.executable, str(SIM), "--config", "open_2028_first_50tops"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return report(["scale simulator command failed", completed.stderr.strip()])

    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return report([f"scale simulator emitted invalid JSON: {exc}"])

    if data.get("schema") != "eliza.npu_scale_sim.v1":
        errors.append("scale simulator schema mismatch")
    config = data.get("config", {})
    if not isinstance(config, dict):
        errors.append("scale simulator config must be an object")
    else:
        if not 10.0 <= float(config.get("dense_int8_peak_tops", 0.0)) <= 50.0:
            errors.append("first open target must model 10-50 dense INT8 TOPS")
        if int(config.get("dma_queue_depth", 0)) < 1024:
            errors.append("first open target must model descriptor queue depth >=1024")
            if int(config.get("scratchpad_kib", 0)) < 1024:
                errors.append("first open target must model at least 1 MiB aggregate scratchpad")
            for field in (
                "energy_pj_per_int8_mac",
                "local_sram_pj_per_byte",
                "external_memory_pj_per_byte",
                "static_power_w",
            ):
                value = config.get(field)
                if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                    errors.append(f"scale simulator config.{field} must be positive numeric")
        precision_matrix = config.get("precision_matrix")
        if not isinstance(precision_matrix, list):
            errors.append("scale simulator config must report precision_matrix")
        else:
            states = {
                entry.get("precision"): entry.get("state")
                for entry in precision_matrix
                if isinstance(entry, dict)
            }
            missing = sorted(REQUIRED_PRECISIONS - set(states))
            if missing:
                errors.append(f"precision_matrix missing: {', '.join(missing)}")
            if states.get("FP8") != "blocked":
                errors.append("precision_matrix must keep FP8 blocked")
            for projected in ("FP16", "BF16"):
                if states.get(projected) != "projected":
                    errors.append(f"precision_matrix must report {projected} as projected only")
        descriptor_queue = config.get("descriptor_queue")
        if not isinstance(descriptor_queue, dict):
            errors.append("scale simulator config must report descriptor_queue")
        elif (
            descriptor_queue.get("runtime_mmio_support")
            != "reserved_blocked_without_dma_engine_evidence"
        ):
            errors.append("descriptor_queue must not claim implemented runtime MMIO support")

    artifacts = data.get("artifacts", {})
    model = artifacts.get("model") if isinstance(artifacts, dict) else None
    if not isinstance(model, dict):
        errors.append("scale simulator must capture benchmark model hash")
    else:
        if model.get("path") != "benchmarks/models/mobile_smoke.tflite":
            errors.append("model hash path must identify mobile_smoke.tflite")
        sha = model.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64:
            errors.append("model hash must be sha256 hex")
        if not isinstance(model.get("bytes"), int) or model.get("bytes", 0) <= 0:
            errors.append("model hash must include positive byte size")
    process_contract = (
        artifacts.get("process_effects_contract") if isinstance(artifacts, dict) else None
    )
    if not isinstance(process_contract, dict):
        errors.append("scale simulator must capture process effects contract hash")
    else:
        if process_contract.get("path") != "docs/spec-db/process-14a-effects.yaml":
            errors.append("process contract hash path must identify process-14a-effects.yaml")
        sha = process_contract.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64:
            errors.append("process contract hash must be sha256 hex")

    kernels = data.get("kernels")
    if not isinstance(kernels, list) or len(kernels) < 3:
        errors.append("scale simulator must report at least GEMM, conv, and attention kernels")
    else:
        names = {kernel.get("kernel") for kernel in kernels if isinstance(kernel, dict)}
        for required in ("gemm_s8", "conv2d_s8", "attention_qk_s8"):
            if required not in names:
                errors.append(f"scale simulator missing kernel {required}")
        for index, kernel in enumerate(kernels):
            if not isinstance(kernel, dict):
                errors.append(f"kernels[{index}] must be an object")
                continue
            missing = sorted(REQUIRED_KERNEL_KEYS - set(kernel))
            if missing:
                errors.append(f"kernels[{index}] missing keys: {', '.join(missing)}")
            for field in (
                "target_cycles",
                "npu_cycles",
                "macs",
                "bytes_read",
                "bytes_written",
                "external_bytes_read",
                "external_bytes_written",
                "local_sram_bytes",
                "modeled_frequency_hz",
            ):
                value = kernel.get(field)
                if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                    errors.append(f"kernels[{index}].{field} must be a positive integer")
            for field in (
                "utilization_percent",
                "throughput_ops_s",
                "observed_tops",
                "energy_nj",
                "average_power_w",
                "tops_per_watt",
                "arithmetic_intensity_macs_per_external_byte",
            ):
                value = kernel.get(field)
                if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                    errors.append(f"kernels[{index}].{field} must be positive numeric")

    corners = data.get("process_corners")
    if not isinstance(corners, list) or len(corners) < len(REQUIRED_PROCESS_CORNERS):
        errors.append("scale simulator must report required 14A process corners")
    else:
        names = {corner.get("name") for corner in corners if isinstance(corner, dict)}
        missing_corners = sorted(REQUIRED_PROCESS_CORNERS - names)
        if missing_corners:
            errors.append(f"process_corners missing: {', '.join(missing_corners)}")
        for index, corner in enumerate(corners):
            if not isinstance(corner, dict):
                errors.append(f"process_corners[{index}] must be an object")
                continue
            missing_keys = sorted(REQUIRED_PROCESS_CORNER_KEYS - set(corner))
            if missing_keys:
                errors.append(f"process_corners[{index}] missing keys: {', '.join(missing_keys)}")
            for field in (
                "voltage_v",
                "frequency_derate",
                "interconnect_rc_derate",
                "dynamic_power_scale",
                "leakage_power_scale",
                "thermal_margin_derate",
                "dense_int8_peak_tops",
                "min_observed_tops",
                "max_observed_tops",
                "min_utilization_percent",
                "min_tops_per_watt",
                "max_average_power_w",
            ):
                value = corner.get(field)
                if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                    errors.append(f"process_corners[{index}].{field} must be positive numeric")
            for field in ("temperature_c", "effective_clock_hz", "effective_dma_bytes_per_cycle"):
                value = corner.get(field)
                if not isinstance(value, int) or isinstance(value, bool):
                    errors.append(f"process_corners[{index}].{field} must be an integer")
            if (
                corner.get("release_use")
                != "prohibited_until_pdk_extracted_timing_power_thermal_signoff"
            ):
                errors.append(f"process_corners[{index}] must remain prohibited for release use")
            if "not_pdk_signoff" not in str(corner.get("claim_boundary", "")):
                errors.append(f"process_corners[{index}] claim boundary must block PDK signoff use")
            corner_kernels = corner.get("kernels")
            if not isinstance(corner_kernels, list) or len(corner_kernels) < 3:
                errors.append(f"process_corners[{index}].kernels must include modeled kernels")

    summary = data.get("summary")
    if isinstance(summary, dict):
        if summary.get("process_corner_count") != len(corners or []):
            errors.append("summary.process_corner_count must match process_corners length")
        if summary.get("worst_process_corner") not in REQUIRED_PROCESS_CORNERS:
            errors.append("summary.worst_process_corner must identify a required process corner")
        if (
            summary.get("process_corner_claim_boundary")
            != "modeled_derates_only_not_14a_pdk_or_signoff_evidence"
        ):
            errors.append("summary must keep process corners as modeled-only evidence")
        for field in ("min_tops_per_watt", "max_average_power_w"):
            value = summary.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                errors.append(f"summary.{field} must be positive numeric")

    return report(errors)


def report(errors: list[str]) -> int:
    clean = [error for error in errors if error]
    if clean:
        print("NPU scale simulator check failed:")
        for error in clean:
            print(f"  - {error}")
        return 1
    print("NPU scale simulator check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
