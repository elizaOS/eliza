#!/usr/bin/env python3
from __future__ import annotations

import json
import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml
from chip_utils import load_json_object, load_yaml_object, require, require_number

ROOT = Path(__file__).resolve().parents[1]
SCORECARD = ROOT / "docs/architecture-optimization/cpu-npu-2028-readiness-scorecard.yaml"
OPTIMIZER_REPORT = ROOT / "benchmarks/results/soc-optimized-operating-point.json"
MODELED_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-modeled-eval.json"
NPU_CONTEXT_QUEUE_SIM = ROOT / "benchmarks/results/npu-context-queue-sim.json"
MEMORY_IOMMU_QOS_SIM = ROOT / "benchmarks/results/memory-iommu-qos-sim.json"
BURST_SUSTAINED_POLICY = ROOT / "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json"
BURST_THERMAL_TRANSIENT = ROOT / "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json"
AOSP_GOVERNOR_TRACE = ROOT / "benchmarks/results/cpu-npu-2028-aosp-governor-trace.json"
PROCESS_EVAL = ROOT / "benchmarks/results/cpu-npu-2028-14a-process-eval.json"
COMPETITIVE_ENVELOPE = ROOT / "benchmarks/results/cpu-npu-2028-competitive-envelope.json"
TAPEOUT_AUDIT = ROOT / "benchmarks/results/cpu-npu-2028-tapeout-readiness-audit.json"
PHONE_CPU_GATE = ROOT / "build/reports/cpu_phone_benchmark_claim_gate.json"
PHONE_CPU_L5_L6_REPORT = ROOT / "build/reports/cpu_phone_l5_l6_benchmark_report.json"
OPTIMIZER_CHECK = ROOT / "scripts/check_soc_optimization.py"
WORK_ORDER_CHECK = ROOT / "scripts/check_soc_optimized_work_order.py"
MODELED_EVAL_CHECK = ROOT / "scripts/check_cpu_npu_modeled_benchmark_eval.py"
NPU_CONTEXT_QUEUE_SIM_CHECK = ROOT / "scripts/check_npu_context_queue_sim.py"
MEMORY_IOMMU_QOS_SIM_CHECK = ROOT / "scripts/check_memory_iommu_qos_sim.py"
BURST_SUSTAINED_POLICY_CHECK = ROOT / "scripts/check_cpu_npu_burst_sustained_policy.py"
BURST_THERMAL_TRANSIENT_CHECK = ROOT / "scripts/check_cpu_npu_burst_thermal_transient.py"
AOSP_GOVERNOR_TRACE_CHECK = ROOT / "scripts/check_cpu_npu_aosp_governor_trace.py"
PROCESS_EVAL_CHECK = ROOT / "scripts/check_cpu_npu_14a_process_eval.py"
COMPETITIVE_ENVELOPE_CHECK = ROOT / "scripts/check_cpu_npu_competitive_envelope.py"
TAPEOUT_AUDIT_CHECK = ROOT / "scripts/check_cpu_npu_tapeout_readiness_audit.py"
PHONE_CPU_GATE_CHECK = ROOT / "scripts/check_cpu_phone_benchmark_claim_gate.py"
BENCHMARK_PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"
MAKEFILE = ROOT / "Makefile"

REQUIRED_DOMAINS = {
    "cpu_ap",
    "branch_prediction",
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
    "npu_arch_sim_sota_2028",
    "simulator_arch_metrics",
    "cpu_arch_sim_sota_2028",
}
REQUIRED_PHONE_CPU_L5_L6_ENTRIES = {
    "spec_cpu2017",
    "coremark",
    "dhrystone",
    "jetstream2",
    "lmbench_bw_mem",
    "lmbench_lat_mem_rd",
}


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
    plan = load_json_object(BENCHMARK_PLAN)
    names = {bench.get("name") for bench in plan.get("benchmarks", []) if isinstance(bench, dict)}
    plan_missing = sorted(set(entries) - names)
    if plan_missing:
        errors.append("benchmark plan missing scorecard entries: " + ", ".join(plan_missing))


