#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCORECARD = ROOT / "docs/architecture-optimization/cpu-npu-2028-readiness-scorecard.yaml"
OPTIMIZER_REPORT = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
OPTIMIZER_CHECK = ROOT / "scripts/check_soc_optimization.py"
WORK_ORDER_CHECK = ROOT / "scripts/check_soc_optimized_work_order.py"
BENCHMARK_PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"
MAKEFILE = ROOT / "Makefile"

REQUIRED_DOMAINS = {
    "cpu_ap",
    "npu_nnapi",
    "aosp_simulator",
    "benchmarks",
    "sustained_power_thermal",
    "memory_uma",
    "process_14a",
    "physical_signoff",
}
REQUIRED_BENCHMARKS = {
    "coremark",
    "stream",
    "lmbench_bw_mem",
    "lmbench_lat_mem_rd",
    "tflite_cpu",
    "tflite_e1_npu",
    "npu_arch_sim_open_2028",
    "simulator_arch_metrics",
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must be a YAML mapping")
    return data


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must be a JSON object")
    return data


def run_required_check(command: list[str], errors: list[str]) -> None:
    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        errors.append(f"{' '.join(command)} failed:\n{result.stdout}")


def number_matches(left: Any, right: Any, field: str, errors: list[str]) -> None:
    if not isinstance(left, int | float) or isinstance(left, bool):
        errors.append(f"{field} must be numeric in scorecard")
        return
    if not isinstance(right, int | float) or isinstance(right, bool):
        errors.append(f"{field} must be numeric in optimizer report")
        return
    if abs(float(left) - float(right)) > 1e-9:
        errors.append(f"{field} drifted: scorecard={left}, optimizer={right}")


def check_modeled_values(
    scorecard: dict[str, Any], optimizer: dict[str, Any], errors: list[str]
) -> None:
    point = scorecard.get("modeled_operating_point")
    constraints = scorecard.get("modeled_constraints")
    summary = scorecard.get("modeled_summary")
    optimized = optimizer.get("optimized")
    opt_constraints = optimizer.get("constraints")
    if not isinstance(point, dict):
        errors.append("scorecard missing modeled_operating_point mapping")
        return
    if not isinstance(constraints, dict):
        errors.append("scorecard missing modeled_constraints mapping")
        return
    if not isinstance(summary, dict):
        errors.append("scorecard missing modeled_summary mapping")
        return
    if not isinstance(optimized, dict):
        errors.append("scorecard and optimizer must contain modeled mappings")
        return
    opt_config = optimized.get("config")
    opt_summary = optimized.get("summary")
    if not isinstance(opt_config, dict) or not isinstance(opt_summary, dict):
        errors.append("optimizer report missing optimized config or summary")
        return
    for key in (
        "cpu_cores",
        "cpu_base_frequency_hz",
        "cpu_base_ipc",
        "cpu_base_power_w",
        "npu_base_tops",
        "npu_base_power_w",
        "memory_sustained_gbps",
    ):
        number_matches(
            point.get(key), opt_config.get(key), f"modeled_operating_point.{key}", errors
        )
    if isinstance(opt_constraints, dict):
        for key in ("max_die_c", "min_bandwidth_margin_gbps", "min_npu_tops"):
            number_matches(
                constraints.get(key), opt_constraints.get(key), f"modeled_constraints.{key}", errors
            )
    require(
        constraints.get("requires_no_modeled_throttle") is True,
        "requires_no_modeled_throttle must be true",
        errors,
    )
    require(summary.get("no_modeled_throttle") is True, "no_modeled_throttle must be true", errors)
    require(
        opt_summary.get("any_modeled_throttle_required") is False,
        "optimizer must select a no-throttle point",
        errors,
    )
    for key in (
        "max_die_temp_c",
        "max_total_power_w",
        "min_bandwidth_margin_gbps",
        "min_composite_perf_per_w",
        "min_npu_int8_tops",
        "process_corner_count",
        "scenario_count",
    ):
        number_matches(summary.get(key), opt_summary.get(key), f"modeled_summary.{key}", errors)
    robust = scorecard.get("modeled_robustness")
    optimizer_robust = optimizer.get("robustness")
    if not isinstance(robust, dict):
        errors.append("scorecard missing modeled_robustness mapping")
        return
    if not isinstance(optimizer_robust, dict) or not isinstance(
        optimizer_robust.get("summary"), dict
    ):
        errors.append("optimizer report missing robustness summary")
        return
    optimizer_robust_summary = optimizer_robust["summary"]
    require(robust.get("pass") is True, "modeled_robustness.pass must be true", errors)
    require(
        optimizer_robust_summary.get("pass") is True,
        "optimizer robustness summary must pass",
        errors,
    )
    require(
        robust.get("failing_cases") == [],
        "modeled_robustness must not list failing cases",
        errors,
    )
    for key in (
        "case_count",
        "max_die_temp_c",
        "max_total_power_w",
        "min_bandwidth_margin_gbps",
        "min_composite_perf_per_w",
        "min_npu_int8_tops",
    ):
        number_matches(
            robust.get(key), optimizer_robust_summary.get(key), f"modeled_robustness.{key}", errors
        )


def check_domains(scorecard: dict[str, Any], errors: list[str]) -> None:
    domains = scorecard.get("proof_domains")
    if not isinstance(domains, list):
        errors.append("proof_domains must be a list")
        return
    makefile = MAKEFILE.read_text(encoding="utf-8")
    seen: set[str] = set()
    for domain in domains:
        if not isinstance(domain, dict):
            errors.append("proof_domains entries must be mappings")
            continue
        domain_id = domain.get("id")
        if not isinstance(domain_id, str):
            errors.append("proof domain missing string id")
            continue
        seen.add(domain_id)
        require(
            str(domain.get("current_state", "")).startswith("blocked_until_"),
            f"{domain_id}: current_state must be blocked_until_*",
            errors,
        )
        command = domain.get("gate_command")
        require(
            isinstance(command, str) and command.startswith("make "),
            f"{domain_id}: bad gate_command",
            errors,
        )
        if isinstance(command, str):
            require(
                command.removeprefix("make ").strip() in makefile,
                f"{domain_id}: Makefile target missing",
                errors,
            )
        artifacts = domain.get("evidence_artifacts")
        require(
            isinstance(artifacts, list) and len(artifacts) > 0,
            f"{domain_id}: missing evidence_artifacts",
            errors,
        )
    missing = sorted(REQUIRED_DOMAINS - seen)
    if missing:
        errors.append("proof_domains missing: " + ", ".join(missing))


def check_benchmarks(scorecard: dict[str, Any], errors: list[str]) -> None:
    entries = scorecard.get("required_benchmark_plan_entries")
    if not isinstance(entries, list):
        errors.append("required_benchmark_plan_entries must be a list")
        return
    missing = sorted(REQUIRED_BENCHMARKS - set(entries))
    if missing:
        errors.append("required_benchmark_plan_entries missing: " + ", ".join(missing))
    plan = load_json(BENCHMARK_PLAN)
    names = {bench.get("name") for bench in plan.get("benchmarks", []) if isinstance(bench, dict)}
    plan_missing = sorted(set(entries) - names)
    if plan_missing:
        errors.append("benchmark plan missing scorecard entries: " + ", ".join(plan_missing))


def check_scorecard(scorecard: dict[str, Any], optimizer: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(
        scorecard.get("schema") == "eliza.cpu_npu_2028_readiness_scorecard.v1",
        "scorecard schema mismatch",
        errors,
    )
    require(
        scorecard.get("status") == "modeled_ready_release_blocked",
        "scorecard status must remain modeled_ready_release_blocked",
        errors,
    )
    require(
        "cannot approve phone-class" in str(scorecard.get("claim_boundary", "")),
        "claim boundary must block phone-class claims",
        errors,
    )
    check_modeled_values(scorecard, optimizer, errors)
    check_domains(scorecard, errors)
    check_benchmarks(scorecard, errors)
    blockers = "\n".join(str(item) for item in scorecard.get("release_claim_forbidden_until", []))
    for domain in REQUIRED_DOMAINS:
        require(domain in blockers, f"release blockers missing {domain}", errors)
    return errors


def main() -> int:
    errors: list[str] = []
    run_required_check([sys.executable, str(OPTIMIZER_CHECK)], errors)
    run_required_check([sys.executable, str(WORK_ORDER_CHECK)], errors)
    try:
        errors.extend(check_scorecard(load_yaml(SCORECARD), load_json(OPTIMIZER_REPORT)))
    except (OSError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        errors.append(str(exc))
    if errors:
        print("CPU+NPU 2028 readiness scorecard check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("CPU+NPU 2028 readiness scorecard passed: modeled readiness remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
