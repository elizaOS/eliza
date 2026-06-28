#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORK_ORDER = ROOT / "docs/architecture-optimization/soc-optimized-operating-point.yaml"
OPT_REPORT = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
OPT_CHECK = ROOT / "scripts/check_soc_optimization.py"

REQUIRED_DELTAS = {
    "cpu_power_budget",
    "npu_perf_per_w_budget",
    "memory_bandwidth_budget",
    "thermal_budget",
    "process_corner_budget",
}
REQUIRED_RELEASE_BLOCKERS = {
    "cpu_ap_completion_gate",
    "aosp_simulator_completion_gate",
    "sustained_power_thermal_evidence_check",
    "memory_uma_claim_gate",
    "pd_signoff_release_check",
}
FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "rtl_claim_allowed",
    "aosp_boot_claim_allowed",
    "linux_boot_claim_allowed",
    "silicon_claim_allowed",
    "release_claim_allowed",
    "phone_performance_claim_allowed",
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def close_enough(left: Any, right: Any, tolerance: float = 1e-9) -> bool:
    left_float = as_float(left)
    right_float = as_float(right)
    if left_float is None or right_float is None:
        return left == right
    return abs(left_float - right_float) <= tolerance


def load_optimizer_report() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(OPT_CHECK)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout + completed.stderr)
    return json.loads(OPT_REPORT.read_text(encoding="utf-8"))


