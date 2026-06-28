#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SIM = ROOT / "benchmarks/sim/run_soc_thermal_sweep.py"
REPORT = ROOT / "benchmarks/results/soc-thermal-sweep.json"

REQUIRED_CORNERS = {
    "14a_tt_0p70v_25c_frontside_pdn",
    "14a_ss_0p63v_105c_frontside_pdn",
    "14a_ff_0p77v_0c_frontside_pdn",
    "14a_bspdn_follow_on_hot_ir_em_stress",
}
REQUIRED_SCENARIOS = {
    "android_foreground_ai_assistant",
    "sustained_npu_camera_display",
    "cpu_peak_background_npu",
}
FORBIDDEN_FIELDS = {"phone_score", "geekbench_score", "wall_clock_score"}
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "phone_score_claim_allowed": False,
    "rtl_claim_allowed": False,
    "pdk_signoff_claim_allowed": False,
    "silicon_claim_allowed": False,
    "sustained_power_thermal_claim_allowed": False,
    "aosp_runtime_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
REQUIRED_SCENARIO_KEYS = {
    "cpu_frequency_hz",
    "cpu_ipc",
    "npu_int8_tops",
    "memory_bandwidth_demand_gbps",
    "memory_bandwidth_limit_gbps",
    "memory_bandwidth_margin_gbps",
    "cpu_power_w",
    "npu_power_w",
    "memory_power_w",
    "uncore_power_w",
    "total_power_w",
    "die_temp_c",
    "npu_tops_per_w",
    "composite_perf_per_w",
    "throttle_required",
    "release_use",
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def positive_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def load_or_generate() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(SIM), "--out", str(REPORT)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout + completed.stderr)
    return json.loads(REPORT.read_text(encoding="utf-8"))


