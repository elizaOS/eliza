#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, require_number

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json"
TRANSIENT = ROOT / "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json"
OUT = ROOT / "benchmarks/results/cpu-npu-2028-aosp-governor-trace.json"
MAX_DIE_C = 95.0
BURST_ENTRY_DIE_C = 93.0
COOLDOWN_EXIT_DIE_C = 90.0

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "local_aosp_runtime_claim_allowed": False,
    "cuttlefish_claim_allowed": False,
    "qemu_claim_allowed": False,
    "renode_claim_allowed": False,
    "android_framework_claim_allowed": False,
    "kernel_thermal_claim_allowed": False,
    "device_evidence_claim_allowed": False,
}


def check_row(row_id: str, status: str, evidence: str) -> dict[str, str]:
    return {"id": row_id, "status": status, "evidence": evidence}


def thermal_status(die_c: float) -> str:
    if die_c >= 95.0:
        return "shutdown"
    if die_c >= 93.0:
        return "severe"
    if die_c >= 90.0:
        return "moderate"
    if die_c >= 85.0:
        return "light"
    return "none"


def sample(
    time_s: float,
    *,
    workload: str,
    governor_state: str,
    cpu_power_w: float,
    npu_power_w: float,
    package_power_w: float,
    die_temp_c: float,
    scheduler_hint: str,
    thermal_hal_action: str,
) -> dict[str, Any]:
    return {
        "time_s": time_s,
        "workload": workload,
        "governor_state": governor_state,
        "cpu_power_w": cpu_power_w,
        "npu_power_w": npu_power_w,
        "package_power_w": package_power_w,
        "die_temp_c": die_temp_c,
        "thermal_status": thermal_status(die_temp_c),
        "scheduler_hint": scheduler_hint,
        "thermal_hal_action": thermal_hal_action,
    }


