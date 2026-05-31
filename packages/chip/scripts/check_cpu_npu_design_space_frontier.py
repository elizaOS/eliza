#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from argparse import Namespace
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "benchmarks/sim"))

import optimize_soc_operating_point as opt  # noqa: E402

OUT = ROOT / "benchmarks/results/cpu-npu-2028-design-space-frontier.json"

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "target_benchmark_claim_allowed": False,
    "aosp_runtime_claim_allowed": False,
    "pdk_signoff_claim_allowed": False,
    "post_route_signoff_claim_allowed": False,
    "silicon_claim_allowed": False,
    "phone_class_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def default_args() -> Namespace:
    return Namespace(
        max_die_c=95.0,
        min_bandwidth_margin_gbps=0.0,
        min_npu_tops=20.0,
        ambient_c=25.0,
        cpu_base_ipc=1.80,
        cpu_base_frequency_hz=3_200_000_000,
        baseline_cpu_power_w=3.2,
        baseline_npu_power_w=3.6,
        baseline_npu_tops=36.6,
        baseline_memory_sustained_gbps=120.0,
        cpu_power_min_w=1.4,
        cpu_power_max_w=3.2,
        cpu_power_step_w=0.2,
        npu_power_min_w=1.2,
        npu_power_max_w=3.6,
        npu_power_step_w=0.2,
        npu_tops_min=30.0,
        npu_tops_max=44.0,
        npu_tops_step=1.0,
        memory_sustained_min_gbps=200,
        memory_sustained_max_gbps=240,
        memory_sustained_step_gbps=8,
        robust_hot_ambient_c=35.0,
        robust_power_scale=1.05,
        robust_memory_scale=0.95,
        robust_npu_tops_scale=0.95,
    )


def candidate_id(config: dict[str, Any]) -> str:
    return (
        f"cpu{float(config['cpu_base_power_w']):.1f}_"
        f"npu{float(config['npu_base_power_w']):.1f}_"
        f"tops{float(config['npu_base_tops']):.1f}_"
        f"mem{int(config['memory_sustained_gbps'])}"
    )


