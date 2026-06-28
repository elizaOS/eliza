"""Validate Alberta-vs-PPO robot backend comparison artifacts."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


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


def _tasks_ok(report: dict[str, Any], tasks: list[str]) -> bool:
    task_block = report.get("tasks")
    if not isinstance(task_block, dict):
        return False
    return all(
        task in task_block and _finite_number(task_block[task].get("mean_reward"))
        for task in tasks
    )


def _mean_reward(report: dict[str, Any]) -> float | None:
    value = report.get("mean_reward_overall")
    return float(value) if _finite_number(value) else None


def _task_survival_values(report: dict[str, Any], tasks: list[str]) -> list[float]:
    task_block = report.get("tasks")
    if not isinstance(task_block, dict):
        return []
    values: list[float] = []
    for task in tasks:
        stats = task_block.get(task)
        if not isinstance(stats, dict):
            continue
        value = stats.get("mean_steps_survived")
        if _finite_number(value):
            values.append(float(value))
    return values


def _survival_summary(
    *,
    baseline: dict[str, Any],
    alberta_eval: dict[str, Any],
    ppo_eval: dict[str, Any],
    tasks: list[str],
) -> dict[str, Any]:
    blocks = {
        "baseline": _task_survival_values(baseline, tasks),
        "alberta": _task_survival_values(alberta_eval, tasks),
        "ppo": _task_survival_values(ppo_eval, tasks),
    }
    all_values = [value for values in blocks.values() for value in values]
    return {
        "baseline_min_mean_steps_survived": min(blocks["baseline"])
        if blocks["baseline"]
        else None,
        "alberta_min_mean_steps_survived": min(blocks["alberta"])
        if blocks["alberta"]
        else None,
        "ppo_min_mean_steps_survived": min(blocks["ppo"]) if blocks["ppo"] else None,
        "min_mean_steps_survived": min(all_values) if all_values else None,
        "mean_mean_steps_survived": (
            sum(all_values) / len(all_values) if all_values else None
        ),
        "survival_values_present": all(
            len(values) == len(tasks) for values in blocks.values()
        ),
    }


def _task_delta_ok(delta: Any, tasks: list[str]) -> bool:
    if not isinstance(delta, dict):
        return False
    task_block = delta.get("tasks")
    if not isinstance(task_block, dict):
        return False
    return all(
        task in task_block and _finite_number(task_block[task])
        for task in tasks
    )


def _task_delta_values_ok(
    delta: Any,
    left_eval: dict[str, Any],
    right_eval: dict[str, Any],
    tasks: list[str],
) -> bool:
    if not _task_delta_ok(delta, tasks):
        return False
    task_block = delta.get("tasks")
    left_tasks = left_eval.get("tasks")
    right_tasks = right_eval.get("tasks")
    if not isinstance(task_block, dict):
        return False
    if not isinstance(left_tasks, dict) or not isinstance(right_tasks, dict):
        return False
    for task in tasks:
        reported = task_block.get(task)
        left_reward = left_tasks.get(task, {}).get("mean_reward")
        right_reward = right_tasks.get(task, {}).get("mean_reward")
        if not all(_finite_number(v) for v in (reported, left_reward, right_reward)):
            return False
        if abs(float(reported) - (float(left_reward) - float(right_reward))) >= 1e-9:
            return False
    return True


def _delta_vs_baseline_ok(
    delta: Any,
    eval_report: dict[str, Any],
    baseline: dict[str, Any],
    tasks: list[str],
) -> bool:
    if not isinstance(delta, dict):
        return False
    eval_tasks = eval_report.get("tasks")
    baseline_tasks = baseline.get("tasks")
    if not isinstance(eval_tasks, dict) or not isinstance(baseline_tasks, dict):
        return False
    for task in tasks:
        reported = delta.get(task)
        eval_reward = eval_tasks.get(task, {}).get("mean_reward")
        baseline_reward = baseline_tasks.get(task, {}).get("mean_reward")
        if not all(_finite_number(v) for v in (reported, eval_reward, baseline_reward)):
            return False
        if abs(float(reported) - (float(eval_reward) - float(baseline_reward))) >= 1e-9:
            return False
    return True


def validate_backend_comparison_artifacts(
    comparison_dir: Path,
    *,
    expected_profile: str | None = None,
    min_steps: int = 1,
    min_eval_mean_steps: float = 1.0,
    require_ppo: bool = True,
) -> dict[str, Any]:
    comparison_dir = comparison_dir.resolve()
    json_path = comparison_dir / "comparison.json"
    md_path = comparison_dir / "comparison.md"
    bundle = _load(json_path)
    tasks = bundle.get("tasks") if isinstance(bundle.get("tasks"), list) else []
    baseline = bundle.get("baseline") if isinstance(bundle.get("baseline"), dict) else {}
    alberta = bundle.get("alberta") if isinstance(bundle.get("alberta"), dict) else {}
    ppo = bundle.get("ppo") if isinstance(bundle.get("ppo"), dict) else None
    alberta_eval = alberta.get("eval") if isinstance(alberta.get("eval"), dict) else {}
    alberta_delta_vs_untrained = alberta.get("delta_vs_untrained")
    alberta_validation = (
        alberta.get("validation") if isinstance(alberta.get("validation"), dict) else {}
    )
    ppo_eval = ppo.get("eval") if isinstance(ppo, dict) and isinstance(ppo.get("eval"), dict) else {}
    ppo_delta_vs_untrained = (
        ppo.get("delta_vs_untrained") if isinstance(ppo, dict) else None
    )
    baseline_mean = _mean_reward(baseline)
    alberta_mean = _mean_reward(alberta_eval)
    ppo_mean = _mean_reward(ppo_eval)
    delta = bundle.get("alberta_vs_ppo_delta")
    reported_delta = (
        delta.get("mean_reward_overall")
        if isinstance(delta, dict)
        else None
    )
    expected_winner = None
    if alberta_mean is not None and ppo_mean is not None:
        expected_winner = "alberta" if alberta_mean >= ppo_mean else "ppo"
    survival = _survival_summary(
        baseline=baseline,
        alberta_eval=alberta_eval,
        ppo_eval=ppo_eval,
        tasks=tasks,
    )
    eval_config_ok = (
        isinstance(bundle.get("seed"), int)
        and isinstance(bundle.get("pca_dim"), int)
        and int(bundle["pca_dim"]) > 0
        and isinstance(bundle.get("episode_steps"), int)
        and int(bundle["episode_steps"]) > 0
        and isinstance(bundle.get("eval_episodes"), int)
        and int(bundle["eval_episodes"]) > 0
        and isinstance(bundle.get("max_steps"), int)
        and int(bundle["max_steps"]) > 0
        and isinstance(bundle.get("domain_rand"), bool)
    )
    md_text = md_path.read_text(encoding="utf-8") if md_path.is_file() else ""
    checks = {
        "comparison_dir": comparison_dir.is_dir(),
        "json": json_path.is_file(),
        "markdown": (
            md_path.is_file()
            and "Alberta vs PPO" in md_text
            and "Per-Task Reward" in md_text
            and "delta vs untrained" in md_text
            and "Winner by mean reward" in md_text
        ),
        "profile": True
        if expected_profile is None
        else bundle.get("profile_id") == expected_profile,
        "tasks": bool(tasks),
        "steps": int(bundle.get("steps", 0) or 0) >= min_steps,
        "eval_config": eval_config_ok,
        "baseline_eval": _tasks_ok(baseline, tasks),
        "alberta_present": bool(alberta),
        "alberta_validation": alberta_validation.get("ok") is True,
        "alberta_eval": _tasks_ok(alberta_eval, tasks),
        "alberta_delta_vs_untrained": _delta_vs_baseline_ok(
            alberta_delta_vs_untrained, alberta_eval, baseline, tasks
        ),
        "ppo_present": (ppo is not None) if require_ppo else True,
        "ppo_eval": _tasks_ok(ppo_eval, tasks) if require_ppo else True,
        "ppo_delta_vs_untrained": (not require_ppo)
        or _delta_vs_baseline_ok(ppo_delta_vs_untrained, ppo_eval, baseline, tasks),
        "mean_rewards": (not require_ppo)
        or (baseline_mean is not None and alberta_mean is not None and ppo_mean is not None),
        "alberta_vs_ppo_delta": (not require_ppo)
        or (
            _finite_number(reported_delta)
            and alberta_mean is not None
            and ppo_mean is not None
            and abs(float(reported_delta) - (alberta_mean - ppo_mean)) < 1e-9
            and _task_delta_values_ok(delta, alberta_eval, ppo_eval, tasks)
        ),
        "winner": (not require_ppo) or bundle.get("winner_by_mean_reward") in {"alberta", "ppo"},
        "winner_consistent": (not require_ppo)
        or (
            expected_winner is not None
            and bundle.get("winner_by_mean_reward") == expected_winner
        ),
        "eval_rollout_depth": (
            True
            if min_eval_mean_steps <= 1.0 and not survival["survival_values_present"]
            else survival["survival_values_present"]
            and _finite_number(survival["min_mean_steps_survived"])
            and float(survival["min_mean_steps_survived"])
            >= float(min_eval_mean_steps)
        ),
    }
    return {
        "ok": all(checks.values()),
        "comparison_dir": str(comparison_dir),
        "expected_profile": expected_profile,
        "min_steps": int(min_steps),
        "min_eval_mean_steps": float(min_eval_mean_steps),
        "checks": checks,
        "profile_id": bundle.get("profile_id"),
        "tasks": tasks,
        "steps": bundle.get("steps"),
        "eval_config": {
            "seed": bundle.get("seed"),
            "pca_dim": bundle.get("pca_dim"),
            "episode_steps": bundle.get("episode_steps"),
            "eval_episodes": bundle.get("eval_episodes"),
            "max_steps": bundle.get("max_steps"),
            "domain_rand": bundle.get("domain_rand"),
        },
        "winner_by_mean_reward": bundle.get("winner_by_mean_reward"),
        "deltas": {
            "baseline_mean_reward": baseline_mean,
            "alberta_mean_reward": alberta_mean,
            "ppo_mean_reward": ppo_mean,
            "alberta_minus_ppo_mean_reward": reported_delta,
            "alberta_minus_untrained_mean_reward": (
                alberta_mean - baseline_mean
                if alberta_mean is not None and baseline_mean is not None
                else None
            ),
            "ppo_minus_untrained_mean_reward": (
                ppo_mean - baseline_mean
                if ppo_mean is not None and baseline_mean is not None
                else None
            ),
            "expected_winner_by_mean_reward": expected_winner,
        },
        "survival": survival,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("comparison_dir", type=Path)
    parser.add_argument("--expected-profile")
    parser.add_argument("--min-steps", type=int, default=1)
    parser.add_argument("--min-eval-mean-steps", type=float, default=1.0)
    parser.add_argument("--no-require-ppo", action="store_true")
    args = parser.parse_args(argv)
    report = validate_backend_comparison_artifacts(
        args.comparison_dir,
        expected_profile=args.expected_profile,
        min_steps=args.min_steps,
        min_eval_mean_steps=args.min_eval_mean_steps,
        require_ppo=not args.no_require_ppo,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