def build_report() -> dict[str, Any]:
    policy = load_json_object(POLICY)
    transient = load_json_object(TRANSIENT)
    sustained = policy.get("sustained_policy")
    burst = policy.get("burst_policy")
    recommended = transient.get("recommended")
    if not isinstance(sustained, dict) or not isinstance(burst, dict):
        raise ValueError("policy missing sustained or burst policy")
    if not isinstance(recommended, dict):
        raise ValueError("transient report missing recommended section")

    sustained_cpu_w = require_number(sustained.get("cpu_base_power_w"), "sustained CPU power")
    sustained_npu_w = require_number(sustained.get("npu_base_power_w"), "sustained NPU power")
    sustained_pkg_w = require_number(
        sustained.get("robust_max_total_power_w"), "sustained package power"
    )
    sustained_die_c = require_number(
        sustained.get("robust_max_die_temp_c"), "sustained die temperature"
    )
    burst_cpu_w = require_number(burst.get("cpu_sota_estimated_power_w"), "burst CPU power")
    burst_npu_w = require_number(burst.get("npu_burst_power_cap_w"), "burst NPU power")
    burst_pkg_w = require_number(burst.get("estimated_package_power_cap_w"), "burst package power")
    burst_duration_s = require_number(
        recommended.get("modeled_recommended_burst_duration_s"), "modeled burst duration"
    )
    recommended_temps = recommended.get("temperature_at_recommended")
    if not isinstance(recommended_temps, list):
        raise ValueError("transient report missing temperature_at_recommended list")
    hot_temp_rows = [
        row
        for row in recommended_temps
        if isinstance(row, dict) and row.get("id") == "hot_ambient_guardband"
    ]
    if len(hot_temp_rows) != 1:
        raise ValueError("transient report must include one hot_ambient_guardband temperature")
    burst_exit_die_c = require_number(
        hot_temp_rows[0].get("die_temp_at_recommended_s_c"),
        "hot ambient die temperature at recommended burst",
    )

    trace = [
        sample(
            0.0,
            workload="screen_on_idle",
            governor_state="idle_floor",
            cpu_power_w=0.42,
            npu_power_w=0.0,
            package_power_w=1.15,
            die_temp_c=42.0,
            scheduler_hint="schedutil_idle_bias",
            thermal_hal_action="THERMAL_STATUS_NONE",
        ),
        sample(
            10.0,
            workload="camera_preview_ai_sustained",
            governor_state="sustained_no_throttle_modeled",
            cpu_power_w=sustained_cpu_w,
            npu_power_w=sustained_npu_w,
            package_power_w=sustained_pkg_w,
            die_temp_c=82.0,
            scheduler_hint="prefer_efficiency_cores_keep_npu_sustained",
            thermal_hal_action="THERMAL_STATUS_NONE",
        ),
        sample(
            25.0,
            workload="camera_preview_ai_sustained",
            governor_state="sustained_no_throttle_modeled",
            cpu_power_w=sustained_cpu_w,
            npu_power_w=sustained_npu_w,
            package_power_w=sustained_pkg_w,
            die_temp_c=sustained_die_c,
            scheduler_hint="hold_sustained_cpu_npu_opp",
            thermal_hal_action="THERMAL_STATUS_LIGHT",
        ),
        sample(
            30.0,
            workload="assistant_multimodal_burst",
            governor_state="burst_headroom_modeled",
            cpu_power_w=burst_cpu_w,
            npu_power_w=burst_npu_w,
            package_power_w=burst_pkg_w,
            die_temp_c=sustained_die_c,
            scheduler_hint="allow_sota_cpu_npu_burst",
            thermal_hal_action="THERMAL_STATUS_LIGHT",
        ),
        sample(
            30.0 + burst_duration_s,
            workload="assistant_multimodal_burst",
            governor_state="burst_exit_to_cooldown",
            cpu_power_w=burst_cpu_w,
            npu_power_w=burst_npu_w,
            package_power_w=burst_pkg_w,
            die_temp_c=burst_exit_die_c,
            scheduler_hint="clear_burst_hint",
            thermal_hal_action="THERMAL_STATUS_MODERATE",
        ),
        sample(
            35.0,
            workload="second_burst_request",
            governor_state="burst_denied_cooldown",
            cpu_power_w=sustained_cpu_w,
            npu_power_w=sustained_npu_w,
            package_power_w=sustained_pkg_w,
            die_temp_c=91.4,
            scheduler_hint="deny_burst_until_cooldown_exit",
            thermal_hal_action="THERMAL_STATUS_MODERATE",
        ),
        sample(
            45.0,
            workload="cooldown_recovery",
            governor_state="sustained_recovery",
            cpu_power_w=sustained_cpu_w,
            npu_power_w=sustained_npu_w,
            package_power_w=sustained_pkg_w,
            die_temp_c=89.5,
            scheduler_hint="restore_sustained_hint",
            thermal_hal_action="THERMAL_STATUS_LIGHT",
        ),
        sample(
            60.0,
            workload="camera_preview_ai_sustained",
            governor_state="sustained_no_throttle_modeled",
            cpu_power_w=sustained_cpu_w,
            npu_power_w=sustained_npu_w,
            package_power_w=sustained_pkg_w,
            die_temp_c=89.2,
            scheduler_hint="hold_sustained_cpu_npu_opp",
            thermal_hal_action="THERMAL_STATUS_LIGHT",
        ),
    ]

    burst_samples = [row for row in trace if str(row["governor_state"]).startswith("burst_")]
    checks = [
        check_row(
            "aosp_mapping_inputs_pass",
            "pass"
            if policy.get("status") == "modeled_policy_release_blocked"
            and transient.get("status") == "modeled_transient_release_blocked"
            else "fail",
            "Modeled AOSP governor trace consumes the checked burst policy and transient reports.",
        ),
        check_row(
            "scheduler_selects_sustained_and_burst_pass",
            "pass"
            if any(row["governor_state"] == "sustained_no_throttle_modeled" for row in trace)
            and any(row["governor_state"] == "burst_headroom_modeled" for row in trace)
            else "fail",
            "Trace contains explicit scheduler selections for sustained and burst CPU+NPU states.",
        ),
        check_row(
            "thermal_hysteresis_blocks_repeat_burst_pass",
            "pass"
            if any(row["governor_state"] == "burst_denied_cooldown" for row in trace)
            and burst_duration_s
            <= require_number(
                recommended.get("worst_case_time_to_95c_s"), "worst-case time to 95 C"
            )
            else "fail",
            "A repeat burst request is denied until the modeled cooldown threshold is reached.",
        ),
        check_row(
            "modeled_trace_stays_below_die_limit_pass",
            "pass"
            if max(require_number(row["die_temp_c"], "sample die") for row in trace) < MAX_DIE_C
            else "fail",
            "All modeled trace samples remain below the die thermal limit.",
        ),
        check_row(
            "local_aosp_simulator_evidence_blocked",
            "blocked",
            "This is not a local AOSP virtual-device scheduler or thermal HAL run.",
        ),
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    blocked = [row["id"] for row in checks if row["status"] == "blocked"]
    return {
        "schema": "eliza.cpu_npu_2028_aosp_governor_trace.v1",
        "status": "fail" if failed else "modeled_aosp_trace_release_blocked" if blocked else "pass",
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Deterministic AOSP-style scheduler and thermal HAL trace only; not Cuttlefish, "
            "QEMU, Renode, Android framework, kernel thermal, or device evidence."
        ),
        "source_artifacts": {
            "burst_sustained_policy": str(POLICY.relative_to(ROOT)),
            "burst_thermal_transient": str(TRANSIENT.relative_to(ROOT)),
        },
        "thermal_policy": {
            "max_die_c": MAX_DIE_C,
            "burst_entry_die_c": BURST_ENTRY_DIE_C,
            "cooldown_exit_die_c": COOLDOWN_EXIT_DIE_C,
            "modeled_burst_duration_s": burst_duration_s,
        },
        "trace": trace,
        "summary": {
            "sample_count": len(trace),
            "burst_state_count": len(burst_samples),
            "max_die_temp_c": max(require_number(row["die_temp_c"], "sample die") for row in trace),
            "max_package_power_w": max(
                require_number(row["package_power_w"], "sample package power") for row in trace
            ),
            "repeat_burst_denied": any(
                row["governor_state"] == "burst_denied_cooldown" for row in trace
            ),
        },
        "checks": checks,
        "release_claim_forbidden_until": [
            "AOSP local virtual-device boot evidence exists for the same scheduler and thermal policy.",
            "Android thermal HAL, kernel thermal zone, power HAL, and schedutil traces are captured.",
            "Cuttlefish, QEMU, or Renode logs prove CPU+NPU sustained, burst, cooldown, and recovery states.",
            "Measured package, skin, rail-current, clock, and workload traces correlate the model.",
        ],
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_aosp_governor_trace.v1":
        errors.append("schema mismatch")
    if data.get("status") != "modeled_aosp_trace_release_blocked":
        errors.append("AOSP governor trace must remain modeled_aosp_trace_release_blocked")
    if "not Cuttlefish" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block local AOSP simulator claims")
    for flag in FALSE_CLAIM_FLAGS:
        if data.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")
    trace = data.get("trace")
    if not isinstance(trace, list) or len(trace) < 8:
        errors.append("trace must include at least eight samples")
        return errors
    states = {row.get("governor_state") for row in trace if isinstance(row, dict)}
    for state in (
        "sustained_no_throttle_modeled",
        "burst_headroom_modeled",
        "burst_exit_to_cooldown",
        "burst_denied_cooldown",
        "sustained_recovery",
    ):
        if state not in states:
            errors.append(f"trace missing governor state {state}")
    for row in trace:
        if not isinstance(row, dict):
            errors.append("trace entries must be mappings")
            continue
        if require_number(row.get("die_temp_c"), "sample die temperature") >= MAX_DIE_C:
            errors.append(f"{row.get('governor_state')}: die temperature exceeds limit")
        if not str(row.get("thermal_hal_action", "")).startswith("THERMAL_STATUS_"):
            errors.append(f"{row.get('governor_state')}: missing thermal HAL status")
        if not isinstance(row.get("scheduler_hint"), str) or not row["scheduler_hint"]:
            errors.append(f"{row.get('governor_state')}: missing scheduler hint")
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
    else:
        if require_number(summary.get("max_die_temp_c"), "summary max die") >= MAX_DIE_C:
            errors.append("summary max die temperature exceeds limit")
        if summary.get("repeat_burst_denied") is not True:
            errors.append("summary must record repeat burst denial")
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be a list")
        return errors
    by_id = {row.get("id"): row for row in checks if isinstance(row, dict)}
    for row_id in (
        "aosp_mapping_inputs_pass",
        "scheduler_selects_sustained_and_burst_pass",
        "thermal_hysteresis_blocks_repeat_burst_pass",
        "modeled_trace_stays_below_die_limit_pass",
    ):
        if by_id.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    if by_id.get("local_aosp_simulator_evidence_blocked", {}).get("status") != "blocked":
        errors.append("local_aosp_simulator_evidence_blocked must remain blocked")
    return errors


def main() -> int:
    try:
        data = build_report()
        errors = validate_report(data)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        data = None
        errors = [str(exc)]
    if errors:
        print("CPU+NPU AOSP governor trace check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    assert data is not None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "CPU+NPU AOSP governor trace check passed: "
        f"{OUT.relative_to(ROOT)} remains release-blocked."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