def dominates(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_s = left["robust_summary"]
    right_s = right["robust_summary"]
    better_or_equal = (
        float(left_s["min_composite_perf_per_w"]) >= float(right_s["min_composite_perf_per_w"])
        and float(left_s["min_npu_int8_tops"]) >= float(right_s["min_npu_int8_tops"])
        and float(left_s["min_bandwidth_margin_gbps"])
        >= float(right_s["min_bandwidth_margin_gbps"])
        and float(left_s["max_total_power_w"]) <= float(right_s["max_total_power_w"])
        and float(left_s["max_die_temp_c"]) <= float(right_s["max_die_temp_c"])
    )
    strictly_better = (
        float(left_s["min_composite_perf_per_w"]) > float(right_s["min_composite_perf_per_w"])
        or float(left_s["min_npu_int8_tops"]) > float(right_s["min_npu_int8_tops"])
        or float(left_s["min_bandwidth_margin_gbps"]) > float(right_s["min_bandwidth_margin_gbps"])
        or float(left_s["max_total_power_w"]) < float(right_s["max_total_power_w"])
        or float(left_s["max_die_temp_c"]) < float(right_s["max_die_temp_c"])
    )
    return better_or_equal and strictly_better


def compact_candidate(
    report: dict[str, Any], summary: dict[str, Any], args: Namespace
) -> dict[str, Any]:
    robust_cases = opt.robustness_cases(report, args)
    robust_summary = opt.robustness_summary(robust_cases)
    config = report["config"]
    return {
        "id": candidate_id(config),
        "config": config,
        "nominal_summary": summary,
        "robust_summary": robust_summary,
        "score": opt.score(robust_summary),
        "pass": opt.is_feasible(summary, args) and bool(robust_summary["pass"]),
    }


def build_report() -> dict[str, Any]:
    args = default_args()
    selected = opt.optimize(args)
    selected_config = selected["optimized"]["config"]
    candidates: list[dict[str, Any]] = []
    evaluated_count = 0
    feasible_count = 0

    for cpu_power in opt.frange(args.cpu_power_min_w, args.cpu_power_max_w, args.cpu_power_step_w):
        for npu_power in opt.frange(
            args.npu_power_min_w, args.npu_power_max_w, args.npu_power_step_w
        ):
            for npu_tops in opt.frange(args.npu_tops_min, args.npu_tops_max, args.npu_tops_step):
                for memory_gbps in opt.irange(
                    args.memory_sustained_min_gbps,
                    args.memory_sustained_max_gbps,
                    args.memory_sustained_step_gbps,
                ):
                    evaluated_count += 1
                    report = opt.report_for(
                        cpu_base_power_w=cpu_power,
                        npu_base_power_w=npu_power,
                        npu_base_tops=npu_tops,
                        memory_sustained_gbps=float(memory_gbps),
                        cpu_base_ipc=args.cpu_base_ipc,
                        cpu_base_frequency_hz=args.cpu_base_frequency_hz,
                        ambient_c=args.ambient_c,
                    )
                    summary = opt.summarize_candidate(report)
                    if not opt.is_feasible(summary, args):
                        continue
                    feasible_count += 1
                    candidate = compact_candidate(report, summary, args)
                    if candidate["pass"]:
                        candidates.append(candidate)

    frontier = [
        candidate
        for candidate in candidates
        if not any(other is not candidate and dominates(other, candidate) for other in candidates)
    ]
    frontier.sort(
        key=lambda item: (
            -float(item["score"]),
            float(item["robust_summary"]["max_total_power_w"]),
            -float(item["robust_summary"]["min_bandwidth_margin_gbps"]),
        )
    )
    selected_id = candidate_id(selected_config)
    selected_rows = [candidate for candidate in candidates if candidate["id"] == selected_id]
    selected_frontier = [candidate for candidate in frontier if candidate["id"] == selected_id]
    top_score = max(float(candidate["score"]) for candidate in candidates)
    selected_score = float(selected_rows[0]["score"]) if selected_rows else float("-inf")
    checks = [
        {
            "id": "robust_feasible_candidates_found",
            "status": "pass" if candidates else "fail",
            "evidence": "Design-space search found robust feasible CPU/NPU operating points.",
        },
        {
            "id": "selected_point_on_pareto_frontier",
            "status": "pass" if selected_frontier else "fail",
            "evidence": "Selected CPU/NPU point is not dominated across perf/W, TOPS, bandwidth margin, power, and die temperature.",
        },
        {
            "id": "selected_point_is_score_optimal",
            "status": "pass" if abs(selected_score - top_score) < 1e-9 else "fail",
            "evidence": "Selected CPU/NPU point matches the optimizer score maximum across robust feasible candidates.",
        },
        {
            "id": "release_claim_blocked",
            "status": "blocked",
            "evidence": "Pareto frontier is modeled-only; target benchmarks, PDK, and measured power/thermal evidence are still required.",
        },
    ]
    failed = [row["id"] for row in checks if row["status"] == "fail"]
    return {
        "schema": "eliza.cpu_npu_2028_design_space_frontier.v1",
        "status": "fail" if failed else "modeled_frontier_release_blocked",
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Deterministic modeled CPU/NPU design-space frontier only; not target benchmark, "
            "AOSP, PDK, post-route, silicon, or phone-class evidence."
        ),
        "source_artifacts": {
            "optimizer_report": "benchmarks/results/soc-optimized-operating-point.json",
            "optimizer_command": "make soc-optimization",
        },
        "search_space": {
            "evaluated_count": evaluated_count,
            "feasible_count": feasible_count,
            "robust_feasible_count": len(candidates),
            "frontier_count": len(frontier),
        },
        "selected": {
            "id": selected_id,
            "config": selected_config,
            "score": selected_score,
            "frontier_rank": next(
                (index + 1 for index, row in enumerate(frontier) if row["id"] == selected_id),
                None,
            ),
            "robust_summary": selected_rows[0]["robust_summary"] if selected_rows else {},
        },
        "top_frontier": frontier[:16],
        "checks": checks,
        "release_claim_forbidden_until": [
            "Target benchmark binaries and calibrated metadata pass strict benchmark gates.",
            "AOSP simulator evidence proves scheduler, thermal, and NNAPI behavior.",
            "Measured power/thermal traces replace modeled guardbands.",
            "Selected 14A PDK signoff replaces planning derates.",
        ],
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.cpu_npu_2028_design_space_frontier.v1":
        errors.append("schema mismatch")
    if data.get("status") != "modeled_frontier_release_blocked":
        errors.append("frontier status must remain modeled_frontier_release_blocked")
    if "not target benchmark" not in str(data.get("claim_boundary", "")):
        errors.append("claim boundary must block target benchmark claims")
    for flag in FALSE_CLAIM_FLAGS:
        if data.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")
    search = data.get("search_space")
    if not isinstance(search, dict):
        errors.append("search_space must be a mapping")
    else:
        for key in ("evaluated_count", "feasible_count", "robust_feasible_count", "frontier_count"):
            value = search.get(key)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                errors.append(f"search_space.{key} must be positive")
    selected = data.get("selected")
    if not isinstance(selected, dict):
        errors.append("selected must be a mapping")
    else:
        if selected.get("id") != "cpu1.4_npu1.2_tops44.0_mem240":
            errors.append("selected operating point drifted")
        if selected.get("frontier_rank") is None:
            errors.append("selected point must be on the Pareto frontier")
    checks = data.get("checks")
    if not isinstance(checks, list):
        errors.append("checks must be a list")
        return errors
    by_id = {row.get("id"): row for row in checks if isinstance(row, dict)}
    for row_id in (
        "robust_feasible_candidates_found",
        "selected_point_on_pareto_frontier",
        "selected_point_is_score_optimal",
    ):
        if by_id.get(row_id, {}).get("status") != "pass":
            errors.append(f"{row_id} must pass")
    if by_id.get("release_claim_blocked", {}).get("status") != "blocked":
        errors.append("release claim must remain blocked")
    return errors


def main() -> int:
    try:
        report = build_report()
        errors = validate_report(report)
    except (OSError, ValueError, KeyError) as exc:
        print("CPU+NPU design-space frontier check failed:")
        print(f"  - {exc}")
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        print("CPU+NPU design-space frontier check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"CPU+NPU design-space frontier passed: {OUT.relative_to(ROOT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