def check_phone_cpu_l5_l6(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("phone_cpu_benchmark_gate")
        == "build/reports/cpu_phone_benchmark_claim_gate.json",
        "scorecard must point at phone CPU benchmark gate report",
        errors,
    )
    require(
        source_artifacts.get("phone_cpu_l5_l6_report")
        == "build/reports/cpu_phone_l5_l6_benchmark_report.json",
        "scorecard must point at phone CPU L5/L6 report",
        errors,
    )
    require(
        source_artifacts.get("phone_cpu_l5_l6_command")
        == "make cpu-phone-l5-l6-benchmark-report",
        "scorecard must list phone CPU L5/L6 report command",
        errors,
    )

    listed = scorecard.get("required_phone_cpu_l5_l6_entries")
    if not isinstance(listed, list):
        errors.append("required_phone_cpu_l5_l6_entries must be a list")
        listed = []
    missing_listed = sorted(REQUIRED_PHONE_CPU_L5_L6_ENTRIES - set(listed))
    if missing_listed:
        errors.append(
            "required_phone_cpu_l5_l6_entries missing: " + ", ".join(missing_listed)
        )

    if not PHONE_CPU_GATE.exists() or not PHONE_CPU_L5_L6_REPORT.exists():
        run_required_check([sys.executable, str(PHONE_CPU_GATE_CHECK)], errors)
    if not PHONE_CPU_GATE.exists():
        errors.append("phone CPU benchmark gate report missing")
        return
    if not PHONE_CPU_L5_L6_REPORT.exists():
        errors.append("phone CPU L5/L6 report missing")
        return
    try:
        gate = load_json_object(PHONE_CPU_GATE)
        report = load_json_object(PHONE_CPU_L5_L6_REPORT)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return

    try:
        spec = importlib.util.spec_from_file_location("check_cpu_phone_benchmark_claim_gate", PHONE_CPU_GATE_CHECK)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"unable to import {PHONE_CPU_GATE_CHECK}")
        phone_gate = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = phone_gate
        spec.loader.exec_module(phone_gate)
        expected_gate = phone_gate.build_report(phone_gate.DEFAULT_REPORT)
        expected_l5_l6 = phone_gate.build_l5_l6_report(phone_gate.DEFAULT_REPORT, expected_gate)
        schema_errors = phone_gate.validate_l5_l6_report(expected_l5_l6)
        if schema_errors:
            errors.extend("expected phone CPU L5/L6 report invalid: " + error for error in schema_errors)
        current_schema_errors = phone_gate.validate_l5_l6_report(report)
        if current_schema_errors:
            errors.extend("phone CPU L5/L6 report " + error for error in current_schema_errors)
        if gate != expected_gate:
            errors.append("phone CPU benchmark gate report is stale; run make cpu-phone-l5-l6-benchmark-report")
        if report != expected_l5_l6:
            errors.append("phone CPU L5/L6 report is stale; run make cpu-phone-l5-l6-benchmark-report")
    except Exception as exc:  # noqa: BLE001 - scorecard should report import/build failures as gate errors.
        errors.append(f"unable to rebuild expected phone CPU L5/L6 reports: {exc}")

    require(gate.get("status") == "blocked", "phone CPU benchmark gate must be blocked", errors)
    require(
        gate.get("claim_allowed") is False,
        "phone CPU benchmark gate claim_allowed must remain false",
        errors,
    )
    require(
        report.get("schema") == "eliza.cpu_phone_l5_l6_benchmark_report.v1",
        "phone CPU L5/L6 report schema mismatch",
        errors,
    )
    require(report.get("status") == "blocked", "phone CPU L5/L6 report must be blocked", errors)
    require(
        report.get("claim_allowed") is False,
        "phone CPU L5/L6 report claim_allowed must remain false",
        errors,
    )
    entries = report.get("entries")
    if not isinstance(entries, list):
        errors.append("phone CPU L5/L6 report entries must be a list")
        return
    names = {entry.get("name") for entry in entries if isinstance(entry, dict)}
    missing_entries = sorted(REQUIRED_PHONE_CPU_L5_L6_ENTRIES - names)
    if missing_entries:
        errors.append("phone CPU L5/L6 report missing entries: " + ", ".join(missing_entries))
    satisfied = sorted(
        str(entry.get("name"))
        for entry in entries
        if isinstance(entry, dict) and entry.get("claim_satisfied") is True
    )
    if satisfied:
        errors.append(
            "phone CPU L5/L6 report unexpectedly satisfies entries: " + ", ".join(satisfied)
        )


