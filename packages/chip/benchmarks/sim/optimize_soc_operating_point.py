#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from argparse import Namespace
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_soc_thermal_sweep as soc  # noqa: E402

DEFAULT_OUT = ROOT / "benchmarks/results/soc-optimized-operating-point.json"

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


def frange(start: float, stop: float, step: float) -> list[float]:
    values: list[float] = []
    current = start
    while current <= stop + (step / 2):
        values.append(round(current, 6))
        current += step
    return values


def irange(start: int, stop: int, step: int) -> list[int]:
    return list(range(start, stop + 1, step))


def report_for(
    *,
    cpu_base_power_w: float,
    npu_base_power_w: float,
    npu_base_tops: float,
    memory_sustained_gbps: float,
    cpu_base_ipc: float,
    cpu_base_frequency_hz: int,
    ambient_c: float,
) -> dict[str, Any]:
    args = Namespace(
        cpu_base_ipc=cpu_base_ipc,
        cpu_base_frequency_hz=cpu_base_frequency_hz,
        cpu_base_power_w=cpu_base_power_w,
        npu_base_tops=npu_base_tops,
        npu_base_power_w=npu_base_power_w,
        memory_sustained_gbps=memory_sustained_gbps,
        ambient_c=ambient_c,
    )
    return soc.build_report(args)


def flatten_scenarios(report: dict[str, Any]) -> list[dict[str, Any]]:
    return [scenario for corner in report["process_corners"] for scenario in corner["scenarios"]]


def summarize_candidate(report: dict[str, Any]) -> dict[str, Any]:
    scenarios = flatten_scenarios(report)
    min_bandwidth_margin = min(float(item["memory_bandwidth_margin_gbps"]) for item in scenarios)
    max_die_temp = max(float(item["die_temp_c"]) for item in scenarios)
    max_power = max(float(item["total_power_w"]) for item in scenarios)
    min_perf_per_w = min(float(item["composite_perf_per_w"]) for item in scenarios)
    min_npu_tops = min(float(item["npu_int8_tops"]) for item in scenarios)
    any_throttle = any(bool(item["throttle_required"]) for item in scenarios)
    summary = dict(report["summary"])
    summary.update(
        {
            "min_bandwidth_margin_gbps": min_bandwidth_margin,
            "max_die_temp_c": max_die_temp,
            "max_total_power_w": max_power,
            "min_composite_perf_per_w": min_perf_per_w,
            "min_npu_int8_tops": min_npu_tops,
            "any_modeled_throttle_required": any_throttle,
        }
    )
    return summary


def is_feasible(summary: dict[str, Any], args: argparse.Namespace) -> bool:
    return (
        not bool(summary["any_modeled_throttle_required"])
        and float(summary["max_die_temp_c"]) <= args.max_die_c
        and float(summary["min_bandwidth_margin_gbps"]) >= args.min_bandwidth_margin_gbps
        and float(summary["min_npu_int8_tops"]) >= args.min_npu_tops
    )


def robustness_cases(report: dict[str, Any], args: argparse.Namespace) -> list[dict[str, Any]]:
    config = report["config"]
    base = {
        "cpu_base_power_w": float(config["cpu_base_power_w"]),
        "npu_base_power_w": float(config["npu_base_power_w"]),
        "npu_base_tops": float(config["npu_base_tops"]),
        "memory_sustained_gbps": float(config["memory_sustained_gbps"]),
        "cpu_base_ipc": float(config["cpu_base_ipc"]),
        "cpu_base_frequency_hz": int(config["cpu_base_frequency_hz"]),
        "ambient_c": float(config["ambient_c"]),
    }
    guardbands: tuple[tuple[str, dict[str, float]], ...] = (
        ("selected_nominal", {}),
        ("hot_ambient_35c", {"ambient_c": args.robust_hot_ambient_c}),
        (
            "power_plus_5pct",
            {
                "cpu_base_power_w": base["cpu_base_power_w"] * args.robust_power_scale,
                "npu_base_power_w": base["npu_base_power_w"] * args.robust_power_scale,
            },
        ),
        (
            "memory_minus_5pct",
            {"memory_sustained_gbps": base["memory_sustained_gbps"] * args.robust_memory_scale},
        ),
        (
            "npu_tops_minus_5pct",
            {"npu_base_tops": base["npu_base_tops"] * args.robust_npu_tops_scale},
        ),
        (
            "combined_guardband",
            {
                "ambient_c": args.robust_hot_ambient_c,
                "cpu_base_power_w": base["cpu_base_power_w"] * args.robust_power_scale,
                "npu_base_power_w": base["npu_base_power_w"] * args.robust_power_scale,
                "memory_sustained_gbps": base["memory_sustained_gbps"] * args.robust_memory_scale,
                "npu_base_tops": base["npu_base_tops"] * args.robust_npu_tops_scale,
            },
        ),
    )
    cases = []
    for name, updates in guardbands:
        params = dict(base)
        params.update(updates)
        case_report = report_for(
            cpu_base_power_w=float(params["cpu_base_power_w"]),
            npu_base_power_w=float(params["npu_base_power_w"]),
            npu_base_tops=float(params["npu_base_tops"]),
            memory_sustained_gbps=float(params["memory_sustained_gbps"]),
            cpu_base_ipc=float(params["cpu_base_ipc"]),
            cpu_base_frequency_hz=int(params["cpu_base_frequency_hz"]),
            ambient_c=float(params["ambient_c"]),
        )
        summary = summarize_candidate(case_report)
        cases.append(
            {
                "name": name,
                "config": case_report["config"],
                "summary": summary,
                "pass": is_feasible(summary, args),
            }
        )
    return cases


