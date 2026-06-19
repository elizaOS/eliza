#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require_number

ROOT = Path(__file__).resolve().parents[1]
PROCESS_SPEC = ROOT / "docs/spec-db/process-14a-effects.yaml"
OPTIMIZER = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
MODELED_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-modeled-eval.json"
BURST_POLICY = ROOT / "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json"
BURST_TRANSIENT = ROOT / "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json"
AOSP_TRACE = ROOT / "benchmarks/results/cpu-npu-2028-aosp-governor-trace.json"
OUT = ROOT / "benchmarks/results/cpu-npu-2028-14a-process-eval.json"

REQUIRED_EFFECT_IDS = {
    "node_identity_and_pdk_binding",
    "nanosheet_device_variability",
    "frontside_vs_backside_power_delivery",
    "interconnect_rc_and_congestion",
    "self_heating_and_power_density",
    "sram_density_vmin_and_ecc",
    "reliability_aging_and_lifetime",
    "dft_yield_and_debug_lock",
}

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "pdk_signoff_claim_allowed": False,
    "physical_signoff_claim_allowed": False,
    "manufacturing_claim_allowed": False,
    "reliability_qualification_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def check_row(row_id: str, status: str, evidence: str) -> dict[str, str]:
    return {"id": row_id, "status": status, "evidence": evidence}


def effect_row(
    effect_id: str,
    *,
    status: str,
    modeled_derates: dict[str, float],
    guardband_result: dict[str, float | str],
    evidence_gap: str,
) -> dict[str, Any]:
    return {
        "id": effect_id,
        "status": status,
        "modeled_derates": modeled_derates,
        "guardband_result": guardband_result,
        "evidence_gap": evidence_gap,
        "release_use": "forbidden_model_only",
    }