def check_modeled_eval(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("modeled_benchmark_eval")
        == "benchmarks/results/cpu-npu-2028-modeled-eval.json",
        "scorecard must point at modeled benchmark evaluation report",
        errors,
    )
    require(
        source_artifacts.get("modeled_benchmark_eval_command")
        == "make cpu-npu-modeled-benchmark-eval",
        "scorecard must list modeled benchmark evaluation command",
        errors,
    )
    if not MODELED_EVAL.exists():
        run_required_check([sys.executable, str(MODELED_EVAL_CHECK)], errors)
    if not MODELED_EVAL.exists():
        errors.append("modeled benchmark evaluation report missing")
        return
    try:
        data = load_json_object(MODELED_EVAL)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.cpu_npu_2028_modeled_benchmark_eval.v1",
        "modeled benchmark evaluation schema mismatch",
        errors,
    )
    require(
        data.get("status") == "modeled_eval_release_blocked",
        "modeled benchmark evaluation must remain release-blocked",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("modeled benchmark evaluation missing checks list")
        return
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    for row_id in (
        "npu_sota_dense_peak_target_pass",
        "npu_sota_sparse_int4_target_pass",
        "npu_sota_descriptor_queue_model_pass",
        "memory_model_target_pass",
        "robust_power_thermal_model_pass",
    ):
        require(
            by_id.get(row_id, {}).get("status") == "pass",
            f"modeled benchmark evaluation {row_id} must pass",
            errors,
        )
    require(
        by_id.get("npu_sota_sustained_model_gap", {}).get("status") == "blocked",
        "sustained SOTA NPU check must remain blocked until measured evidence exists",
        errors,
    )


def check_npu_context_queue_sim(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("npu_context_queue_sim")
        == "benchmarks/results/npu-context-queue-sim.json",
        "scorecard must point at NPU context queue simulator report",
        errors,
    )
    require(
        source_artifacts.get("npu_context_queue_sim_command") == "make npu-context-queue-sim-check",
        "scorecard must list NPU context queue simulator command",
        errors,
    )
    if not NPU_CONTEXT_QUEUE_SIM.exists():
        run_required_check([sys.executable, str(NPU_CONTEXT_QUEUE_SIM_CHECK)], errors)
    if not NPU_CONTEXT_QUEUE_SIM.exists():
        errors.append("NPU context queue simulator report missing")
        return
    try:
        data = load_json_object(NPU_CONTEXT_QUEUE_SIM)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.npu_context_queue_sim.v1",
        "NPU context queue simulator schema mismatch",
        errors,
    )
    require(data.get("status") == "pass", "NPU context queue simulator must pass", errors)
    require(
        "not RTL scheduler" in str(data.get("claim_boundary", "")),
        "NPU context queue simulator must block RTL scheduler claims",
        errors,
    )
    config = data.get("config")
    summary = data.get("summary")
    if not isinstance(config, dict) or not isinstance(summary, dict):
        errors.append("NPU context queue simulator missing config or summary")
        return
    require(
        require_number(config.get("concurrent_contexts"), "NPU context count") == 8,
        "NPU context queue simulator must model 8 contexts",
        errors,
    )
    require(
        require_number(config.get("descriptor_queue_depth"), "NPU context queue depth") >= 1024,
        "NPU context queue simulator queue depth below target",
        errors,
    )
    require(
        summary.get("all_contexts_completed") is True,
        "NPU context queue simulator must complete all contexts",
        errors,
    )
    require(
        require_number(summary.get("jain_fairness_index"), "NPU context queue fairness") >= 0.99,
        "NPU context queue simulator fairness index below target",
        errors,
    )
    require(
        require_number(summary.get("max_service_gap_cycles"), "NPU context queue service gap")
        <= 32,
        "NPU context queue simulator service gap exceeds target",
        errors,
    )


