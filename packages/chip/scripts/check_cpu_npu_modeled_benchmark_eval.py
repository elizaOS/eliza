#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml
from chip_utils import load_json_object, load_yaml_object, require_number

ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_REPORT = ROOT / "benchmarks/results/modeled-cpu-npu-2028-local/report.json"
OPTIMIZER_REPORT = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
TARGET_SPEC = ROOT / "docs/spec-db/npu-2028-target.yaml"
OUT = ROOT / "benchmarks/results/cpu-npu-2028-modeled-eval.json"


def result_by_name(report: dict[str, Any], name: str) -> dict[str, Any]:
    for row in report.get("results", []):
        if isinstance(row, dict) and row.get("name") == name:
            return row
    raise ValueError(f"{BENCHMARK_REPORT.relative_to(ROOT)} missing benchmark result {name}")


def evaluation_row(
    row_id: str,
    status: str,
    metric: float,
    threshold: float,
    comparator: str,
    evidence: str,
) -> dict[str, Any]:
    return {
        "id": row_id,
        "status": status,
        "metric": metric,
        "threshold": threshold,
        "comparator": comparator,
        "evidence": evidence,
    }


def build_eval() -> dict[str, Any]:
    benchmark = load_json_object(BENCHMARK_REPORT)
    optimizer = load_json_object(OPTIMIZER_REPORT)
    target = load_yaml_object(TARGET_SPEC)
    target_numbers = target.get("numeric_targets")
    if not isinstance(target_numbers, dict):
        raise ValueError("target spec missing numeric_targets")

    cpu = result_by_name(benchmark, "simulator_arch_metrics")
    cpu_sota = result_by_name(benchmark, "cpu_arch_sim_sota_2028")
    npu_first = result_by_name(benchmark, "npu_arch_sim_open_2028")
    npu_sota = result_by_name(benchmark, "npu_arch_sim_sota_2028")
    for row in (cpu, cpu_sota, npu_first, npu_sota):
        if row.get("status") != "passed":
            raise ValueError(f"{row.get('name')} must pass before modeled evaluation")
        if row.get("provenance") != "simulator":
            raise ValueError(f"{row.get('name')} must keep simulator provenance")

    cpu_metrics = cpu.get("metrics")
    cpu_sota_metrics = cpu_sota.get("metrics")
    first_metrics = npu_first.get("metrics")
    sota_metrics = npu_sota.get("metrics")
    if not isinstance(cpu_metrics, dict) or not isinstance(cpu_sota_metrics, dict):
        raise ValueError("benchmark report missing CPU parsed metrics")
    if not isinstance(first_metrics, dict):
        raise ValueError("benchmark report missing parsed metrics")
    if not isinstance(sota_metrics, dict):
        raise ValueError("benchmark report missing SOTA NPU parsed metrics")

    optimized = optimizer.get("optimized")
    robustness = optimizer.get("robustness")
    if not isinstance(optimized, dict) or not isinstance(optimized.get("summary"), dict):
        raise ValueError("optimizer report missing optimized summary")
    if not isinstance(robustness, dict) or not isinstance(robustness.get("summary"), dict):
        raise ValueError("optimizer report missing robustness summary")
    robust_summary = robustness["summary"]

    dense_target = require_number(target_numbers.get("dense_int8_peak_tops_min"), "dense target")
    sustained_target = require_number(
        target_numbers.get("dense_int8_sustained_tops_min"), "sustained target"
    )
    sparse_target = require_number(target_numbers.get("sparse_int4_peak_tops_min"), "sparse target")
    memory_target = require_number(
        target_numbers.get("external_memory_bandwidth_gbps_min"), "memory bandwidth target"
    )
    queue_depth_target = require_number(
        target_numbers.get("command_queue_depth_min"), "command queue depth target"
    )

    cpu_ipc = require_number(cpu_metrics.get("ipc"), "cpu ipc")
    cpu_power_w = require_number(cpu_metrics.get("estimated_package_power_w"), "cpu power")
    cpu_temp_c = require_number(cpu_metrics.get("estimated_die_temp_c"), "cpu temp")
    cpu_ipj = require_number(
        cpu_metrics.get("instructions_per_joule"), "cpu instructions_per_joule"
    )
    cpu_sota_ipc = require_number(cpu_sota_metrics.get("ipc"), "sota cpu ipc")
    cpu_sota_power_w = require_number(
        cpu_sota_metrics.get("estimated_package_power_w"), "sota cpu power"
    )
    cpu_sota_temp_c = require_number(cpu_sota_metrics.get("estimated_die_temp_c"), "sota cpu temp")
    cpu_sota_ipj = require_number(
        cpu_sota_metrics.get("instructions_per_joule"), "sota cpu instructions_per_joule"
    )
    cpu_sota_worst_ipc = require_number(
        cpu_sota_metrics.get("worst_process_corner_ipc"), "sota cpu worst ipc"
    )
    first_min_tops = require_number(first_metrics.get("min_observed_tops"), "first min TOPS")
    first_total_descriptors = require_number(
        first_metrics.get("total_descriptors_required"), "first NPU descriptors"
    )
    first_queue_passes = require_number(
        first_metrics.get("max_descriptor_queue_passes"), "first NPU queue passes"
    )
    first_dma_beats = require_number(first_metrics.get("total_dma_beats"), "first NPU DMA beats")
    sota_peak = require_number(sota_metrics.get("dense_int8_peak_tops"), "sota peak TOPS")
    sota_sparse = sota_peak * 4.0
    sota_min_tops = require_number(sota_metrics.get("min_observed_tops"), "sota min TOPS")
    sota_worst_tops = require_number(
        sota_metrics.get("worst_process_corner_min_observed_tops"), "sota worst TOPS"
    )
    sota_queue_depth = require_number(sota_metrics.get("dma_queue_depth"), "sota queue depth")
    sota_total_descriptors = require_number(
        sota_metrics.get("total_descriptors_required"), "sota NPU descriptors"
    )
    sota_queue_passes = require_number(
        sota_metrics.get("max_descriptor_queue_passes"), "sota NPU queue passes"
    )
    sota_dma_beats = require_number(sota_metrics.get("total_dma_beats"), "sota NPU DMA beats")
    memory_gbps = require_number(
        optimized.get("config", {}).get("memory_sustained_gbps"), "memory GB/s"
    )
    robust_margin = require_number(
        robust_summary.get("min_bandwidth_margin_gbps"), "robust bandwidth margin"
    )
    robust_temp = require_number(robust_summary.get("max_die_temp_c"), "robust max die temp")
    robust_power = require_number(robust_summary.get("max_total_power_w"), "robust max power")

    checks = [
        evaluation_row(
            "cpu_modeled_efficiency_pass",
            "pass" if cpu_ipc >= 1.5 and cpu_power_w <= 3.5 and cpu_temp_c <= 85.0 else "fail",
            cpu_ipj,
            1.0,
            ">",
            "CPU/AP deterministic architecture model reports positive efficiency inside modeled mobile power and thermal bounds.",
        ),
        evaluation_row(
            "cpu_sota_peak_model_pass",
            "pass"
            if cpu_sota_ipc >= 2.35 and cpu_sota_worst_ipc >= 2.0 and cpu_sota_temp_c <= 95.0
            else "fail",
            cpu_sota_ipc,
            2.35,
            ">=",
            "SOTA two-core CPU/AP model improves IPC/frequency headroom while keeping modeled die temperature inside the mobile limit.",
        ),
        evaluation_row(
            "cpu_sota_efficiency_not_regressed",
            "pass" if cpu_sota_ipj >= cpu_ipj * 0.85 and cpu_sota_power_w <= 5.0 else "fail",
            cpu_sota_ipj,
            cpu_ipj * 0.85,
            ">=",
            "SOTA CPU/AP model keeps efficiency within the allowed modeled headroom while preserving a phone-class power cap.",
        ),
        evaluation_row(
            "npu_first_open_model_pass",
            "pass"
            if first_min_tops >= 40.0
            and first_total_descriptors > 0.0
            and first_queue_passes >= 1.0
            and first_dma_beats > 0.0
            else "fail",
            first_min_tops,
            40.0,
            ">=",
            "First open 2028 NPU model remains a checked lower-complexity stepping stone with descriptor and DMA pressure metrics.",
        ),
        evaluation_row(
            "npu_sota_dense_peak_target_pass",
            "pass" if sota_peak >= dense_target else "fail",
            sota_peak,
            dense_target,
            ">=",
            "SOTA modeled NPU config is sized against the 2028 dense INT8 peak target.",
        ),
        evaluation_row(
            "npu_sota_sparse_int4_target_pass",
            "pass" if sota_sparse >= sparse_target else "fail",
            sota_sparse,
            sparse_target,
            ">=",
            "SOTA modeled NPU config projects packed structured-sparse INT4 capacity against the 2028 target.",
        ),
        evaluation_row(
            "npu_sota_sustained_model_gap",
            "blocked",
            min(sota_min_tops, sota_worst_tops),
            sustained_target,
            ">=",
            "Modeled sustained proxy meets the numeric target, but sustained TOPS/W remains blocked until measured power/thermal traces and PDK signoff exist.",
        ),
        evaluation_row(
            "npu_sota_descriptor_queue_model_pass",
            "pass"
            if sota_queue_depth >= queue_depth_target
            and sota_total_descriptors > 0.0
            and sota_queue_passes == 1.0
            and sota_dma_beats > 0.0
            else "fail",
            sota_queue_passes,
            1.0,
            "==",
            "SOTA modeled NPU workload fits in one modeled 1024+ entry queue pass while exposing positive descriptor and DMA beat pressure.",
        ),
        evaluation_row(
            "memory_model_target_pass",
            "pass" if memory_gbps >= memory_target and robust_margin > 0.0 else "fail",
            memory_gbps,
            memory_target,
            ">=",
            "Optimized SoC point keeps modeled memory bandwidth above the 2028 target with positive robust margin.",
        ),
        evaluation_row(
            "robust_power_thermal_model_pass",
            "pass"
            if robust_summary.get("pass") is True and robust_temp <= 95.0 and robust_power <= 5.0
            else "fail",
            robust_power,
            5.0,
            "<=",
            "Combined CPU+NPU robust guardband remains inside modeled mobile power and die-temperature limits.",
        ),
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    blocked = [row["id"] for row in checks if row["status"] == "blocked"]
    status = "fail" if failed else "modeled_eval_release_blocked" if blocked else "modeled_pass"
    return {
        "schema": "eliza.cpu_npu_2028_modeled_benchmark_eval.v1",
        "status": status,
        "claim_boundary": (
            "Simulator and deterministic architecture model evaluation only; not AOSP, RTL, "
            "PDK, sustained measured power/thermal, silicon, or phone-class release evidence."
        ),
        "source_artifacts": {
            "benchmark_report": str(BENCHMARK_REPORT.relative_to(ROOT)),
            "optimizer_report": str(OPTIMIZER_REPORT.relative_to(ROOT)),
            "target_spec": str(TARGET_SPEC.relative_to(ROOT)),
        },
        "modeled_metrics": {
            "cpu_ipc": cpu_ipc,
            "cpu_estimated_package_power_w": cpu_power_w,
            "cpu_estimated_die_temp_c": cpu_temp_c,
            "cpu_instructions_per_joule": cpu_ipj,
            "cpu_sota_ipc": cpu_sota_ipc,
            "cpu_sota_worst_process_corner_ipc": cpu_sota_worst_ipc,
            "cpu_sota_estimated_package_power_w": cpu_sota_power_w,
            "cpu_sota_estimated_die_temp_c": cpu_sota_temp_c,
            "cpu_sota_instructions_per_joule": cpu_sota_ipj,
            "npu_first_min_observed_tops": first_min_tops,
            "npu_first_total_descriptors_required": first_total_descriptors,
            "npu_first_max_descriptor_queue_passes": first_queue_passes,
            "npu_first_total_dma_beats": first_dma_beats,
            "npu_sota_dense_int8_peak_tops": sota_peak,
            "npu_sota_sparse_int4_projected_tops": sota_sparse,
            "npu_sota_min_observed_tops": sota_min_tops,
            "npu_sota_worst_process_corner_min_observed_tops": sota_worst_tops,
            "npu_sota_dma_queue_depth": sota_queue_depth,
            "npu_sota_total_descriptors_required": sota_total_descriptors,
            "npu_sota_max_descriptor_queue_passes": sota_queue_passes,
            "npu_sota_total_dma_beats": sota_dma_beats,
            "optimized_memory_sustained_gbps": memory_gbps,
            "robust_max_total_power_w": robust_power,
            "robust_max_die_temp_c": robust_temp,
            "robust_min_bandwidth_margin_gbps": robust_margin,
        },
        "target_metrics": {
            "dense_int8_peak_tops_min": dense_target,
            "dense_int8_sustained_tops_min": sustained_target,
            "sparse_int4_peak_tops_min": sparse_target,
            "external_memory_bandwidth_gbps_min": memory_target,
            "command_queue_depth_min": queue_depth_target,
        },
        "checks": checks,
        "release_claim_forbidden_until": [
            "AOSP simulator boots locally with archived virtual-device evidence.",
            "NNAPI or successor runtime proof shows real e1-npu accelerator selection with zero CPU fallback.",
            "Target benchmark binaries run with calibrated clock, power, thermal, memory, and process metadata.",
            "Sustained power/thermal traces prove TOPS/W and no-throttle behavior.",
            "14A PDK extracted timing, power, IR/EM, and thermal signoff replaces planning derates.",
        ],
    }


def validate_eval(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_modeled_benchmark_eval.v1":
        errors.append("schema mismatch")
    if data.get("status") not in {"modeled_eval_release_blocked", "modeled_pass"}:
        errors.append("modeled evaluation must not fail")
    if "not AOSP" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block AOSP evidence use")
    checks = data.get("checks")
    if not isinstance(checks, list) or len(checks) < 10:
        errors.append("checks must list the modeled CPU/NPU/memory/power evaluations")
        return errors
    by_id = {row.get("id"): row for row in checks if isinstance(row, dict)}
    required = {
        "cpu_modeled_efficiency_pass",
        "cpu_sota_peak_model_pass",
        "cpu_sota_efficiency_not_regressed",
        "npu_first_open_model_pass",
        "npu_sota_dense_peak_target_pass",
        "npu_sota_sparse_int4_target_pass",
        "npu_sota_sustained_model_gap",
        "npu_sota_descriptor_queue_model_pass",
        "memory_model_target_pass",
        "robust_power_thermal_model_pass",
    }
    missing = sorted(required - set(by_id))
    if missing:
        errors.append("missing checks: " + ", ".join(missing))
    for row_id in required - {"npu_sota_sustained_model_gap"}:
        if by_id.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    if by_id.get("npu_sota_sustained_model_gap", {}).get("status") not in {"blocked", "pass"}:
        errors.append("npu_sota_sustained_model_gap must be blocked or pass")
    return errors


def main() -> int:
    try:
        data = build_eval()
        errors = validate_eval(data)
    except (OSError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        errors = [str(exc)]
        data = None
    if errors:
        print("CPU+NPU modeled benchmark evaluation failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    assert data is not None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "CPU+NPU modeled benchmark evaluation passed: "
        f"{OUT.relative_to(ROOT)} remains release-blocked."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