def check_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(
        data.get("schema") == "eliza.soc_cpu_npu_thermal_sweep.v1",
        "schema mismatch",
        errors,
    )
    require(
        data.get("benchmark_success_allowed") is True,
        "benchmark_success_allowed must be true",
        errors,
    )
    require(
        data.get("release_use") == "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
        "release_use must prohibit signoff use",
        errors,
    )
    require(
        "not_rtl_pdk_silicon" in str(data.get("claim_boundary", "")),
        "claim_boundary must block RTL/PDK/silicon evidence use",
        errors,
    )
    for field, expected in FALSE_CLAIM_FLAGS.items():
        require(data.get(field) is expected, f"{field} must be exactly false", errors)
    for field in FORBIDDEN_FIELDS:
        require(field not in data, f"forbidden comparable score field present: {field}", errors)

    artifacts = data.get("artifacts")
    require(isinstance(artifacts, dict), "artifacts must be an object", errors)
    if isinstance(artifacts, dict):
        contract = artifacts.get("process_effects_contract")
        require(isinstance(contract, dict), "missing process effects contract hash", errors)
        if isinstance(contract, dict):
            require(
                contract.get("path") == "docs/spec-db/process-14a-effects.yaml",
                "process contract path drifted",
                errors,
            )
            sha = contract.get("sha256")
            require(
                isinstance(sha, str) and len(sha) == 64, "process contract sha256 invalid", errors
            )

    corners = data.get("process_corners")
    require(isinstance(corners, list), "process_corners must be a list", errors)
    corner_list = corners if isinstance(corners, list) else []
    names = {corner.get("name") for corner in corner_list if isinstance(corner, dict)}
    missing_corners = sorted(REQUIRED_CORNERS - names)
    require(not missing_corners, "missing corners: " + ", ".join(missing_corners), errors)

    all_scenarios: list[dict[str, Any]] = []
    for index, corner in enumerate(corner_list):
        if not isinstance(corner, dict):
            errors.append(f"process_corners[{index}] must be an object")
            continue
        require(
            corner.get("release_use")
            == "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
            f"process_corners[{index}] release_use must prohibit signoff use",
            errors,
        )
        require(
            "not_pdk_signoff" in str(corner.get("claim_boundary", "")),
            f"process_corners[{index}] claim boundary must block PDK signoff",
            errors,
        )
        scenarios = corner.get("scenarios")
        require(
            isinstance(scenarios, list),
            f"process_corners[{index}].scenarios must be a list",
            errors,
        )
        scenario_list = scenarios if isinstance(scenarios, list) else []
        scenario_names = {
            scenario.get("name") for scenario in scenario_list if isinstance(scenario, dict)
        }
        missing_scenarios = sorted(REQUIRED_SCENARIOS - scenario_names)
        require(
            not missing_scenarios,
            f"process_corners[{index}] missing scenarios: " + ", ".join(missing_scenarios),
            errors,
        )
        for scenario_index, scenario in enumerate(scenario_list):
            if not isinstance(scenario, dict):
                errors.append(
                    f"process_corners[{index}].scenarios[{scenario_index}] must be an object"
                )
                continue
            all_scenarios.append(scenario)
            missing_keys = sorted(REQUIRED_SCENARIO_KEYS - set(scenario))
            require(
                not missing_keys,
                f"process_corners[{index}].scenarios[{scenario_index}] missing keys: "
                + ", ".join(missing_keys),
                errors,
            )
            for key in REQUIRED_SCENARIO_KEYS - {
                "memory_bandwidth_margin_gbps",
                "throttle_required",
                "release_use",
            }:
                require(
                    positive_number(scenario.get(key)),
                    f"process_corners[{index}].scenarios[{scenario_index}].{key} must be positive numeric",
                    errors,
                )
            require(
                number(scenario.get("memory_bandwidth_margin_gbps")),
                f"process_corners[{index}].scenarios[{scenario_index}].memory_bandwidth_margin_gbps must be numeric",
                errors,
            )
            require(
                isinstance(scenario.get("throttle_required"), bool),
                f"process_corners[{index}].scenarios[{scenario_index}].throttle_required must be bool",
                errors,
            )
            require(
                scenario.get("release_use")
                == "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
                f"process_corners[{index}].scenarios[{scenario_index}] release_use must prohibit signoff use",
                errors,
            )

    summary = data.get("summary")
    require(isinstance(summary, dict), "summary must be an object", errors)
    if isinstance(summary, dict):
        require(
            summary.get("process_corner_count") == len(corner_list),
            "summary corner count mismatch",
            errors,
        )
        require(
            summary.get("scenario_count") == len(REQUIRED_SCENARIOS),
            "summary scenario count mismatch",
            errors,
        )
        for key in ("max_total_power_w", "max_die_temp_c", "min_composite_perf_per_w"):
            require(
                positive_number(summary.get(key)), f"summary.{key} must be positive numeric", errors
            )
        require(
            summary.get("worst_thermal_corner") in REQUIRED_CORNERS,
            "summary.worst_thermal_corner must identify a required corner",
            errors,
        )
        require(
            summary.get("worst_efficiency_corner") in REQUIRED_CORNERS,
            "summary.worst_efficiency_corner must identify a required corner",
            errors,
        )
        require(
            summary.get("worst_thermal_scenario") in REQUIRED_SCENARIOS,
            "summary.worst_thermal_scenario must identify a required scenario",
            errors,
        )
        require(
            summary.get("worst_efficiency_scenario") in REQUIRED_SCENARIOS,
            "summary.worst_efficiency_scenario must identify a required scenario",
            errors,
        )
        require(
            summary.get("claim_boundary")
            == "modeled_derates_only_not_sustained_power_thermal_evidence",
            "summary claim boundary must block sustained evidence use",
            errors,
        )
    require(bool(all_scenarios), "no scenarios checked", errors)
    return errors


def main() -> int:
    try:
        data = load_or_generate()
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print("SoC thermal sweep check failed:")
        print(f"  - {exc}")
        return 1
    errors = check_report(data)
    if errors:
        print("SoC thermal sweep check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("SoC thermal sweep check passed: combined CPU+NPU model remains modeled-only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