def robustness_summary(cases: list[dict[str, Any]]) -> dict[str, Any]:
    summaries = [case["summary"] for case in cases]
    failing = [case["name"] for case in cases if not case["pass"]]
    return {
        "case_count": len(cases),
        "pass": not failing,
        "failing_cases": failing,
        "max_die_temp_c": max(float(item["max_die_temp_c"]) for item in summaries),
        "max_total_power_w": max(float(item["max_total_power_w"]) for item in summaries),
        "min_bandwidth_margin_gbps": min(
            float(item["min_bandwidth_margin_gbps"]) for item in summaries
        ),
        "min_npu_int8_tops": min(float(item["min_npu_int8_tops"]) for item in summaries),
        "min_composite_perf_per_w": min(
            float(item["min_composite_perf_per_w"]) for item in summaries
        ),
    }


def score(summary: dict[str, Any]) -> float:
    return (
        float(summary["min_composite_perf_per_w"]) * 1_000_000
        + float(summary["min_npu_int8_tops"]) * 100
        + float(summary["min_bandwidth_margin_gbps"]) * 10
        - float(summary["max_total_power_w"]) * 10
    )


def candidate_payload(report: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "config": report["config"],
        "summary": summary,
        "process_corners": report["process_corners"],
    }


def optimize(args: argparse.Namespace) -> dict[str, Any]:
    baseline = report_for(
        cpu_base_power_w=args.baseline_cpu_power_w,
        npu_base_power_w=args.baseline_npu_power_w,
        npu_base_tops=args.baseline_npu_tops,
        memory_sustained_gbps=args.baseline_memory_sustained_gbps,
        cpu_base_ipc=args.cpu_base_ipc,
        cpu_base_frequency_hz=args.cpu_base_frequency_hz,
        ambient_c=args.ambient_c,
    )
    baseline_summary = summarize_candidate(baseline)
    best_report: dict[str, Any] | None = None
    best_summary: dict[str, Any] | None = None
    best_robustness_cases: list[dict[str, Any]] | None = None
    best_robustness_summary: dict[str, Any] | None = None
    best_score = float("-inf")
    feasible_count = 0
    robust_feasible_count = 0
    evaluated_count = 0

    for cpu_power in frange(args.cpu_power_min_w, args.cpu_power_max_w, args.cpu_power_step_w):
        for npu_power in frange(args.npu_power_min_w, args.npu_power_max_w, args.npu_power_step_w):
            for npu_tops in frange(args.npu_tops_min, args.npu_tops_max, args.npu_tops_step):
                for memory_gbps in irange(
                    args.memory_sustained_min_gbps,
                    args.memory_sustained_max_gbps,
                    args.memory_sustained_step_gbps,
                ):
                    evaluated_count += 1
                    report = report_for(
                        cpu_base_power_w=cpu_power,
                        npu_base_power_w=npu_power,
                        npu_base_tops=npu_tops,
                        memory_sustained_gbps=float(memory_gbps),
                        cpu_base_ipc=args.cpu_base_ipc,
                        cpu_base_frequency_hz=args.cpu_base_frequency_hz,
                        ambient_c=args.ambient_c,
                    )
                    summary = summarize_candidate(report)
                    if not is_feasible(summary, args):
                        continue
                    feasible_count += 1
                    robust_cases = robustness_cases(report, args)
                    robust_summary = robustness_summary(robust_cases)
                    if not robust_summary["pass"]:
                        continue
                    robust_feasible_count += 1
                    candidate_score = score(robust_summary)
                    if candidate_score > best_score:
                        best_score = candidate_score
                        best_report = report
                        best_summary = summary
                        best_robustness_cases = robust_cases
                        best_robustness_summary = robust_summary

    if (
        best_report is None
        or best_summary is None
        or best_robustness_cases is None
        or best_robustness_summary is None
    ):
        raise SystemExit("no feasible operating point found")

    return {
        "schema": "eliza.soc_cpu_npu_operating_point_optimization.v1",
        "status": "pass",
        **FALSE_CLAIM_FLAGS,
        "evidence_class": "deterministic_combined_cpu_npu_arch_model_optimization",
        "claim_boundary": "modeled_only_not_rtl_pdk_silicon_sustained_or_phone_score_evidence",
        "benchmark_success_allowed": True,
        "release_use": "prohibited_until_pdk_extracted_timing_power_thermal_signoff",
        "constraints": {
            "max_die_c": args.max_die_c,
            "min_bandwidth_margin_gbps": args.min_bandwidth_margin_gbps,
            "min_npu_tops": args.min_npu_tops,
            "requires_no_modeled_throttle": True,
        },
        "search_space": {
            "evaluated_count": evaluated_count,
            "feasible_count": feasible_count,
            "robust_feasible_count": robust_feasible_count,
            "cpu_power_w": [args.cpu_power_min_w, args.cpu_power_max_w, args.cpu_power_step_w],
            "npu_power_w": [args.npu_power_min_w, args.npu_power_max_w, args.npu_power_step_w],
            "npu_tops": [args.npu_tops_min, args.npu_tops_max, args.npu_tops_step],
            "memory_sustained_gbps": [
                args.memory_sustained_min_gbps,
                args.memory_sustained_max_gbps,
                args.memory_sustained_step_gbps,
            ],
        },
        "baseline": candidate_payload(baseline, baseline_summary),
        "optimized": candidate_payload(best_report, best_summary),
        "robustness": {
            "claim_boundary": "modeled_guardband_sensitivity_only_not_pdk_or_silicon_evidence",
            "constraints": {
                "hot_ambient_c": args.robust_hot_ambient_c,
                "power_scale": args.robust_power_scale,
                "memory_scale": args.robust_memory_scale,
                "npu_tops_scale": args.robust_npu_tops_scale,
            },
            "summary": best_robustness_summary,
            "cases": best_robustness_cases,
        },
        "improvement": {
            "baseline_any_throttle": baseline_summary["any_modeled_throttle_required"],
            "optimized_any_throttle": best_summary["any_modeled_throttle_required"],
            "max_die_c_delta": best_summary["max_die_temp_c"] - baseline_summary["max_die_temp_c"],
            "max_power_w_delta": best_summary["max_total_power_w"]
            - baseline_summary["max_total_power_w"],
            "min_composite_perf_per_w_ratio": best_summary["min_composite_perf_per_w"]
            / baseline_summary["min_composite_perf_per_w"],
            "min_bandwidth_margin_gbps_delta": best_summary["min_bandwidth_margin_gbps"]
            - baseline_summary["min_bandwidth_margin_gbps"],
        },
        "artifacts": best_report["artifacts"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Optimize modeled CPU+NPU 14A operating point")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--max-die-c", type=float, default=95.0)
    parser.add_argument("--min-bandwidth-margin-gbps", type=float, default=0.0)
    parser.add_argument("--min-npu-tops", type=float, default=20.0)
    parser.add_argument("--ambient-c", type=float, default=25.0)
    parser.add_argument("--cpu-base-ipc", type=float, default=1.80)
    parser.add_argument("--cpu-base-frequency-hz", type=int, default=3_200_000_000)
    parser.add_argument("--baseline-cpu-power-w", type=float, default=3.2)
    parser.add_argument("--baseline-npu-power-w", type=float, default=3.6)
    parser.add_argument("--baseline-npu-tops", type=float, default=36.6)
    parser.add_argument("--baseline-memory-sustained-gbps", type=float, default=120.0)
    parser.add_argument("--cpu-power-min-w", type=float, default=1.4)
    parser.add_argument("--cpu-power-max-w", type=float, default=3.2)
    parser.add_argument("--cpu-power-step-w", type=float, default=0.2)
    parser.add_argument("--npu-power-min-w", type=float, default=1.2)
    parser.add_argument("--npu-power-max-w", type=float, default=3.6)
    parser.add_argument("--npu-power-step-w", type=float, default=0.2)
    parser.add_argument("--npu-tops-min", type=float, default=30.0)
    parser.add_argument("--npu-tops-max", type=float, default=44.0)
    parser.add_argument("--npu-tops-step", type=float, default=1.0)
    parser.add_argument("--memory-sustained-min-gbps", type=int, default=200)
    parser.add_argument("--memory-sustained-max-gbps", type=int, default=240)
    parser.add_argument("--memory-sustained-step-gbps", type=int, default=8)
    parser.add_argument("--robust-hot-ambient-c", type=float, default=35.0)
    parser.add_argument("--robust-power-scale", type=float, default=1.05)
    parser.add_argument("--robust-memory-scale", type=float, default=0.95)
    parser.add_argument("--robust-npu-tops-scale", type=float, default=0.95)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = optimize(args)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