def build_report() -> dict[str, Any]:
    process_spec = load_yaml_object(PROCESS_SPEC)
    optimizer = load_json_object(OPTIMIZER)
    modeled_eval = load_json_object(MODELED_EVAL)
    policy = load_json_object(BURST_POLICY)
    transient = load_json_object(BURST_TRANSIENT)
    aosp_trace = load_json_object(AOSP_TRACE)

    effects = process_spec.get("required_effects")
    if not isinstance(effects, list):
        raise ValueError("process spec missing required_effects")
    effect_ids = {item.get("id") for item in effects if isinstance(item, dict)}
    missing_effects = sorted(REQUIRED_EFFECT_IDS - effect_ids)
    if missing_effects:
        raise ValueError("process spec missing required effects: " + ", ".join(missing_effects))

    robustness = optimizer.get("robustness")
    optimized = optimizer.get("optimized")
    if not isinstance(robustness, dict) or not isinstance(robustness.get("summary"), dict):
        raise ValueError("optimizer missing robustness summary")
    if not isinstance(optimized, dict) or not isinstance(optimized.get("summary"), dict):
        raise ValueError("optimizer missing optimized summary")
    robust_summary = robustness["summary"]
    opt_summary = optimized["summary"]
    metrics = modeled_eval.get("modeled_metrics")
    sustained = policy.get("sustained_policy")
    burst = policy.get("burst_policy")
    transient_recommended = transient.get("recommended")
    trace_summary = aosp_trace.get("summary")
    if not isinstance(metrics, dict):
        raise ValueError("modeled eval missing modeled_metrics")
    if not isinstance(sustained, dict) or not isinstance(burst, dict):
        raise ValueError("burst policy missing policy sections")
    if not isinstance(transient_recommended, dict):
        raise ValueError("burst transient missing recommended section")
    if not isinstance(trace_summary, dict):
        raise ValueError("AOSP governor trace missing summary")

    robust_min_tops = require_number(robust_summary.get("min_npu_int8_tops"), "robust NPU TOPS")
    robust_power = require_number(robust_summary.get("max_total_power_w"), "robust power")
    robust_temp = require_number(robust_summary.get("max_die_temp_c"), "robust temperature")
    robust_bandwidth_margin = require_number(
        robust_summary.get("min_bandwidth_margin_gbps"), "robust bandwidth margin"
    )
    nominal_perf_w = require_number(
        opt_summary.get("min_composite_perf_per_w"), "nominal composite perf/W"
    )
    cpu_sota_ipc = require_number(metrics.get("cpu_sota_ipc"), "SOTA CPU IPC")
    cpu_sota_power = require_number(
        metrics.get("cpu_sota_estimated_package_power_w"), "SOTA CPU power"
    )
    npu_sota_dense = require_number(metrics.get("npu_sota_dense_int8_peak_tops"), "SOTA NPU dense")
    npu_sota_worst = require_number(
        metrics.get("npu_sota_worst_process_corner_min_observed_tops"), "SOTA NPU worst"
    )
    burst_duration = require_number(
        transient_recommended.get("modeled_recommended_burst_duration_s"), "burst duration"
    )
    trace_max_temp = require_number(trace_summary.get("max_die_temp_c"), "trace max die")
    sustained_power = require_number(sustained.get("robust_max_total_power_w"), "sustained power")
    burst_power = require_number(burst.get("estimated_package_power_cap_w"), "burst package power")

    effect_results = [
        effect_row(
            "node_identity_and_pdk_binding",
            status="blocked",
            modeled_derates={"timing_uncertainty": 0.08, "power_uncertainty": 0.07},
            guardband_result={
                "selected_process_option": "blocked_until_foundry_pdk_and_library_selection",
                "library_binding": "missing",
            },
            evidence_gap="Foundry PDK, library, and selected corner manifest are absent.",
        ),
        effect_row(
            "nanosheet_device_variability",
            status="pass",
            modeled_derates={"cpu_ipc_scale": 0.94, "npu_tops_scale": 0.95, "leakage_scale": 1.05},
            guardband_result={
                "cpu_sota_worst_ipc": cpu_sota_ipc * 0.94,
                "npu_robust_min_tops": robust_min_tops * 0.95,
                "estimated_power_w": robust_power * 1.05,
            },
            evidence_gap="Local variation and Vmin curves still require selected PDK data.",
        ),
        effect_row(
            "frontside_vs_backside_power_delivery",
            status="pass",
            modeled_derates={"frontside_ir_power_scale": 1.04, "backside_option_power_scale": 0.96},
            guardband_result={
                "frontside_sustained_power_w": sustained_power * 1.04,
                "backside_modeled_sustained_power_w": sustained_power * 0.96,
                "frontside_vs_backside_variant": "modeled_tradeoff_only",
            },
            evidence_gap="IR/EM and routing tradeoffs need extracted frontside/backside PDN variants.",
        ),
        effect_row(
            "interconnect_rc_and_congestion",
            status="pass",
            modeled_derates={
                "cpu_ipc_scale": 0.97,
                "npu_tops_scale": 0.98,
                "bandwidth_margin_penalty_gbps": 0.10,
            },
            guardband_result={
                "cpu_sota_rc_ipc": cpu_sota_ipc * 0.97,
                "npu_worst_rc_tops": npu_sota_worst * 0.98,
                "remaining_bandwidth_margin_gbps": robust_bandwidth_margin - 0.10,
            },
            evidence_gap="Extracted RC, via resistance, and route congestion are absent.",
        ),
        effect_row(
            "self_heating_and_power_density",
            status="pass",
            modeled_derates={"hotspot_temp_add_c": 2.2, "burst_duration_scale": 0.90},
            guardband_result={
                "governor_trace_hotspot_max_die_c": trace_max_temp + 2.2,
                "scaled_burst_duration_s": burst_duration * 0.90,
                "burst_package_power_w": burst_power,
            },
            evidence_gap="Measured die/package/skin thermal correlation is absent.",
        ),
        effect_row(
            "sram_density_vmin_and_ecc",
            status="pass",
            modeled_derates={"sram_vmin_frequency_scale": 0.98, "ecc_energy_scale": 1.015},
            guardband_result={
                "npu_dense_with_sram_vmin_tops": npu_sota_dense * 0.98,
                "npu_power_with_ecc_w": require_number(
                    burst.get("npu_burst_power_cap_w"), "NPU burst power"
                )
                * 1.015,
                "ecc_policy": "required_for_cache_and_npu_local_sram",
            },
            evidence_gap="SRAM compiler Vmin, BIST, repair, and ECC signoff are absent.",
        ),
        effect_row(
            "reliability_aging_and_lifetime",
            status="pass",
            modeled_derates={
                "cpu_lifetime_frequency_scale": 0.97,
                "npu_lifetime_tops_scale": 0.96,
                "power_scale": 1.03,
            },
            guardband_result={
                "cpu_sota_lifetime_ipc_proxy": cpu_sota_ipc * 0.97,
                "npu_lifetime_min_tops": robust_min_tops * 0.96,
                "sustained_power_lifetime_w": robust_power * 1.03,
            },
            evidence_gap="BTI/HCI/TDDB/EM lifetime signoff and mission profiles are absent.",
        ),
        effect_row(
            "dft_yield_and_debug_lock",
            status="blocked",
            modeled_derates={"test_area_scale": 1.03, "mbist_energy_scale": 1.01},
            guardband_result={
                "scan_mbist_status": "architecture_requirement_only",
                "secure_debug_lock_status": "requires_lifecycle_evidence",
            },
            evidence_gap="Scan, MBIST, repair fuse, yield learning, and secure-debug evidence are absent.",
        ),
    ]

    by_id = {item["id"]: item for item in effect_results}
    checks = [
        check_row(
            "all_required_14a_effects_modeled",
            "pass" if set(by_id) >= REQUIRED_EFFECT_IDS else "fail",
            "Every required process-effect category has a CPU/NPU modeled row.",
        ),
        check_row(
            "modeled_effects_preserve_sustained_guardband",
            "pass"
            if by_id["interconnect_rc_and_congestion"]["guardband_result"][
                "remaining_bandwidth_margin_gbps"
            ]
            > 0.0
            and by_id["nanosheet_device_variability"]["guardband_result"]["estimated_power_w"]
            <= 5.0
            and by_id["reliability_aging_and_lifetime"]["guardband_result"][
                "sustained_power_lifetime_w"
            ]
            <= 5.0
            and by_id["self_heating_and_power_density"]["guardband_result"][
                "governor_trace_hotspot_max_die_c"
            ]
            < 95.0
            else "fail",
            "Modeled 14A process derates preserve sustained power, bandwidth, and thermal guardbands.",
        ),
        check_row(
            "modeled_sota_headroom_after_process_derates",
            "pass"
            if by_id["sram_density_vmin_and_ecc"]["guardband_result"][
                "npu_dense_with_sram_vmin_tops"
            ]
            >= 160.0
            and by_id["nanosheet_device_variability"]["guardband_result"]["cpu_sota_worst_ipc"]
            >= 2.25
            else "fail",
            "SOTA modeled CPU/NPU headroom remains above planning targets after process derates.",
        ),
        check_row(
            "pdk_signoff_release_blocked",
            "blocked",
            "Modeled process effects cannot replace selected 14A PDK, extracted RC, IR/EM, thermal, reliability, DFT, and signoff evidence.",
        ),
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    blocked = [row["id"] for row in checks if row["status"] == "blocked"]
    return {
        "schema": "eliza.cpu_npu_2028_14a_process_eval.v1",
        "status": "fail"
        if failed
        else "modeled_process_eval_release_blocked"
        if blocked
        else "pass",
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Deterministic CPU/NPU 14A process-effects evaluation only; not PDK, extracted "
            "parasitics, physical signoff, manufacturing, reliability qualification, or tapeout evidence."
        ),
        "source_artifacts": {
            "process_spec": str(PROCESS_SPEC.relative_to(ROOT)),
            "optimizer_report": str(OPTIMIZER.relative_to(ROOT)),
            "modeled_eval": str(MODELED_EVAL.relative_to(ROOT)),
            "burst_sustained_policy": str(BURST_POLICY.relative_to(ROOT)),
            "burst_thermal_transient": str(BURST_TRANSIENT.relative_to(ROOT)),
            "aosp_governor_trace": str(AOSP_TRACE.relative_to(ROOT)),
        },
        "baseline_metrics": {
            "cpu_sota_ipc": cpu_sota_ipc,
            "cpu_sota_estimated_power_w": cpu_sota_power,
            "npu_sota_dense_int8_peak_tops": npu_sota_dense,
            "npu_sota_worst_process_corner_min_tops": npu_sota_worst,
            "robust_min_npu_int8_tops": robust_min_tops,
            "robust_max_total_power_w": robust_power,
            "robust_max_die_temp_c": robust_temp,
            "nominal_min_composite_perf_per_w": nominal_perf_w,
        },
        "effect_results": effect_results,
        "checks": checks,
        "release_claim_forbidden_until": [
            "Selected foundry 14A PDK and library manifest exists.",
            "Extracted timing, RC, IR/EM, thermal, SRAM Vmin, DFT, and reliability reports exist.",
            "Workload-correlated measured power/thermal traces replace model constants.",
            "Physical signoff and manufacturing readiness gates pass for the selected CPU/NPU implementation.",
        ],
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_14a_process_eval.v1":
        errors.append("schema mismatch")
    if data.get("status") != "modeled_process_eval_release_blocked":
        errors.append("process eval must remain modeled_process_eval_release_blocked")
    if "not PDK" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block PDK/signoff claims")
    for flag in FALSE_CLAIM_FLAGS:
        if data.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")
    effect_results = data.get("effect_results")
    if not isinstance(effect_results, list):
        errors.append("effect_results must be a list")
        return errors
    by_id = {item.get("id"): item for item in effect_results if isinstance(item, dict)}
    missing = sorted(REQUIRED_EFFECT_IDS - set(by_id))
    if missing:
        errors.append("missing modeled process effects: " + ", ".join(missing))
    for effect_id, item in by_id.items():
        if item.get("release_use") != "forbidden_model_only":
            errors.append(f"{effect_id}: release_use must remain forbidden")
        if item.get("status") not in {"pass", "blocked"}:
            errors.append(f"{effect_id}: status must be pass or blocked")
        if not isinstance(item.get("modeled_derates"), dict):
            errors.append(f"{effect_id}: missing modeled_derates")
        if not isinstance(item.get("guardband_result"), dict):
            errors.append(f"{effect_id}: missing guardband_result")
        if not isinstance(item.get("evidence_gap"), str) or len(item["evidence_gap"]) < 20:
            errors.append(f"{effect_id}: missing evidence gap")
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be a list")
        return errors
    by_check = {row.get("id"): row for row in checks if isinstance(row, dict)}
    for row_id in (
        "all_required_14a_effects_modeled",
        "modeled_effects_preserve_sustained_guardband",
        "modeled_sota_headroom_after_process_derates",
    ):
        if by_check.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    if by_check.get("pdk_signoff_release_blocked", {}).get("status") != "blocked":
        errors.append("pdk_signoff_release_blocked must remain blocked")
    return errors


def main() -> int:
    try:
        data = build_report()
        errors = validate_report(data)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        data = None
        errors = [str(exc)]
    if errors:
        print("CPU+NPU 14A process eval failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    assert data is not None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"CPU+NPU 14A process eval passed: {OUT.relative_to(ROOT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