def check_memory_iommu_qos_sim(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("memory_iommu_qos_sim")
        == "benchmarks/results/memory-iommu-qos-sim.json",
        "scorecard must point at memory IOMMU/QoS simulator report",
        errors,
    )
    require(
        source_artifacts.get("memory_iommu_qos_sim_command") == "make memory-iommu-qos-sim-check",
        "scorecard must list memory IOMMU/QoS simulator command",
        errors,
    )
    if not MEMORY_IOMMU_QOS_SIM.exists():
        run_required_check([sys.executable, str(MEMORY_IOMMU_QOS_SIM_CHECK)], errors)
    if not MEMORY_IOMMU_QOS_SIM.exists():
        errors.append("memory IOMMU/QoS simulator report missing")
        return
    try:
        data = load_json_object(MEMORY_IOMMU_QOS_SIM)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.memory_iommu_qos_sim.v1",
        "memory IOMMU/QoS simulator schema mismatch",
        errors,
    )
    require(data.get("status") == "pass", "memory IOMMU/QoS simulator must pass", errors)
    require(
        "not RTL IOMMU" in str(data.get("claim_boundary", "")),
        "memory IOMMU/QoS simulator must block RTL IOMMU claims",
        errors,
    )
    config = data.get("config")
    summary = data.get("summary")
    if not isinstance(config, dict) or not isinstance(summary, dict):
        errors.append("memory IOMMU/QoS simulator missing config or summary")
        return
    require(
        config.get("deny_by_default") is True,
        "memory IOMMU/QoS simulator must model deny-by-default IOMMU",
        errors,
    )
    require(
        require_number(config.get("stream_count"), "memory stream count") >= 9,
        "memory IOMMU/QoS simulator stream count below target",
        errors,
    )
    require(
        summary.get("unauthorized_accesses_blocked") is True,
        "memory IOMMU/QoS simulator must block unauthorized accesses",
        errors,
    )
    require(
        require_number(summary.get("fault_probe_count"), "memory IOMMU faults") >= 4,
        "memory IOMMU/QoS simulator fault probe coverage too small",
        errors,
    )
    require(
        require_number(summary.get("display_underflow_count"), "display underflows") == 0,
        "memory IOMMU/QoS simulator must avoid modeled display underflow",
        errors,
    )
    require(
        require_number(summary.get("isochronous_max_service_gap_cycles"), "isochronous gap") <= 32,
        "memory IOMMU/QoS simulator isochronous gap exceeds target",
        errors,
    )


