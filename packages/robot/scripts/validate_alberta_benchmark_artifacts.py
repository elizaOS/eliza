"""Validate Alberta-vs-baseline continual benchmark artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

REQUIRED_METRICS = ("acc", "bwt", "forgetting", "fwt")
REQUIRED_LEARNERS = ("alberta", "ppo")


def _load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int | float)
        and math.isfinite(float(value))
    )


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if not isinstance(value, int):
        return None
    return value if value > 0 else None


def _metric_block_ok(summary: dict[str, Any], learner: str) -> bool:
    block = summary.get(learner)
    if not isinstance(block, dict):
        return False
    for metric in REQUIRED_METRICS:
        item = block.get(metric)
        if not isinstance(item, dict):
            return False
        if not _finite_number(item.get("mean")):
            return False
        if not _finite_number(item.get("std")) or float(item.get("std")) < 0.0:
            return False
    return True


def _mean(summary: dict[str, Any], learner: str, metric: str) -> float | None:
    block = summary.get(learner)
    if not isinstance(block, dict):
        return None
    item = block.get(metric)
    if not isinstance(item, dict):
        return None
    value = item.get("mean")
    return float(value) if _finite_number(value) else None


def _matrix_shape_ok(result: dict[str, Any], n_tasks: int) -> bool:
    matrix = result.get("matrix")
    baseline = result.get("baseline")
    if not isinstance(matrix, list) or not isinstance(baseline, list):
        return False
    if len(matrix) != n_tasks or len(baseline) != n_tasks:
        return False
    for row in matrix:
        if not isinstance(row, list) or len(row) != n_tasks:
            return False
        if not all(_finite_number(value) for value in row):
            return False
    return all(_finite_number(value) for value in baseline)


def _motion_matrix_shape_ok(result: dict[str, Any], n_tasks: int) -> bool:
    matrix = result.get("motion_matrix")
    baseline = result.get("motion_baseline")
    if not isinstance(matrix, list) or not isinstance(baseline, list):
        return False
    if len(matrix) != n_tasks or len(baseline) != n_tasks:
        return False
    required = (
        "success_rate",
        "collision_rate",
        "passed_obstacle_rate",
        "mean_forward_progress_m",
        "mean_goal_dist",
        "min_obstacle_clearance_m",
    )
    for row in matrix:
        if not isinstance(row, list) or len(row) != n_tasks:
            return False
        for item in row:
            if not isinstance(item, dict):
                return False
            if not all(_finite_number(item.get(key)) for key in required):
                return False
    for item in baseline:
        if not isinstance(item, dict):
            return False
        if not all(_finite_number(item.get(key)) for key in required):
            return False
    return True


def _trajectory_matrix_shape_ok(result: dict[str, Any], n_tasks: int) -> bool:
    matrix = result.get("trajectory_matrix")
    if not isinstance(matrix, list) or len(matrix) != n_tasks:
        return False
    for row in matrix:
        if not isinstance(row, list) or len(row) != n_tasks:
            return False
        for item in row:
            if not isinstance(item, dict):
                return False
            steps = item.get("steps")
            summary = item.get("summary")
            if not isinstance(steps, list) or len(steps) < 2:
                return False
            if not isinstance(summary, dict):
                return False
            if not _finite_number(summary.get("mean_forward_progress_m")):
                return False
            endpoints = (steps[0], steps[-1])
            if not all(isinstance(step, dict) for step in endpoints):
                return False
            if not all(
                _finite_number(step.get("x")) and _finite_number(step.get("y"))
                for step in endpoints
            ):
                return False
    return True


def _average_motion(items: Any) -> dict[str, float] | None:
    if not isinstance(items, list) or not items:
        return None
    required = (
        "success_rate",
        "passed_obstacle_rate",
        "mean_forward_progress_m",
        "mean_return",
    )
    rows = [item for item in items if isinstance(item, dict)]
    if len(rows) != len(items):
        return None
    out: dict[str, float] = {}
    for key in required:
        values = [item.get(key) for item in rows]
        if not all(_finite_number(value) for value in values):
            return None
        out[key] = float(sum(float(value) for value in values) / len(values))
    return out


def _final_motion_row_average(result: dict[str, Any]) -> dict[str, float] | None:
    matrix = result.get("motion_matrix")
    if not isinstance(matrix, list) or not matrix:
        return None
    return _average_motion(matrix[-1])


def _obstacle_baseline_comparisons(
    results: list[Any],
) -> dict[str, Any]:
    by_learner: dict[str, dict[str, float]] = {}
    for result in results:
        if not isinstance(result, dict):
            continue
        name = result.get("name")
        if name not in REQUIRED_LEARNERS:
            continue
        baseline = _average_motion(result.get("motion_baseline"))
        final = _final_motion_row_average(result)
        if baseline is None or final is None:
            continue
        by_learner[str(name)] = {
            "baseline_success_rate": baseline["success_rate"],
            "baseline_passed_obstacle_rate": baseline["passed_obstacle_rate"],
            "baseline_forward_progress_m": baseline["mean_forward_progress_m"],
            "baseline_return": baseline["mean_return"],
            "final_success_rate": final["success_rate"],
            "final_passed_obstacle_rate": final["passed_obstacle_rate"],
            "final_forward_progress_m": final["mean_forward_progress_m"],
            "final_return": final["mean_return"],
            "delta_success_rate": final["success_rate"] - baseline["success_rate"],
            "delta_passed_obstacle_rate": (
                final["passed_obstacle_rate"] - baseline["passed_obstacle_rate"]
            ),
            "delta_forward_progress_m": (
                final["mean_forward_progress_m"] - baseline["mean_forward_progress_m"]
            ),
            "delta_return": final["mean_return"] - baseline["mean_return"],
        }
    baseline_is_control = all(
        learner in by_learner
        and by_learner[learner]["baseline_forward_progress_m"] <= 0.5
        and by_learner[learner]["baseline_passed_obstacle_rate"] <= 0.25
        and by_learner[learner]["baseline_success_rate"] <= 0.25
        for learner in REQUIRED_LEARNERS
    )
    learning_beats_baseline = any(
        learner in by_learner
        and by_learner[learner]["delta_forward_progress_m"] >= 1.0
        and by_learner[learner]["delta_passed_obstacle_rate"] >= 0.5
        and by_learner[learner]["delta_success_rate"] >= 0.5
        for learner in REQUIRED_LEARNERS
    )
    return {
        "by_learner": by_learner,
        "baseline_is_control": baseline_is_control,
        "learning_beats_baseline": learning_beats_baseline,
    }


def _trace_bool(value: Any) -> bool:
    return bool(value) if isinstance(value, bool) else False


def _trace_float(value: Any) -> float | None:
    return float(value) if _finite_number(value) else None


def _trace_summary_consistent(trace: dict[str, Any]) -> bool:
    steps = trace.get("steps")
    summary = trace.get("summary")
    obstacle = trace.get("obstacle")
    goal = trace.get("goal")
    if not isinstance(steps, list) or len(steps) < 2:
        return False
    if not isinstance(summary, dict) or not isinstance(obstacle, dict):
        return False
    if not isinstance(goal, list) or len(goal) != 2:
        return False
    if not all(_finite_number(value) for value in goal):
        return False
    if not all(
        _finite_number(obstacle.get(key)) for key in ("x", "y", "radius")
    ):
        return False
    rows = [step for step in steps if isinstance(step, dict)]
    if len(rows) != len(steps):
        return False
    if not all(_finite_number(step.get("x")) and _finite_number(step.get("y")) for step in rows):
        return False
    final = rows[-1]
    xs = [float(step["x"]) for step in rows]
    obstacle_x = float(obstacle["x"])
    obstacle_radius = float(obstacle["radius"])
    passed_ever = any(_trace_bool(step.get("passed_obstacle")) for step in rows)
    collision_ever = any(_trace_bool(step.get("collision")) for step in rows)
    goal_reached = _trace_bool(final.get("goal_reached"))
    final_progress = _trace_float(final.get("forward_progress_m"))
    summary_progress = _trace_float(summary.get("mean_forward_progress_m"))
    summary_passed = _trace_float(summary.get("passed_obstacle_rate"))
    summary_collision = _trace_float(summary.get("collision_rate"))
    summary_success = _trace_float(summary.get("success_rate"))
    if None in (
        final_progress,
        summary_progress,
        summary_passed,
        summary_collision,
        summary_success,
    ):
        return False
    if abs(float(summary_progress) - float(final_progress)) > 1e-5:
        return False
    expected_passed = 1.0 if _trace_bool(final.get("passed_obstacle")) else 0.0
    expected_collision = 1.0 if collision_ever else 0.0
    expected_success = 1.0 if goal_reached else 0.0
    if abs(float(summary_passed) - expected_passed) > 1e-5:
        return False
    if abs(float(summary_collision) - expected_collision) > 1e-5:
        return False
    if abs(float(summary_success) - expected_success) > 1e-5:
        return False
    if float(summary_passed) > 0.0 and not (
        passed_ever and max(xs) > obstacle_x + obstacle_radius
    ):
        return False
    return not (
        float(summary_success) > 0.0
        and not (goal_reached and passed_ever and max(xs) > obstacle_x + obstacle_radius)
    )


def _obstacle_trace_rollout_evidence(results: list[Any]) -> dict[str, Any]:
    by_learner: dict[str, dict[str, Any]] = {}
    all_trace_summaries_consistent = True
    for result in results:
        if not isinstance(result, dict):
            continue
        learner = result.get("name")
        if not isinstance(learner, str):
            continue
        matrix = result.get("trajectory_matrix")
        if not isinstance(matrix, list) or not matrix:
            continue
        consistent_count = 0
        inconsistent_count = 0
        final_successful_clear_count = 0
        final_pass_count = 0
        final_collision_count = 0
        final_trace_count = 0
        for row_index, row in enumerate(matrix):
            if not isinstance(row, list):
                all_trace_summaries_consistent = False
                continue
            for trace in row:
                if not isinstance(trace, dict):
                    all_trace_summaries_consistent = False
                    inconsistent_count += 1
                    continue
                consistent = _trace_summary_consistent(trace)
                if consistent:
                    consistent_count += 1
                else:
                    inconsistent_count += 1
                    all_trace_summaries_consistent = False
                if row_index != len(matrix) - 1:
                    continue
                final_trace_count += 1
                steps = trace.get("steps") if isinstance(trace.get("steps"), list) else []
                rows = [step for step in steps if isinstance(step, dict)]
                summary = trace.get("summary") if isinstance(trace.get("summary"), dict) else {}
                obstacle = trace.get("obstacle") if isinstance(trace.get("obstacle"), dict) else {}
                xs = [
                    float(step["x"])
                    for step in rows
                    if _finite_number(step.get("x"))
                ]
                obstacle_x = _trace_float(obstacle.get("x"))
                obstacle_radius = _trace_float(obstacle.get("radius")) or 0.0
                physically_cleared = (
                    obstacle_x is not None
                    and bool(xs)
                    and max(xs) > obstacle_x + obstacle_radius
                )
                passed = _trace_float(summary.get("passed_obstacle_rate")) == 1.0
                success = _trace_float(summary.get("success_rate")) == 1.0
                collision = _trace_float(summary.get("collision_rate")) == 1.0
                final_pass_count += int(passed and physically_cleared)
                final_collision_count += int(collision)
                final_successful_clear_count += int(
                    consistent and success and passed and physically_cleared and not collision
                )
        by_learner[learner] = {
            "consistent_trace_count": consistent_count,
            "inconsistent_trace_count": inconsistent_count,
            "final_trace_count": final_trace_count,
            "final_pass_count": final_pass_count,
            "final_collision_count": final_collision_count,
            "final_successful_clear_count": final_successful_clear_count,
            "has_successful_final_clear": final_successful_clear_count > 0,
        }
    any_required_learner_clears = any(
        by_learner.get(learner, {}).get("has_successful_final_clear") is True
        for learner in REQUIRED_LEARNERS
    )
    return {
        "by_learner": by_learner,
        "all_trace_summaries_consistent": all_trace_summaries_consistent,
        "any_required_learner_successful_final_clear": any_required_learner_clears,
        "ok": all_trace_summaries_consistent and any_required_learner_clears,
    }


def _learner_seed_coverage(results: list[Any], learners: tuple[str, ...]) -> dict[str, list[int]]:
    coverage: dict[str, set[int]] = {name: set() for name in learners}
    for result in results:
        if not isinstance(result, dict):
            continue
        name = result.get("name")
        seed = result.get("seed")
        if name in coverage and isinstance(seed, int):
            coverage[name].add(seed)
    return {name: sorted(seeds) for name, seeds in coverage.items()}


def _learner_seed_pairs_ok(
    results: list[Any], expected_seeds: int, learners: tuple[str, ...]
) -> bool:
    expected = {
        (learner, 1000 + seed_index)
        for learner in learners
        for seed_index in range(expected_seeds)
    }
    observed: list[tuple[str, int]] = []
    for result in results:
        if not isinstance(result, dict):
            return False
        name = result.get("name")
        seed = result.get("seed")
        if name not in learners or isinstance(seed, bool) or not isinstance(seed, int):
            return False
        observed.append((name, seed))
    return len(observed) == len(expected) and set(observed) == expected


def validate_alberta_benchmark_artifacts(
    benchmark_dir: Path,
    *,
    expected_env: str | None = None,
    min_seeds: int = 1,
    min_steps_per_task: int = 1,
    min_tasks: int = 1,
    require_plot: bool = True,
    require_demo_video: bool = False,
    require_alberta_acc_gte_ppo: bool = False,
    require_alberta_forgetting_lte_ppo: bool = False,
) -> dict[str, Any]:
    benchmark_dir = benchmark_dir.resolve()
    json_path = benchmark_dir / "continual_benchmark.json"
    md_path = benchmark_dir / "continual_benchmark.md"
    png_path = benchmark_dir / "continual_benchmark.png"
    demo_json_path = benchmark_dir / "obstacle_course_demo.json"
    demo_video_path = benchmark_dir / "obstacle_course_demo.mp4"
    bundle = _load(json_path)
    demo = _load(demo_json_path)
    config = bundle.get("config") if isinstance(bundle.get("config"), dict) else {}
    summary = bundle.get("summary") if isinstance(bundle.get("summary"), dict) else {}
    motion = bundle.get("motion") if isinstance(bundle.get("motion"), dict) else {}
    results = bundle.get("results") if isinstance(bundle.get("results"), list) else []
    learner_names = {
        result.get("name")
        for result in results
        if isinstance(result, dict) and isinstance(result.get("name"), str)
    }
    configured_learners_raw = config.get("learners")
    configured_learners = tuple(
        name
        for name in configured_learners_raw
        if isinstance(name, str)
    ) if isinstance(configured_learners_raw, list) else REQUIRED_LEARNERS
    required_learners_present = all(name in configured_learners for name in REQUIRED_LEARNERS)
    config_seeds = _positive_int(config.get("seeds")) or 0
    config_steps_per_task = _positive_int(config.get("steps_per_task")) or 0
    n_tasks = _positive_int(config.get("n_tasks")) or 0
    expected_result_count = config_seeds * len(configured_learners)
    seed_coverage = _learner_seed_coverage(results, configured_learners)
    alberta_acc = _mean(summary, "alberta", "acc")
    ppo_acc = _mean(summary, "ppo", "acc")
    alberta_forgetting = _mean(summary, "alberta", "forgetting")
    ppo_forgetting = _mean(summary, "ppo", "forgetting")
    acc_delta = (
        alberta_acc - ppo_acc
        if alberta_acc is not None and ppo_acc is not None
        else None
    )
    forgetting_delta = (
        alberta_forgetting - ppo_forgetting
        if alberta_forgetting is not None and ppo_forgetting is not None
        else None
    )
    observed_comparisons = {
        "alberta_acc_gte_ppo": acc_delta is not None and acc_delta >= 0.0,
        "alberta_forgetting_lte_ppo": (
            forgetting_delta is not None and forgetting_delta <= 0.0
        ),
    }
    obstacle_baseline = _obstacle_baseline_comparisons(results)
    obstacle_trace_rollouts = _obstacle_trace_rollout_evidence(results)
    enforced_delta_gates = {
        "alberta_acc_gte_ppo": (
            observed_comparisons["alberta_acc_gte_ppo"]
            if require_alberta_acc_gte_ppo
            else True
        ),
        "alberta_forgetting_lte_ppo": (
            observed_comparisons["alberta_forgetting_lte_ppo"]
            if require_alberta_forgetting_lte_ppo
            else True
        ),
    }
    demo_learner_results = (
        demo.get("learner_results", {})
        if isinstance(demo.get("learner_results"), dict)
        else {}
    )
    demo_required_learners_have_traces = all(
        isinstance(demo_learner_results.get(name), dict)
        and demo_learner_results[name].get("has_trajectory_traces") is True
        for name in REQUIRED_LEARNERS
    )
    checks = {
        "benchmark_dir": benchmark_dir.is_dir(),
        "json": json_path.is_file(),
        "markdown": md_path.is_file(),
        "plot": (png_path.is_file() and png_path.stat().st_size > 0) if require_plot else True,
        "demo_json": (
            demo_json_path.is_file()
            and demo.get("schema") == "robot-alberta-obstacle-demo-v1"
            and demo.get("ok") is True
            and demo_required_learners_have_traces
        )
        if require_demo_video
        else True,
        "demo_video": (
            demo_video_path.is_file()
            and demo_video_path.stat().st_size > 0
            and _positive_int(demo.get("frames")) is not None
            and _positive_int(demo.get("video_bytes")) is not None
        )
        if require_demo_video
        else True,
        "schema": isinstance(config, dict)
        and isinstance(summary, dict)
        and isinstance(results, list),
        "expected_env": True
        if expected_env is None
        else config.get("env_kind") == expected_env,
        "seeds": config_seeds >= min_seeds,
        "steps_per_task": config_steps_per_task >= min_steps_per_task,
        "tasks": n_tasks >= min_tasks,
        "result_count": len(results) == expected_result_count
        and expected_result_count >= min_seeds * len(REQUIRED_LEARNERS),
        "learner_seed_pairs": _learner_seed_pairs_ok(
            results, config_seeds, configured_learners
        )
        if config_seeds > 0
        else False,
        "learner_seed_coverage": required_learners_present
        and all(
            len(seed_coverage[name]) >= min_seeds for name in REQUIRED_LEARNERS
        )
        and all(
            len(seed_coverage[name]) >= config_seeds
            for name in REQUIRED_LEARNERS
        ),
        "summary_learners": required_learners_present
        and all(name in summary for name in configured_learners),
        "result_learners": required_learners_present
        and all(name in learner_names for name in configured_learners),
        "matrix_shapes": all(
            isinstance(result, dict)
            and isinstance(result.get("name"), str)
            and result.get("name") in configured_learners
            and _matrix_shape_ok(result, n_tasks)
            for result in results
        )
        if results and n_tasks > 0
        else False,
        "motion_matrix_shapes": True
        if expected_env != "obstacle_course"
        else (
            bool(results)
            and n_tasks > 0
            and all(
                isinstance(result, dict)
                and result.get("name") in configured_learners
                and _motion_matrix_shape_ok(result, n_tasks)
                for result in results
            )
        ),
        "trajectory_matrix_shapes": True
        if expected_env != "obstacle_course"
        else (
            bool(results)
            and n_tasks > 0
            and all(
                isinstance(result, dict)
                and result.get("name") in configured_learners
                and _trajectory_matrix_shape_ok(result, n_tasks)
                for result in results
            )
        ),
        "obstacle_motion_summary": True
        if expected_env != "obstacle_course"
        else all(
            isinstance(motion.get(name), dict)
            and _finite_number(motion[name].get("final_forward_progress_m_mean"))
            and _finite_number(motion[name].get("final_passed_obstacle_rate_mean"))
            and _finite_number(motion[name].get("final_collision_rate_mean"))
            for name in REQUIRED_LEARNERS
        ),
        "obstacle_forward_progress": True
        if expected_env != "obstacle_course"
        else any(
            isinstance(motion.get(name), dict)
            and _finite_number(motion[name].get("final_forward_progress_m_mean"))
            and float(motion[name]["final_forward_progress_m_mean"]) >= 1.0
            for name in REQUIRED_LEARNERS
        ),
        "obstacle_passes_obstacle": True
        if expected_env != "obstacle_course"
        else any(
            isinstance(motion.get(name), dict)
            and _finite_number(motion[name].get("final_passed_obstacle_rate_mean"))
            and float(motion[name]["final_passed_obstacle_rate_mean"]) >= 0.5
            for name in REQUIRED_LEARNERS
        ),
        "obstacle_collision_rate": True
        if expected_env != "obstacle_course"
        else all(
            isinstance(motion.get(name), dict)
            and _finite_number(motion[name].get("final_collision_rate_mean"))
            and float(motion[name]["final_collision_rate_mean"]) <= 0.25
            for name in REQUIRED_LEARNERS
        ),
        "obstacle_passive_baseline_control": True
        if expected_env != "obstacle_course"
        else bool(obstacle_baseline["baseline_is_control"]),
        "obstacle_beats_passive_baseline": True
        if expected_env != "obstacle_course"
        else bool(obstacle_baseline["learning_beats_baseline"]),
        "obstacle_trace_rollouts": True
        if expected_env != "obstacle_course"
        else bool(obstacle_trace_rollouts["ok"]),
        "metrics": required_learners_present
        and all(_metric_block_ok(summary, name) for name in configured_learners),
        "alberta_acc_gte_ppo": enforced_delta_gates["alberta_acc_gte_ppo"],
        "alberta_forgetting_lte_ppo": enforced_delta_gates[
            "alberta_forgetting_lte_ppo"
        ],
    }
    return {
        "ok": all(checks.values()),
        "benchmark_dir": str(benchmark_dir),
        "expected_env": expected_env,
        "min_seeds": int(min_seeds),
        "min_steps_per_task": int(min_steps_per_task),
        "min_tasks": int(min_tasks),
        "checks": checks,
        "deltas": {
            "alberta_acc_minus_ppo": acc_delta,
            "alberta_forgetting_minus_ppo": forgetting_delta,
        },
        "observed_comparisons": observed_comparisons,
        "enforced_delta_gates": enforced_delta_gates,
        "required_deltas": {
            "require_alberta_acc_gte_ppo": bool(require_alberta_acc_gte_ppo),
            "require_alberta_forgetting_lte_ppo": bool(
                require_alberta_forgetting_lte_ppo
            ),
        },
        "required_artifacts": {
            "require_plot": bool(require_plot),
            "require_demo_video": bool(require_demo_video),
        },
        "demo": demo,
        "config": config,
        "summary": summary,
        "motion": motion,
        "obstacle_baseline": obstacle_baseline,
        "obstacle_trace_rollouts": obstacle_trace_rollouts,
        "seed_coverage": seed_coverage,
        "configured_learners": list(configured_learners),
        "required_learners": list(REQUIRED_LEARNERS),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("benchmark_dir", type=Path)
    parser.add_argument("--expected-env", choices=("joint_reach", "obstacle_course"))
    parser.add_argument("--min-seeds", type=int, default=1)
    parser.add_argument("--min-steps-per-task", type=int, default=1)
    parser.add_argument("--min-tasks", type=int, default=1)
    parser.add_argument("--no-require-plot", action="store_true")
    parser.add_argument("--require-demo-video", action="store_true")
    parser.add_argument("--require-alberta-acc-gte-ppo", action="store_true")
    parser.add_argument("--require-alberta-forgetting-lte-ppo", action="store_true")
    args = parser.parse_args(argv)
    report = validate_alberta_benchmark_artifacts(
        args.benchmark_dir,
        expected_env=args.expected_env,
        min_seeds=args.min_seeds,
        min_steps_per_task=args.min_steps_per_task,
        min_tasks=args.min_tasks,
        require_plot=not args.no_require_plot,
        require_demo_video=args.require_demo_video,
        require_alberta_acc_gte_ppo=args.require_alberta_acc_gte_ppo,
        require_alberta_forgetting_lte_ppo=args.require_alberta_forgetting_lte_ppo,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
