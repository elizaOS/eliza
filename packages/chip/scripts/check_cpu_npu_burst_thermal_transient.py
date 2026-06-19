#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, require_number

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json"
OUT = ROOT / "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json"
MAX_DIE_C = 95.0
MAX_WINDOW_S = 120.0
RECOMMENDED_FRACTION = 0.5
MAX_RECOMMENDED_BURST_S = 10.0

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "measured_skin_claim_allowed": False,
    "rail_measurement_claim_allowed": False,
    "package_validation_claim_allowed": False,
    "enclosure_validation_claim_allowed": False,
    "aosp_thermal_hal_claim_allowed": False,
    "silicon_burst_duration_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def check_row(row_id: str, status: str, evidence: str) -> dict[str, str]:
    return {"id": row_id, "status": status, "evidence": evidence}


def time_to_limit_s(
    *,
    ambient_c: float,
    initial_die_c: float,
    package_power_w: float,
    theta_ja_c_per_w: float,
    tau_s: float,
    limit_c: float,
) -> float:
    if initial_die_c >= limit_c:
        return 0.0
    steady_c = ambient_c + package_power_w * theta_ja_c_per_w
    if steady_c <= limit_c:
        return MAX_WINDOW_S
    ratio = (limit_c - steady_c) / (initial_die_c - steady_c)
    if ratio <= 0.0 or ratio >= 1.0:
        raise ValueError("thermal ratio outside expected transient range")
    return -tau_s * math.log(ratio)


def temperature_at_s(
    *,
    ambient_c: float,
    initial_die_c: float,
    package_power_w: float,
    theta_ja_c_per_w: float,
    tau_s: float,
    seconds: float,
) -> float:
    steady_c = ambient_c + package_power_w * theta_ja_c_per_w
    return steady_c + (initial_die_c - steady_c) * math.exp(-seconds / tau_s)


def build_scenario(
    scenario_id: str,
    *,
    ambient_c: float,
    initial_die_c: float,
    package_power_w: float,
    theta_ja_c_per_w: float,
    tau_s: float,
) -> dict[str, Any]:
    time_to_limit = time_to_limit_s(
        ambient_c=ambient_c,
        initial_die_c=initial_die_c,
        package_power_w=package_power_w,
        theta_ja_c_per_w=theta_ja_c_per_w,
        tau_s=tau_s,
        limit_c=MAX_DIE_C,
    )
    return {
        "id": scenario_id,
        "ambient_c": ambient_c,
        "initial_die_c": initial_die_c,
        "package_power_w": package_power_w,
        "theta_ja_c_per_w": theta_ja_c_per_w,
        "tau_s": tau_s,
        "steady_state_die_c": ambient_c + package_power_w * theta_ja_c_per_w,
        "time_to_95c_s": time_to_limit,
        "release_use": "forbidden_modeled_only",
    }


