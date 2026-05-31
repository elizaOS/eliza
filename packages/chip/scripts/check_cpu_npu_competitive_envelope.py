#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, require_number

ROOT = Path(__file__).resolve().parents[1]
MODELED_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-modeled-eval.json"
PROCESS_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-14a-process-eval.json"
BURST_POLICY = ROOT / "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json"
BURST_TRANSIENT = ROOT / "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json"
AOSP_TRACE = ROOT / "benchmarks/results/cpu-npu-2028-aosp-governor-trace.json"
OUT = ROOT / "benchmarks/results/cpu-npu-2028-competitive-envelope.json"

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "phone_class_release_claim_allowed": False,
    "measured_benchmark_claim_allowed": False,
    "google_pixel_product_claim_allowed": False,
    "purchasing_comparison_claim_allowed": False,
    "aosp_runtime_claim_allowed": False,
    "pdk_signoff_claim_allowed": False,
    "silicon_claim_allowed": False,
}

PLANNING_TARGETS = {
    "cpu_sota_ipc_min": 2.35,
    "cpu_process_derated_ipc_min": 2.25,
    "cpu_instructions_per_joule_min": 7.0e9,
    "npu_dense_int8_peak_tops_min": 160.0,
    "npu_process_derated_dense_tops_min": 160.0,
    "npu_sparse_int4_peak_tops_min": 512.0,
    "npu_worst_corner_tops_min": 80.0,
    "memory_sustained_gbps_min": 180.0,
    "sustained_package_power_w_max": 5.0,
    "burst_package_power_w_max": 12.5,
    "burst_hotspot_die_c_max": 95.0,
    "modeled_burst_duration_s_min": 2.0,
}


def check_row(
    row_id: str,
    *,
    status: str,
    metric: float,
    comparator: str,
    threshold: float,
    evidence: str,
) -> dict[str, Any]:
    return {
        "id": row_id,
        "status": status,
        "metric": metric,
        "comparator": comparator,
        "threshold": threshold,
        "evidence": evidence,
    }


def compare(metric: float, comparator: str, threshold: float) -> bool:
    if comparator == ">=":
        return metric >= threshold
    if comparator == "<=":
        return metric <= threshold
    raise ValueError(f"unsupported comparator: {comparator}")


def effect_result(process_eval: dict[str, Any], effect_id: str) -> dict[str, Any]:
    effects = process_eval.get("effect_results")
    if not isinstance(effects, list):
        raise ValueError("process eval missing effect_results")
    matches = [item for item in effects if isinstance(item, dict) and item.get("id") == effect_id]
    if len(matches) != 1:
        raise ValueError(f"process eval must contain one {effect_id} row")
    result = matches[0].get("guardband_result")
    if not isinstance(result, dict):
        raise ValueError(f"{effect_id} missing guardband_result")
    return result


