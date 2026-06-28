#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OPT = ROOT / "benchmarks/sim/optimize_soc_operating_point.py"
REPORT = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
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


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def positive_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def load_or_generate() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(OPT), "--out", str(REPORT)],
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
        data.get("schema") == "eliza.soc_cpu_npu_operating_point_optimization.v1",
        "schema mismatch",
        errors,
    )
    require(data.get("status") == "pass", "status must be pass", errors)
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
        "claim boundary must block RTL/PDK/silicon use",
        errors,
    )
    for field, expected in FALSE_CLAIM_FLAGS.items():
        require(data.get(field) is expected, f"{field} must be exactly false", errors)
    for field in FORBIDDEN_FIELDS:
        require(field not in data, f"forbidden comparable score field present: {field}", errors)

    search = data.get("search_space")
    require(isinstance(search, dict), "search_space must be an object", errors)
    if isinstance(search, dict):
        require(
            isinstance(search.get("evaluated_count"), int) and search["evaluated_count"] > 0,
            "search_space.evaluated_count must be positive",
            errors,
        )
        require(
            isinstance(search.get("feasible_count"), int) and search["feasible_count"] > 0,
            "search_space.feasible_count must be positive",
            errors,
        )
        require(
            isinstance(search.get("robust_feasible_count"), int)
            and search["robust_feasible_count"] > 0,
            "search_space.robust_feasible_count must be positive",
            errors,
        )

    constraints = data.get("constraints")
    require(isinstance(constraints, dict), "constraints must be an object", errors)
    optimized = data.get("optimized")
    baseline = data.get("baseline")
    require(isinstance(optimized, dict), "optimized must be an object", errors)
    require(isinstance(baseline, dict), "baseline must be an object", errors)
    if isinstance(optimized, dict) and isinstance(constraints, dict):
        summary = optimized.get("summary")
        require(isinstance(summary, dict), "optimized.summary must be an object", errors)
        if isinstance(summary, dict):
            require(
                summary.get("any_modeled_throttle_required") is False,
                "optimized candidate must remove modeled throttle",
                errors,
            )
            require(
                float(summary.get("max_die_temp_c", 999.0))
                <= float(constraints.get("max_die_c", 0.0)),
                "optimized max die temperature exceeds constraint",
                errors,
            )
            require(
                float(summary.get("min_bandwidth_margin_gbps", -999.0))
                >= float(constraints.get("min_bandwidth_margin_gbps", 0.0)),
                "optimized bandwidth margin violates constraint",
                errors,
            )
            require(
                float(summary.get("min_npu_int8_tops", 0.0))
                >= float(constraints.get("min_npu_tops", 0.0)),
                "optimized NPU TOPS violates constraint",
                errors,
            )
            for key in (
                "max_die_temp_c",
                "max_total_power_w",
                "min_composite_perf_per_w",
                "min_npu_int8_tops",
            ):
                require(
                    positive_number(summary.get(key)),
                    f"optimized.summary.{key} must be positive",
                    errors,
                )
        config = optimized.get("config")
        require(isinstance(config, dict), "optimized.config must be an object", errors)
        if isinstance(config, dict):
            require(
                float(config.get("memory_sustained_gbps", 0.0)) >= 160.0,
                "optimized memory bandwidth must be at least 160 GB/s",
                errors,
            )
            require(
                float(config.get("npu_base_power_w", 999.0)) < 3.6,
                "optimized NPU power should improve over baseline",
                errors,
            )

    if isinstance(baseline, dict):
        baseline_summary = baseline.get("summary")
        if isinstance(baseline_summary, dict):
            require(
                baseline_summary.get("any_modeled_throttle_required") is True,
                "baseline should preserve known modeled throttle pressure",
                errors,
            )

    robustness = data.get("robustness")
    require(isinstance(robustness, dict), "robustness must be an object", errors)
    if isinstance(robustness, dict) and isinstance(constraints, dict):
        require(
            "modeled_guardband_sensitivity_only" in str(robustness.get("claim_boundary", "")),
            "robustness claim boundary must block real evidence use",
            errors,
        )
        robust_summary = robustness.get("summary")
        require(isinstance(robust_summary, dict), "robustness.summary must be an object", errors)
        if isinstance(robust_summary, dict):
            require(robust_summary.get("pass") is True, "robustness guardband must pass", errors)
            require(
                robust_summary.get("failing_cases") == [],
                "robustness guardband must not list failing cases",
                errors,
            )
            require(
                int(robust_summary.get("case_count", 0)) >= 6,
                "robustness must cover all guardband cases",
                errors,
            )
            require(
                float(robust_summary.get("max_die_temp_c", 999.0))
                <= float(constraints.get("max_die_c", 0.0)),
                "robustness max die temperature exceeds constraint",
                errors,
            )
            require(
                float(robust_summary.get("min_bandwidth_margin_gbps", -999.0))
                >= float(constraints.get("min_bandwidth_margin_gbps", 0.0)),
                "robustness bandwidth margin violates constraint",
                errors,
            )
            require(
                float(robust_summary.get("min_npu_int8_tops", 0.0))
                >= float(constraints.get("min_npu_tops", 0.0)),
                "robustness NPU TOPS violates constraint",
                errors,
            )
        cases = robustness.get("cases")
        require(isinstance(cases, list) and len(cases) >= 6, "robustness.cases missing", errors)
        if isinstance(cases, list):
            case_names = {case.get("name") for case in cases if isinstance(case, dict)}
            for required_case in {
                "selected_nominal",
                "hot_ambient_35c",
                "power_plus_5pct",
                "memory_minus_5pct",
                "npu_tops_minus_5pct",
                "combined_guardband",
            }:
                require(
                    required_case in case_names, f"missing robustness case {required_case}", errors
                )
            for case in cases:
                if isinstance(case, dict):
                    require(
                        case.get("pass") is True,
                        f"robustness case failed: {case.get('name')}",
                        errors,
                    )

    improvement = data.get("improvement")
    require(isinstance(improvement, dict), "improvement must be an object", errors)
    if isinstance(improvement, dict):
        require(
            improvement.get("baseline_any_throttle") is True,
            "improvement must record throttling baseline",
            errors,
        )
        require(
            improvement.get("optimized_any_throttle") is False,
            "improvement must record no-throttle optimized point",
            errors,
        )
        require(
            float(improvement.get("max_die_c_delta", 0.0)) < 0.0,
            "optimized point must reduce max die temperature",
            errors,
        )
        require(
            float(improvement.get("min_bandwidth_margin_gbps_delta", 0.0)) > 0.0,
            "optimized point must improve bandwidth margin",
            errors,
        )

    artifacts = data.get("artifacts")
    require(isinstance(artifacts, dict), "artifacts must be an object", errors)
    if isinstance(artifacts, dict):
        contract = artifacts.get("process_effects_contract")
        require(isinstance(contract, dict), "missing process effects contract artifact", errors)
        if isinstance(contract, dict):
            require(
                contract.get("path") == "docs/spec-db/process-14a-effects.yaml",
                "process effects contract path drifted",
                errors,
            )
            sha = contract.get("sha256")
            require(
                isinstance(sha, str) and len(sha) == 64,
                "process effects contract sha invalid",
                errors,
            )
    return errors


def main() -> int:
    try:
        data = load_or_generate()
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print("SoC operating point optimization check failed:")
        print(f"  - {exc}")
        return 1
    errors = check_report(data)
    if errors:
        print("SoC operating point optimization check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("SoC operating point optimization check passed: modeled no-throttle point selected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