def check_work_order(data: dict[str, Any], report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(
        data.get("schema") == "eliza.soc_optimized_operating_point_work_order.v1",
        "work order schema mismatch",
        errors,
    )
    require(
        data.get("status") == "modeled_recommendation_release_blocked",
        "work order must remain modeled_recommendation_release_blocked",
        errors,
    )
    require(
        "not RTL" in str(data.get("claim_boundary", ""))
        or "not RTL" in str(data.get("claim_boundary", "")).replace(",", ""),
        "claim boundary must block RTL evidence use",
        errors,
    )
    for flag in sorted(FALSE_CLAIM_FLAGS):
        require(data.get(flag) is False, f"{flag} must be false", errors)

    source = data.get("source_artifacts")
    require(isinstance(source, dict), "source_artifacts must be a mapping", errors)
    if isinstance(source, dict):
        require(
            source.get("optimizer_report")
            == "benchmarks/results/soc-optimized-operating-point.json",
            "source_artifacts.optimizer_report must point to optimizer report",
            errors,
        )
        require(
            source.get("checker_command") == "make soc-optimization",
            "checker command drifted",
            errors,
        )
        require(
            source.get("test_command") == "make soc-optimization-test",
            "test command drifted",
            errors,
        )
        require(
            source.get("process_effects_contract") == "docs/spec-db/process-14a-effects.yaml",
            "process effects contract path drifted",
            errors,
        )

    selected = data.get("selected_modeled_point")
    optimized = report.get("optimized", {})
    opt_config = optimized.get("config", {}) if isinstance(optimized, dict) else {}
    require(isinstance(selected, dict), "selected_modeled_point must be a mapping", errors)
    if isinstance(selected, dict) and isinstance(opt_config, dict):
        for key in (
            "cpu_cores",
            "cpu_base_frequency_hz",
            "cpu_base_ipc",
            "cpu_base_power_w",
            "npu_base_tops",
            "npu_base_power_w",
            "memory_sustained_gbps",
            "ambient_c",
        ):
            require(
                close_enough(selected.get(key), opt_config.get(key)),
                f"selected_modeled_point.{key} does not match optimizer report",
                errors,
            )

    summary = data.get("optimized_summary")
    opt_summary = optimized.get("summary", {}) if isinstance(optimized, dict) else {}
    require(isinstance(summary, dict), "optimized_summary must be a mapping", errors)
    if isinstance(summary, dict) and isinstance(opt_summary, dict):
        require(
            summary.get("no_modeled_throttle") is True,
            "optimized_summary must require no throttle",
            errors,
        )
        require(
            opt_summary.get("any_modeled_throttle_required") is False,
            "optimizer report still throttles",
            errors,
        )
        mapping = {
            "max_die_temp_c": "max_die_temp_c",
            "max_total_power_w": "max_total_power_w",
            "min_bandwidth_margin_gbps": "min_bandwidth_margin_gbps",
            "min_composite_perf_per_w": "min_composite_perf_per_w",
            "min_npu_int8_tops": "min_npu_int8_tops",
            "process_corner_count": "process_corner_count",
            "scenario_count": "scenario_count",
            "worst_efficiency_corner": "worst_efficiency_corner",
            "worst_efficiency_scenario": "worst_efficiency_scenario",
            "worst_thermal_corner": "worst_thermal_corner",
            "worst_thermal_scenario": "worst_thermal_scenario",
        }
        for work_key, report_key in mapping.items():
            require(
                close_enough(summary.get(work_key), opt_summary.get(report_key)),
                f"optimized_summary.{work_key} does not match optimizer report",
                errors,
            )

    delta = data.get("baseline_delta")
    improvement = report.get("improvement", {})
    require(isinstance(delta, dict), "baseline_delta must be a mapping", errors)
    if isinstance(delta, dict) and isinstance(improvement, dict):
        delta_mapping = {
            "baseline_had_modeled_throttle": "baseline_any_throttle",
            "optimized_has_modeled_throttle": "optimized_any_throttle",
            "max_die_c_delta": "max_die_c_delta",
            "max_power_w_delta": "max_power_w_delta",
            "min_bandwidth_margin_gbps_delta": "min_bandwidth_margin_gbps_delta",
            "min_composite_perf_per_w_ratio": "min_composite_perf_per_w_ratio",
        }
        for work_key, report_key in delta_mapping.items():
            require(
                close_enough(delta.get(work_key), improvement.get(report_key)),
                f"baseline_delta.{work_key} does not match optimizer report",
                errors,
            )
        require(
            as_float(delta.get("max_die_c_delta")) is not None and delta["max_die_c_delta"] < 0,
            "work order must record cooler optimized point",
            errors,
        )
        require(
            as_float(delta.get("max_power_w_delta")) is not None and delta["max_power_w_delta"] < 0,
            "work order must record lower-power optimized point",
            errors,
        )
        require(
            as_float(delta.get("min_composite_perf_per_w_ratio")) is not None
            and delta["min_composite_perf_per_w_ratio"] > 1.0,
            "work order must record perf/W improvement",
            errors,
        )

    robust = data.get("robustness_summary")
    report_robust = report.get("robustness", {})
    report_robust_summary = (
        report_robust.get("summary", {}) if isinstance(report_robust, dict) else {}
    )
    require(isinstance(robust, dict), "robustness_summary must be a mapping", errors)
    if isinstance(robust, dict) and isinstance(report_robust_summary, dict):
        for key in (
            "pass",
            "case_count",
            "max_die_temp_c",
            "max_total_power_w",
            "min_bandwidth_margin_gbps",
            "min_composite_perf_per_w",
            "min_npu_int8_tops",
            "failing_cases",
        ):
            require(
                close_enough(robust.get(key), report_robust_summary.get(key)),
                f"robustness_summary.{key} does not match optimizer report",
                errors,
            )
        require(robust.get("pass") is True, "robustness_summary must pass", errors)
        require(
            robust.get("failing_cases") == [],
            "robustness_summary must not contain failing cases",
            errors,
        )

    deltas = data.get("design_deltas_required_before_claim")
    require(isinstance(deltas, list), "design_deltas_required_before_claim must be a list", errors)
    delta_items = deltas if isinstance(deltas, list) else []
    delta_by_id = {item.get("id"): item for item in delta_items if isinstance(item, dict)}
    missing = sorted(REQUIRED_DELTAS - set(delta_by_id))
    require(not missing, "missing design deltas: " + ", ".join(missing), errors)
    for delta_id, item in delta_by_id.items():
        if delta_id not in REQUIRED_DELTAS or not isinstance(item, dict):
            continue
        require(
            isinstance(item.get("modeled_target"), str) and item["modeled_target"],
            f"{delta_id} missing modeled_target",
            errors,
        )
        require(
            isinstance(item.get("implementation_dependency"), str)
            and item["implementation_dependency"],
            f"{delta_id} missing implementation_dependency",
            errors,
        )
        blocker = item.get("release_blocker")
        require(
            blocker in REQUIRED_RELEASE_BLOCKERS,
            f"{delta_id} has invalid release_blocker {blocker!r}",
            errors,
        )

    forbidden = "\n".join(data.get("forbidden_release_use_until") or [])
    for blocker in REQUIRED_RELEASE_BLOCKERS:
        require(blocker in forbidden, f"forbidden_release_use_until missing {blocker}", errors)
    return errors


def main() -> int:
    errors: list[str] = []
    if not WORK_ORDER.is_file():
        print(f"SoC optimized work order check failed:\n  - missing {WORK_ORDER.relative_to(ROOT)}")
        return 1
    try:
        data = yaml.safe_load(WORK_ORDER.read_text(encoding="utf-8"))
        report = load_optimizer_report()
    except (OSError, RuntimeError, json.JSONDecodeError, yaml.YAMLError) as exc:
        print("SoC optimized work order check failed:")
        print(f"  - {exc}")
        return 1
    if not isinstance(data, dict):
        errors.append("work order must be a YAML mapping")
    else:
        errors.extend(check_work_order(data, report))
    if errors:
        print("SoC optimized work order check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("SoC optimized work order check passed: recommendation matches optimizer output.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
