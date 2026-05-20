#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml
from chip_utils import load_json_object, load_yaml_object, require_number

ROOT = Path(__file__).resolve().parents[1]
MODELED_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-modeled-eval.json"
OPTIMIZER = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
TARGET_SPEC = ROOT / "docs/spec-db/npu-2028-target.yaml"
OUT = ROOT / "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json"


def check_row(row_id: str, status: str, evidence: str) -> dict[str, str]:
    return {"id": row_id, "status": status, "evidence": evidence}


def build_policy() -> dict[str, Any]:
    eval_report = load_json_object(MODELED_EVAL)
    optimizer = load_json_object(OPTIMIZER)
    target = load_yaml_object(TARGET_SPEC)
    metrics = eval_report.get("modeled_metrics")
    targets = target.get("numeric_targets")
    if not isinstance(metrics, dict):
        raise ValueError("modeled eval missing modeled_metrics")
    if not isinstance(targets, dict):
        raise ValueError("target spec missing numeric_targets")
    optimized = optimizer.get("optimized")
    robustness = optimizer.get("robustness")
    if not isinstance(optimized, dict) or not isinstance(optimized.get("config"), dict):
        raise ValueError("optimizer missing optimized config")
    if not isinstance(optimized.get("summary"), dict):
        raise ValueError("optimizer missing optimized summary")
    if not isinstance(robustness, dict) or not isinstance(robustness.get("summary"), dict):
        raise ValueError("optimizer missing robustness summary")

    opt_config = optimized["config"]
    opt_summary = optimized["summary"]
    robust_summary = robustness["summary"]
    sustained_power_w = require_number(robust_summary.get("max_total_power_w"), "robust max power")
    sustained_temp_c = require_number(robust_summary.get("max_die_temp_c"), "robust max temp")
    sustained_tops = require_number(opt_summary.get("min_npu_int8_tops"), "sustained NPU TOPS")
    sustained_memory_margin = require_number(
        robust_summary.get("min_bandwidth_margin_gbps"), "robust memory margin"
    )
    sustained_memory_gbps = require_number(
        opt_config.get("memory_sustained_gbps"), "optimized memory bandwidth"
    )
    cpu_sota_power_w = require_number(
        metrics.get("cpu_sota_estimated_package_power_w"), "SOTA CPU power"
    )
    cpu_sota_ipc = require_number(metrics.get("cpu_sota_ipc"), "SOTA CPU IPC")
    npu_sota_peak = require_number(metrics.get("npu_sota_dense_int8_peak_tops"), "SOTA NPU peak")
    npu_sota_sparse = require_number(
        metrics.get("npu_sota_sparse_int4_projected_tops"), "SOTA NPU sparse"
    )
    npu_sota_worst = require_number(
        metrics.get("npu_sota_worst_process_corner_min_observed_tops"), "SOTA NPU worst"
    )
    npu_sota_queue_depth = require_number(
        metrics.get("npu_sota_dma_queue_depth"), "SOTA NPU queue depth"
    )
    npu_sota_descriptors = require_number(
        metrics.get("npu_sota_total_descriptors_required"), "SOTA NPU descriptors"
    )
    npu_sota_queue_passes = require_number(
        metrics.get("npu_sota_max_descriptor_queue_passes"), "SOTA NPU queue passes"
    )
    npu_sota_dma_beats = require_number(
        metrics.get("npu_sota_total_dma_beats"), "SOTA NPU DMA beats"
    )
    burst_npu_power_cap_w = require_number(
        targets.get("burst_npu_power_w_max"), "burst NPU power cap"
    )
    sustained_npu_power_cap_w = require_number(
        targets.get("sustained_npu_power_w_max"), "sustained NPU power cap"
    )
    dense_peak_target = require_number(
        targets.get("dense_int8_peak_tops_min"), "dense INT8 peak target"
    )
    sustained_target = require_number(
        targets.get("dense_int8_sustained_tops_min"), "dense INT8 sustained target"
    )
    sparse_target = require_number(
        targets.get("sparse_int4_peak_tops_min"), "sparse INT4 peak target"
    )
    queue_depth_target = require_number(
        targets.get("command_queue_depth_min"), "command queue depth target"
    )

    estimated_burst_package_cap_w = cpu_sota_power_w + burst_npu_power_cap_w + 1.4
    checks = [
        check_row(
            "sustained_no_throttle_policy_pass",
            "pass"
            if opt_summary.get("any_modeled_throttle_required") is False
            and robust_summary.get("pass") is True
            and sustained_power_w <= 5.0
            and sustained_temp_c <= 95.0
            and sustained_memory_margin > 0.0
            else "fail",
            "Sustained mode uses the optimizer-selected no-throttle point with robust modeled guardbands.",
        ),
        check_row(
            "sustained_npu_target_release_blocked",
            "blocked",
            "Sustained NPU target is not claimed from the model; measured TOPS/W and thermal traces are required.",
        ),
        check_row(
            "burst_peak_policy_pass",
            "pass"
            if npu_sota_peak >= dense_peak_target
            and npu_sota_sparse >= sparse_target
            and npu_sota_worst >= sustained_target
            and npu_sota_queue_depth >= queue_depth_target
            and npu_sota_queue_passes == 1.0
            and npu_sota_descriptors > 0.0
            and npu_sota_dma_beats > 0.0
            and cpu_sota_ipc >= 2.35
            else "fail",
            "Burst mode admits the SOTA CPU/NPU modeled peak profiles and descriptor/DMA queue-pressure budget only as architecture headroom.",
        ),
        check_row(
            "burst_power_duration_release_blocked",
            "blocked",
            "Burst duration, skin temperature, rail current, and recovery hysteresis remain blocked until measured traces and package models exist.",
        ),
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    blocked = [row["id"] for row in checks if row["status"] == "blocked"]
    return {
        "schema": "eliza.cpu_npu_2028_burst_sustained_policy.v1",
        "status": "fail" if failed else "modeled_policy_release_blocked" if blocked else "pass",
        "claim_boundary": (
            "Deterministic modeled DVFS/governor policy only; not AOSP scheduler, silicon, "
            "thermal enclosure, battery, or phone-class sustained performance evidence."
        ),
        "source_artifacts": {
            "modeled_eval": str(MODELED_EVAL.relative_to(ROOT)),
            "optimizer_report": str(OPTIMIZER.relative_to(ROOT)),
            "target_spec": str(TARGET_SPEC.relative_to(ROOT)),
        },
        "sustained_policy": {
            "cpu_base_power_w": require_number(opt_config.get("cpu_base_power_w"), "cpu power"),
            "npu_base_power_w": require_number(opt_config.get("npu_base_power_w"), "npu power"),
            "npu_modeled_min_tops": sustained_tops,
            "npu_power_cap_w": sustained_npu_power_cap_w,
            "npu_descriptor_queue_depth": npu_sota_queue_depth,
            "npu_total_descriptors_required": npu_sota_descriptors,
            "npu_max_descriptor_queue_passes": npu_sota_queue_passes,
            "npu_total_dma_beats": npu_sota_dma_beats,
            "memory_sustained_gbps": sustained_memory_gbps,
            "robust_max_total_power_w": sustained_power_w,
            "robust_max_die_temp_c": sustained_temp_c,
            "robust_min_bandwidth_margin_gbps": sustained_memory_margin,
            "governor_state": "sustained_no_throttle_modeled",
        },
        "burst_policy": {
            "cpu_sota_ipc": cpu_sota_ipc,
            "cpu_sota_estimated_power_w": cpu_sota_power_w,
            "npu_sota_dense_int8_peak_tops": npu_sota_peak,
            "npu_sota_sparse_int4_projected_tops": npu_sota_sparse,
            "npu_sota_worst_process_corner_min_tops": npu_sota_worst,
            "npu_descriptor_queue_depth": npu_sota_queue_depth,
            "npu_total_descriptors_required": npu_sota_descriptors,
            "npu_max_descriptor_queue_passes": npu_sota_queue_passes,
            "npu_total_dma_beats": npu_sota_dma_beats,
            "npu_burst_power_cap_w": burst_npu_power_cap_w,
            "estimated_package_power_cap_w": estimated_burst_package_cap_w,
            "governor_state": "burst_headroom_modeled_release_blocked",
            "duration_s": "blocked_until_measured_thermal_transient_trace",
        },
        "checks": checks,
        "release_claim_forbidden_until": [
            "AOSP scheduler and thermal HAL select sustained and burst states in local simulator evidence.",
            "Measured aligned power, thermal, frequency, and workload traces prove sustained TOPS/W.",
            "Package/enclosure transient thermal model proves burst duration and recovery.",
            "14A PDK extracted timing, power, IR/EM, and thermal signoff replaces planning derates.",
        ],
    }


def validate_policy(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_burst_sustained_policy.v1":
        errors.append("schema mismatch")
    if data.get("status") != "modeled_policy_release_blocked":
        errors.append("policy must remain modeled_policy_release_blocked")
    if "not AOSP" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block AOSP scheduler claims")
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be a list")
        return errors
    by_id = {row.get("id"): row for row in checks if isinstance(row, dict)}
    for row_id in ("sustained_no_throttle_policy_pass", "burst_peak_policy_pass"):
        if by_id.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    for row_id in ("sustained_npu_target_release_blocked", "burst_power_duration_release_blocked"):
        if by_id.get(row_id, {}).get("status") != "blocked":
            errors.append(f"{row_id} must remain blocked")
    sustained = data.get("sustained_policy")
    burst = data.get("burst_policy")
    if not isinstance(sustained, dict) or not isinstance(burst, dict):
        errors.append("policy must include sustained_policy and burst_policy")
        return errors
    if require_number(sustained.get("robust_max_total_power_w"), "sustained power") > 5.0:
        errors.append("sustained robust power must stay <= 5 W")
    if require_number(sustained.get("robust_max_die_temp_c"), "sustained temp") > 95.0:
        errors.append("sustained robust die temperature must stay <= 95 C")
    if require_number(sustained.get("npu_max_descriptor_queue_passes"), "queue passes") != 1.0:
        errors.append("sustained NPU descriptor queue must fit in one modeled queue pass")
    if require_number(sustained.get("npu_total_dma_beats"), "DMA beats") <= 0.0:
        errors.append("sustained NPU DMA beats must be positive")
    if not isinstance(burst.get("duration_s"), str) or not burst["duration_s"].startswith(
        "blocked_"
    ):
        errors.append("burst duration must remain blocked")
    return errors


def main() -> int:
    try:
        data = build_policy()
        errors = validate_policy(data)
    except (OSError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        data = None
        errors = [str(exc)]
    if errors:
        print("CPU+NPU burst/sustained policy check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    assert data is not None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "CPU+NPU burst/sustained policy check passed: "
        f"{OUT.relative_to(ROOT)} remains release-blocked."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