def check_burst_sustained_policy(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("burst_sustained_policy")
        == "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json",
        "scorecard must point at burst/sustained policy report",
        errors,
    )
    require(
        source_artifacts.get("burst_sustained_policy_command")
        == "make cpu-npu-burst-sustained-policy",
        "scorecard must list burst/sustained policy command",
        errors,
    )
    if not BURST_SUSTAINED_POLICY.exists():
        run_required_check([sys.executable, str(BURST_SUSTAINED_POLICY_CHECK)], errors)
    if not BURST_SUSTAINED_POLICY.exists():
        errors.append("burst/sustained policy report missing")
        return
    try:
        data = load_json_object(BURST_SUSTAINED_POLICY)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.cpu_npu_2028_burst_sustained_policy.v1",
        "burst/sustained policy schema mismatch",
        errors,
    )
    require(
        data.get("status") == "modeled_policy_release_blocked",
        "burst/sustained policy must remain release-blocked",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("burst/sustained policy missing checks")
        return
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    for row_id in ("sustained_no_throttle_policy_pass", "burst_peak_policy_pass"):
        require(by_id.get(row_id, {}).get("status") == "pass", f"{row_id} must pass", errors)
    for row_id in ("sustained_npu_target_release_blocked", "burst_power_duration_release_blocked"):
        require(
            by_id.get(row_id, {}).get("status") == "blocked",
            f"{row_id} must remain blocked",
            errors,
        )


def check_burst_thermal_transient(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("burst_thermal_transient")
        == "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json",
        "scorecard must point at burst thermal transient report",
        errors,
    )
    require(
        source_artifacts.get("burst_thermal_transient_command")
        == "make cpu-npu-burst-thermal-transient",
        "scorecard must list burst thermal transient command",
        errors,
    )
    if not BURST_THERMAL_TRANSIENT.exists():
        run_required_check([sys.executable, str(BURST_THERMAL_TRANSIENT_CHECK)], errors)
    if not BURST_THERMAL_TRANSIENT.exists():
        errors.append("burst thermal transient report missing")
        return
    try:
        data = load_json_object(BURST_THERMAL_TRANSIENT)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.cpu_npu_2028_burst_thermal_transient.v1",
        "burst thermal transient schema mismatch",
        errors,
    )
    require(
        data.get("status") == "modeled_transient_release_blocked",
        "burst thermal transient must remain release-blocked",
        errors,
    )
    recommended = data.get("recommended")
    if not isinstance(recommended, dict):
        errors.append("burst thermal transient missing recommended section")
        return
    duration = recommended.get("modeled_recommended_burst_duration_s")
    worst = recommended.get("worst_case_time_to_95c_s")
    require(
        isinstance(duration, int | float) and not isinstance(duration, bool) and duration > 0.0,
        "modeled recommended burst duration must be positive",
        errors,
    )
    require(
        isinstance(worst, int | float)
        and not isinstance(worst, bool)
        and isinstance(duration, int | float)
        and duration <= worst,
        "modeled recommended burst duration must stay within worst-case limit",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("burst thermal transient missing checks")
        return
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    for row_id in ("transient_model_inputs_pass", "modeled_burst_window_pass"):
        require(by_id.get(row_id, {}).get("status") == "pass", f"{row_id} must pass", errors)
    require(
        by_id.get("release_duration_claim_blocked", {}).get("status") == "blocked",
        "release_duration_claim_blocked must remain blocked",
        errors,
    )


def check_aosp_governor_trace(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("aosp_governor_trace")
        == "benchmarks/results/cpu-npu-2028-aosp-governor-trace.json",
        "scorecard must point at modeled AOSP governor trace",
        errors,
    )
    require(
        source_artifacts.get("aosp_governor_trace_command") == "make cpu-npu-aosp-governor-trace",
        "scorecard must list modeled AOSP governor trace command",
        errors,
    )
    if not AOSP_GOVERNOR_TRACE.exists():
        run_required_check([sys.executable, str(AOSP_GOVERNOR_TRACE_CHECK)], errors)
    if not AOSP_GOVERNOR_TRACE.exists():
        errors.append("modeled AOSP governor trace report missing")
        return
    try:
        data = load_json_object(AOSP_GOVERNOR_TRACE)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.cpu_npu_2028_aosp_governor_trace.v1",
        "modeled AOSP governor trace schema mismatch",
        errors,
    )
    require(
        data.get("status") == "modeled_aosp_trace_release_blocked",
        "modeled AOSP governor trace must remain release-blocked",
        errors,
    )
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("modeled AOSP governor trace missing summary")
        return
    require(
        isinstance(summary.get("repeat_burst_denied"), bool)
        and summary["repeat_burst_denied"] is True,
        "modeled AOSP governor trace must deny repeat burst during cooldown",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("modeled AOSP governor trace missing checks")
        return
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    for row_id in (
        "aosp_mapping_inputs_pass",
        "scheduler_selects_sustained_and_burst_pass",
        "thermal_hysteresis_blocks_repeat_burst_pass",
        "modeled_trace_stays_below_die_limit_pass",
    ):
        require(by_id.get(row_id, {}).get("status") == "pass", f"{row_id} must pass", errors)
    require(
        by_id.get("local_aosp_simulator_evidence_blocked", {}).get("status") == "blocked",
        "local_aosp_simulator_evidence_blocked must remain blocked",
        errors,
    )


def check_process_eval(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("process_14a_eval")
        == "benchmarks/results/cpu-npu-2028-14a-process-eval.json",
        "scorecard must point at CPU+NPU 14A process eval",
        errors,
    )
    require(
        source_artifacts.get("process_14a_eval_command") == "make cpu-npu-14a-process-eval",
        "scorecard must list CPU+NPU 14A process eval command",
        errors,
    )
    if not PROCESS_EVAL.exists():
        run_required_check([sys.executable, str(PROCESS_EVAL_CHECK)], errors)
    if not PROCESS_EVAL.exists():
        errors.append("CPU+NPU 14A process eval report missing")
        return
    try:
        data = load_json_object(PROCESS_EVAL)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.cpu_npu_2028_14a_process_eval.v1",
        "CPU+NPU 14A process eval schema mismatch",
        errors,
    )
    require(
        data.get("status") == "modeled_process_eval_release_blocked",
        "CPU+NPU 14A process eval must remain release-blocked",
        errors,
    )
    effect_results = data.get("effect_results")
    if not isinstance(effect_results, list):
        errors.append("CPU+NPU 14A process eval missing effect_results")
        return
    required_effects = {
        "node_identity_and_pdk_binding",
        "nanosheet_device_variability",
        "frontside_vs_backside_power_delivery",
        "interconnect_rc_and_congestion",
        "self_heating_and_power_density",
        "sram_density_vmin_and_ecc",
        "reliability_aging_and_lifetime",
        "dft_yield_and_debug_lock",
    }
    seen_effects = {item.get("id") for item in effect_results if isinstance(item, dict)}
    missing = sorted(required_effects - seen_effects)
    require(not missing, "CPU+NPU 14A process eval missing: " + ", ".join(missing), errors)
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("CPU+NPU 14A process eval missing checks")
        return
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    for row_id in (
        "all_required_14a_effects_modeled",
        "modeled_effects_preserve_sustained_guardband",
        "modeled_sota_headroom_after_process_derates",
    ):
        require(by_id.get(row_id, {}).get("status") == "pass", f"{row_id} must pass", errors)
    require(
        by_id.get("pdk_signoff_release_blocked", {}).get("status") == "blocked",
        "pdk_signoff_release_blocked must remain blocked",
        errors,
    )