def build_report() -> dict[str, Any]:
    policy = load_json_object(POLICY)
    burst = policy.get("burst_policy")
    sustained = policy.get("sustained_policy")
    if not isinstance(burst, dict) or not isinstance(sustained, dict):
        raise ValueError("burst/sustained policy missing policy sections")

    burst_package_power = require_number(
        burst.get("estimated_package_power_cap_w"), "burst package power cap"
    )
    sustained_hot_die = require_number(
        sustained.get("robust_max_die_temp_c"), "sustained robust max die temperature"
    )
    cpu_burst_power = require_number(burst.get("cpu_sota_estimated_power_w"), "CPU burst power")
    npu_burst_power = require_number(burst.get("npu_burst_power_cap_w"), "NPU burst power")

    nominal_preheat_c = max(52.0, sustained_hot_die - 30.0)
    scenarios = [
        build_scenario(
            "nominal_warm_start",
            ambient_c=25.0,
            initial_die_c=nominal_preheat_c,
            package_power_w=burst_package_power,
            theta_ja_c_per_w=5.2,
            tau_s=18.0,
        ),
        build_scenario(
            "sustained_preheated",
            ambient_c=25.0,
            initial_die_c=sustained_hot_die,
            package_power_w=burst_package_power,
            theta_ja_c_per_w=6.0,
            tau_s=22.0,
        ),
        build_scenario(
            "hot_ambient_guardband",
            ambient_c=35.0,
            initial_die_c=sustained_hot_die,
            package_power_w=burst_package_power * 1.05,
            theta_ja_c_per_w=6.6,
            tau_s=24.2,
        ),
    ]
    worst_case_time_s = min(
        require_number(item["time_to_95c_s"], f"{item['id']} time to limit") for item in scenarios
    )
    recommended_s = min(MAX_RECOMMENDED_BURST_S, worst_case_time_s * RECOMMENDED_FRACTION)
    recommended_s = max(0.0, recommended_s)
    recommended_temps = [
        {
            "id": item["id"],
            "die_temp_at_recommended_s_c": temperature_at_s(
                ambient_c=require_number(item["ambient_c"], "ambient"),
                initial_die_c=require_number(item["initial_die_c"], "initial die"),
                package_power_w=require_number(item["package_power_w"], "power"),
                theta_ja_c_per_w=require_number(item["theta_ja_c_per_w"], "theta-ja"),
                tau_s=require_number(item["tau_s"], "tau"),
                seconds=recommended_s,
            ),
        }
        for item in scenarios
    ]

    checks = [
        check_row(
            "transient_model_inputs_pass",
            "pass"
            if policy.get("status") == "modeled_policy_release_blocked"
            and burst_package_power > 0.0
            and cpu_burst_power > 0.0
            and npu_burst_power > 0.0
            else "fail",
            "Burst transient model consumes the checked release-blocked burst/sustained policy.",
        ),
        check_row(
            "modeled_burst_window_pass",
            "pass" if recommended_s > 0.0 and recommended_s <= worst_case_time_s else "fail",
            "A positive modeled burst window is derived below the worst-case time to 95 C.",
        ),
        check_row(
            "release_duration_claim_blocked",
            "blocked",
            "Modeled burst duration cannot be used for release without measured thermal traces and package/enclosure validation.",
        ),
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    blocked = [row["id"] for row in checks if row["status"] == "blocked"]
    return {
        "schema": "eliza.cpu_npu_2028_burst_thermal_transient.v1",
        "status": "fail" if failed else "modeled_transient_release_blocked" if blocked else "pass",
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Deterministic RC burst thermal transient model only; not measured skin, rail, "
            "package, enclosure, AOSP thermal HAL, or silicon burst-duration evidence."
        ),
        "source_artifacts": {
            "burst_sustained_policy": str(POLICY.relative_to(ROOT)),
        },
        "limits": {
            "max_die_c": MAX_DIE_C,
            "max_window_s": MAX_WINDOW_S,
            "recommended_fraction_of_worst_case": RECOMMENDED_FRACTION,
            "max_recommended_burst_s": MAX_RECOMMENDED_BURST_S,
        },
        "burst_power_breakdown": {
            "cpu_sota_estimated_power_w": cpu_burst_power,
            "npu_burst_power_cap_w": npu_burst_power,
            "package_power_cap_w": burst_package_power,
        },
        "scenarios": scenarios,
        "recommended": {
            "modeled_recommended_burst_duration_s": recommended_s,
            "worst_case_time_to_95c_s": worst_case_time_s,
            "temperature_at_recommended": recommended_temps,
            "governor_use": "architecture_model_only_release_blocked",
        },
        "checks": checks,
        "release_claim_forbidden_until": [
            "Measured aligned package power, die temperature, skin temperature, and rail-current traces exist.",
            "Package/enclosure transient model is correlated against measured phone-class thermal data.",
            "AOSP thermal HAL and scheduler hysteresis select burst, cooldown, and sustained states in simulator evidence.",
            "14A PDK extracted timing, leakage, dynamic power, IR/EM, and thermal signoff replaces planning constants.",
        ],
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_burst_thermal_transient.v1":
        errors.append("schema mismatch")
    if data.get("status") != "modeled_transient_release_blocked":
        errors.append("transient report must remain modeled_transient_release_blocked")
    if "not measured" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block measured thermal claims")
    for flag in FALSE_CLAIM_FLAGS:
        if data.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")
    recommended = data.get("recommended")
    if not isinstance(recommended, dict):
        errors.append("recommended section missing")
        return errors
    duration = require_number(
        recommended.get("modeled_recommended_burst_duration_s"), "recommended burst duration"
    )
    worst = require_number(recommended.get("worst_case_time_to_95c_s"), "worst-case time")
    if duration <= 0.0:
        errors.append("recommended modeled burst duration must be positive")
    if duration > MAX_RECOMMENDED_BURST_S:
        errors.append("recommended modeled burst duration exceeds policy cap")
    if duration > worst:
        errors.append("recommended modeled burst duration exceeds worst-case time to limit")
    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list) or len(scenarios) < 3:
        errors.append("transient report must include at least three scenarios")
        return errors
    for item in scenarios:
        if not isinstance(item, dict):
            errors.append("scenario entries must be mappings")
            continue
        scenario_id = str(item.get("id"))
        if item.get("release_use") != "forbidden_modeled_only":
            errors.append(f"{scenario_id}: release_use must remain forbidden")
        if require_number(item.get("time_to_95c_s"), f"{scenario_id} time to 95 C") <= 0.0:
            errors.append(f"{scenario_id}: time to 95 C must be positive")
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be a list")
        return errors
    by_id = {row.get("id"): row for row in checks if isinstance(row, dict)}
    for row_id in ("transient_model_inputs_pass", "modeled_burst_window_pass"):
        if by_id.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    if by_id.get("release_duration_claim_blocked", {}).get("status") != "blocked":
        errors.append("release_duration_claim_blocked must remain blocked")
    return errors


def main() -> int:
    try:
        data = build_report()
        errors = validate_report(data)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        data = None
        errors = [str(exc)]
    if errors:
        print("CPU+NPU burst thermal transient check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    assert data is not None
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "CPU+NPU burst thermal transient check passed: "
        f"{OUT.relative_to(ROOT)} remains release-blocked."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