def build_report() -> dict[str, Any]:
    modeled_eval = load_json_object(MODELED_EVAL)
    process_eval = load_json_object(PROCESS_EVAL)
    burst_policy = load_json_object(BURST_POLICY)
    burst_transient = load_json_object(BURST_TRANSIENT)
    aosp_trace = load_json_object(AOSP_TRACE)

    metrics = modeled_eval.get("modeled_metrics")
    sustained = burst_policy.get("sustained_policy")
    burst = burst_policy.get("burst_policy")
    transient_recommended = burst_transient.get("recommended")
    trace_summary = aosp_trace.get("summary")
    if not isinstance(metrics, dict):
        raise ValueError("modeled eval missing modeled_metrics")
    if not isinstance(sustained, dict) or not isinstance(burst, dict):
        raise ValueError("burst policy missing sustained/burst sections")
    if not isinstance(transient_recommended, dict):
        raise ValueError("burst transient missing recommended section")
    if not isinstance(trace_summary, dict):
        raise ValueError("AOSP trace missing summary")

    nanosheet = effect_result(process_eval, "nanosheet_device_variability")
    sram = effect_result(process_eval, "sram_density_vmin_and_ecc")
    self_heating = effect_result(process_eval, "self_heating_and_power_density")
    interconnect = effect_result(process_eval, "interconnect_rc_and_congestion")

    envelope_metrics = {
        "cpu_sota_ipc": require_number(metrics.get("cpu_sota_ipc"), "CPU SOTA IPC"),
        "cpu_process_derated_ipc": require_number(
            nanosheet.get("cpu_sota_worst_ipc"), "process derated CPU IPC"
        ),
        "cpu_instructions_per_joule": require_number(
            metrics.get("cpu_sota_instructions_per_joule"), "CPU SOTA instructions/J"
        ),
        "npu_dense_int8_peak_tops": require_number(
            metrics.get("npu_sota_dense_int8_peak_tops"), "NPU dense peak"
        ),
        "npu_process_derated_dense_tops": require_number(
            sram.get("npu_dense_with_sram_vmin_tops"), "process derated dense TOPS"
        ),
        "npu_sparse_int4_peak_tops": require_number(
            metrics.get("npu_sota_sparse_int4_projected_tops"), "NPU sparse peak"
        ),
        "npu_worst_corner_tops": require_number(
            metrics.get("npu_sota_worst_process_corner_min_observed_tops"), "NPU worst corner"
        ),
        "memory_sustained_gbps": require_number(
            metrics.get("optimized_memory_sustained_gbps"), "sustained memory bandwidth"
        ),
        "remaining_memory_margin_after_rc_gbps": require_number(
            interconnect.get("remaining_bandwidth_margin_gbps"), "RC memory margin"
        ),
        "sustained_package_power_w": require_number(
            sustained.get("robust_max_total_power_w"), "sustained package power"
        ),
        "burst_package_power_w": require_number(
            burst.get("estimated_package_power_cap_w"), "burst package power"
        ),
        "burst_hotspot_die_c": require_number(
            self_heating.get("governor_trace_hotspot_max_die_c"), "burst hotspot die"
        ),
        "modeled_burst_duration_s": require_number(
            transient_recommended.get("modeled_recommended_burst_duration_s"),
            "modeled burst duration",
        ),
        "governor_trace_max_die_c": require_number(
            trace_summary.get("max_die_temp_c"), "trace max die"
        ),
    }

    checks = [
        check_row(
            "cpu_peak_envelope_pass",
            status="pass"
            if compare(envelope_metrics["cpu_sota_ipc"], ">=", PLANNING_TARGETS["cpu_sota_ipc_min"])
            else "fail",
            metric=envelope_metrics["cpu_sota_ipc"],
            comparator=">=",
            threshold=PLANNING_TARGETS["cpu_sota_ipc_min"],
            evidence="SOTA modeled CPU IPC clears the 2028 compact flagship planning envelope.",
        ),
        check_row(
            "cpu_process_derated_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["cpu_process_derated_ipc"],
                ">=",
                PLANNING_TARGETS["cpu_process_derated_ipc_min"],
            )
            else "fail",
            metric=envelope_metrics["cpu_process_derated_ipc"],
            comparator=">=",
            threshold=PLANNING_TARGETS["cpu_process_derated_ipc_min"],
            evidence="CPU headroom remains above the process-derated planning threshold.",
        ),
        check_row(
            "cpu_efficiency_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["cpu_instructions_per_joule"],
                ">=",
                PLANNING_TARGETS["cpu_instructions_per_joule_min"],
            )
            else "fail",
            metric=envelope_metrics["cpu_instructions_per_joule"],
            comparator=">=",
            threshold=PLANNING_TARGETS["cpu_instructions_per_joule_min"],
            evidence="Modeled CPU efficiency clears the local 2028 planning envelope.",
        ),
        check_row(
            "npu_peak_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["npu_dense_int8_peak_tops"],
                ">=",
                PLANNING_TARGETS["npu_dense_int8_peak_tops_min"],
            )
            else "fail",
            metric=envelope_metrics["npu_dense_int8_peak_tops"],
            comparator=">=",
            threshold=PLANNING_TARGETS["npu_dense_int8_peak_tops_min"],
            evidence="Dense INT8 modeled NPU peak clears the 2028 planning envelope.",
        ),
        check_row(
            "npu_process_derated_peak_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["npu_process_derated_dense_tops"],
                ">=",
                PLANNING_TARGETS["npu_process_derated_dense_tops_min"],
            )
            else "fail",
            metric=envelope_metrics["npu_process_derated_dense_tops"],
            comparator=">=",
            threshold=PLANNING_TARGETS["npu_process_derated_dense_tops_min"],
            evidence="NPU peak remains above target after SRAM Vmin/ECC process derate.",
        ),
        check_row(
            "npu_sparse_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["npu_sparse_int4_peak_tops"],
                ">=",
                PLANNING_TARGETS["npu_sparse_int4_peak_tops_min"],
            )
            else "fail",
            metric=envelope_metrics["npu_sparse_int4_peak_tops"],
            comparator=">=",
            threshold=PLANNING_TARGETS["npu_sparse_int4_peak_tops_min"],
            evidence="Sparse INT4 modeled NPU headroom clears the planning envelope.",
        ),
        check_row(
            "npu_worst_corner_envelope_blocked",
            status="blocked"
            if compare(
                envelope_metrics["npu_worst_corner_tops"],
                ">=",
                PLANNING_TARGETS["npu_worst_corner_tops_min"],
            )
            else "fail",
            metric=envelope_metrics["npu_worst_corner_tops"],
            comparator=">=",
            threshold=PLANNING_TARGETS["npu_worst_corner_tops_min"],
            evidence="Worst-corner modeled NPU TOPS clears the numeric threshold, but sustained use remains blocked until measured TOPS/W evidence exists.",
        ),
        check_row(
            "memory_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["memory_sustained_gbps"],
                ">=",
                PLANNING_TARGETS["memory_sustained_gbps_min"],
            )
            and envelope_metrics["remaining_memory_margin_after_rc_gbps"] > 0.0
            else "fail",
            metric=envelope_metrics["memory_sustained_gbps"],
            comparator=">=",
            threshold=PLANNING_TARGETS["memory_sustained_gbps_min"],
            evidence="Modeled memory bandwidth clears the planning envelope and keeps positive RC-derated margin.",
        ),
        check_row(
            "sustained_power_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["sustained_package_power_w"],
                "<=",
                PLANNING_TARGETS["sustained_package_power_w_max"],
            )
            else "fail",
            metric=envelope_metrics["sustained_package_power_w"],
            comparator="<=",
            threshold=PLANNING_TARGETS["sustained_package_power_w_max"],
            evidence="Robust sustained package power remains inside the mobile planning envelope.",
        ),
        check_row(
            "burst_power_thermal_envelope_pass",
            status="pass"
            if compare(
                envelope_metrics["burst_package_power_w"],
                "<=",
                PLANNING_TARGETS["burst_package_power_w_max"],
            )
            and compare(
                envelope_metrics["burst_hotspot_die_c"],
                "<=",
                PLANNING_TARGETS["burst_hotspot_die_c_max"],
            )
            and compare(
                envelope_metrics["modeled_burst_duration_s"],
                ">=",
                PLANNING_TARGETS["modeled_burst_duration_s_min"],
            )
            else "fail",
            metric=envelope_metrics["burst_hotspot_die_c"],
            comparator="<=",
            threshold=PLANNING_TARGETS["burst_hotspot_die_c_max"],
            evidence="Burst power, hotspot temperature, and modeled duration fit the compact flagship planning envelope.",
        ),
        check_row(
            "future_pixel_comparison_release_blocked",
            status="blocked",
            metric=0.0,
            comparator=">=",
            threshold=0.0,
            evidence="This is a local 2028 Pixel-class planning envelope only; it is not a comparison against an unreleased Google Pixel product.",
        ),
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    blocked = [row["id"] for row in checks if row["status"] == "blocked"]
    return {
        "schema": "eliza.cpu_npu_2028_competitive_envelope.v1",
        "status": "fail"
        if failed
        else "modeled_competitive_envelope_release_blocked"
        if blocked
        else "pass",
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Local 2028 compact flagship planning envelope only; not measured benchmark evidence, "
            "not a Google Pixel product claim, and not a release or purchasing comparison."
        ),
        "source_artifacts": {
            "modeled_eval": str(MODELED_EVAL.relative_to(ROOT)),
            "process_eval": str(PROCESS_EVAL.relative_to(ROOT)),
            "burst_sustained_policy": str(BURST_POLICY.relative_to(ROOT)),
            "burst_thermal_transient": str(BURST_TRANSIENT.relative_to(ROOT)),
            "aosp_governor_trace": str(AOSP_TRACE.relative_to(ROOT)),
        },
        "planning_targets": PLANNING_TARGETS,
        "envelope_metrics": envelope_metrics,
        "checks": checks,
        "release_claim_forbidden_until": [
            "A real target benchmark run exists with calibrated clock, power, thermal, and process metadata.",
            "Local AOSP simulator evidence proves CPU/NPU scheduler, NNAPI, and thermal behavior.",
            "Measured sustained power/thermal traces prove TOPS/W and no-throttle operation.",
            "Selected 14A PDK and physical signoff replace planning derates.",
            "Any comparison to a named commercial product uses released, cited, like-for-like measurements.",
        ],
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_competitive_envelope.v1":
        errors.append("schema mismatch")
    if data.get("status") != "modeled_competitive_envelope_release_blocked":
        errors.append(
            "competitive envelope must remain modeled_competitive_envelope_release_blocked"
        )
    if "not a Google Pixel product claim" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block Google Pixel product claims")
    for flag in FALSE_CLAIM_FLAGS:
        if data.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")
    metrics = data.get("envelope_metrics")
    if not isinstance(metrics, dict):
        errors.append("envelope_metrics must be a mapping")
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be a list")
        return errors
    by_id = {row.get("id"): row for row in checks if isinstance(row, dict)}
    pass_rows = (
        "cpu_peak_envelope_pass",
        "cpu_process_derated_envelope_pass",
        "cpu_efficiency_envelope_pass",
        "npu_peak_envelope_pass",
        "npu_process_derated_peak_envelope_pass",
        "npu_sparse_envelope_pass",
        "memory_envelope_pass",
        "sustained_power_envelope_pass",
        "burst_power_thermal_envelope_pass",
    )
    for row_id in pass_rows:
        if by_id.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    for row_id in ("npu_worst_corner_envelope_blocked", "future_pixel_comparison_release_blocked"):
        if by_id.get(row_id, {}).get("status") != "blocked":
            errors.append(f"{row_id} must remain blocked")
    return errors


def main() -> int:
    try:
        data = build_report()
        errors = validate_report(data)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        data = None
        errors = [str(exc)]
    if errors:
        print("CPU+NPU competitive envelope check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    assert data is not None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "CPU+NPU competitive envelope check passed: "
        f"{OUT.relative_to(ROOT)} remains release-blocked."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