def check_competitive_envelope(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("competitive_envelope")
        == "benchmarks/results/cpu-npu-2028-competitive-envelope.json",
        "scorecard must point at competitive envelope report",
        errors,
    )
    require(
        source_artifacts.get("competitive_envelope_command") == "make cpu-npu-competitive-envelope",
        "scorecard must list competitive envelope command",
        errors,
    )
    if not COMPETITIVE_ENVELOPE.exists():
        run_required_check([sys.executable, str(COMPETITIVE_ENVELOPE_CHECK)], errors)
    if not COMPETITIVE_ENVELOPE.exists():
        errors.append("competitive envelope report missing")
        return
    try:
        data = load_json_object(COMPETITIVE_ENVELOPE)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.cpu_npu_2028_competitive_envelope.v1",
        "competitive envelope schema mismatch",
        errors,
    )
    require(
        data.get("status") == "modeled_competitive_envelope_release_blocked",
        "competitive envelope must remain release-blocked",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("competitive envelope missing checks")
        return
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    for row_id in (
        "cpu_peak_envelope_pass",
        "cpu_process_derated_envelope_pass",
        "cpu_efficiency_envelope_pass",
        "npu_peak_envelope_pass",
        "npu_process_derated_peak_envelope_pass",
        "npu_sparse_envelope_pass",
        "memory_envelope_pass",
        "sustained_power_envelope_pass",
        "burst_power_thermal_envelope_pass",
    ):
        require(by_id.get(row_id, {}).get("status") == "pass", f"{row_id} must pass", errors)
    for row_id in ("npu_worst_corner_envelope_blocked", "future_pixel_comparison_release_blocked"):
        require(
            by_id.get(row_id, {}).get("status") == "blocked",
            f"{row_id} must remain blocked",
            errors,
        )


def check_tapeout_readiness_audit(scorecard: dict[str, Any], errors: list[str]) -> None:
    source_artifacts = scorecard.get("source_artifacts")
    if not isinstance(source_artifacts, dict):
        errors.append("source_artifacts must be a mapping")
        return
    require(
        source_artifacts.get("tapeout_readiness_audit")
        == "benchmarks/results/cpu-npu-2028-tapeout-readiness-audit.json",
        "scorecard must point at tapeout readiness audit",
        errors,
    )
    require(
        source_artifacts.get("tapeout_readiness_audit_command")
        == "make cpu-npu-tapeout-readiness-audit",
        "scorecard must list tapeout readiness audit command",
        errors,
    )
    if not TAPEOUT_AUDIT.exists():
        run_required_check([sys.executable, str(TAPEOUT_AUDIT_CHECK)], errors)
    if not TAPEOUT_AUDIT.exists():
        errors.append("tapeout readiness audit missing")
        return
    try:
        data = load_json_object(TAPEOUT_AUDIT)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
        return
    require(
        data.get("schema") == "eliza.cpu_npu_2028_tapeout_readiness_audit.v1",
        "tapeout readiness audit schema mismatch",
        errors,
    )
    require(
        data.get("status") == "tapeout_release_blocked",
        "tapeout readiness audit must remain release-blocked",
        errors,
    )
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("tapeout readiness audit missing summary")
        return
    require(
        summary.get("modeled_local_complete") is True,
        "tapeout readiness audit must show modeled local stack complete",
        errors,
    )
    blocked_count = summary.get("blocked_proof_domain_count")
    require(
        isinstance(blocked_count, int | float)
        and not isinstance(blocked_count, bool)
        and blocked_count > 0,
        "tapeout readiness audit must keep proof domains blocked",
        errors,
    )
    benchmark_blocked_count = summary.get("blocked_benchmark_count")
    require(
        isinstance(benchmark_blocked_count, int | float)
        and not isinstance(benchmark_blocked_count, bool)
        and benchmark_blocked_count > 0,
        "tapeout readiness audit must keep benchmark release rows blocked",
        errors,
    )
    benchmark_requirements = summary.get("blocked_benchmark_requirements")
    require(
        isinstance(benchmark_requirements, list)
        and "benchmarks/capabilities/e1_npu_nnapi.proof.json" in benchmark_requirements,
        "tapeout readiness audit must enumerate blocked e1 NPU NNAPI proof evidence",
        errors,
    )
    benchmark_rows = data.get("benchmark_release_readiness")
    require(
        isinstance(benchmark_rows, list)
        and any(
            isinstance(row, dict)
            and row.get("id") == "tflite_e1_npu"
            and row.get("status") == "blocked"
            for row in benchmark_rows
        ),
        "tapeout readiness audit must keep tflite_e1_npu release benchmark blocked",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("tapeout readiness audit missing checks")
        return
    by_id = {item.get("id"): item for item in checks if isinstance(item, dict)}
    for row_id in ("modeled_cpu_npu_stack_complete", "competitive_envelope_metrics_pass"):
        require(by_id.get(row_id, {}).get("status") == "pass", f"{row_id} must pass", errors)
    for row_id in ("release_evidence_incomplete_blocked", "final_tapeout_claim_blocked"):
        require(
            by_id.get(row_id, {}).get("status") == "blocked",
            f"{row_id} must remain blocked",
            errors,
        )


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
    check_phone_cpu_l5_l6(scorecard, errors)
    check_modeled_eval(scorecard, errors)
    check_npu_context_queue_sim(scorecard, errors)
    check_memory_iommu_qos_sim(scorecard, errors)
    check_burst_sustained_policy(scorecard, errors)
    check_burst_thermal_transient(scorecard, errors)
    check_aosp_governor_trace(scorecard, errors)
    check_process_eval(scorecard, errors)
    check_competitive_envelope(scorecard, errors)
    check_tapeout_readiness_audit(scorecard, errors)
    blockers = "\n".join(str(item) for item in scorecard.get("release_claim_forbidden_until", []))
    for domain in REQUIRED_DOMAINS:
        require(domain in blockers, f"release blockers missing {domain}", errors)
    return errors


def main() -> int:
    errors: list[str] = []
    run_required_check([sys.executable, str(OPTIMIZER_CHECK)], errors)
    run_required_check([sys.executable, str(WORK_ORDER_CHECK)], errors)
    try:
        errors.extend(
            check_scorecard(load_yaml_object(SCORECARD), load_json_object(OPTIMIZER_REPORT))
        )
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
