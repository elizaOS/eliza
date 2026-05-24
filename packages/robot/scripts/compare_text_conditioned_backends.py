"""Train and compare Alberta vs PPO on the profile-driven robot env.

This is the robot-policy counterpart to
``python -m eliza_robot.rl.alberta.benchmark``. It runs the two text-conditioned
training backends with the same profile, task list, seed, and step budget, then
evaluates both checkpoints with ``scripts/eval_text_policy.py``'s evaluator and
writes one comparison artifact.

Use small budgets locally to verify the plumbing; use Nebius for production
budgets.
"""

from __future__ import annotations

import argparse
import importlib
import json
import math
import sys
import time
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

list_profiles = importlib.import_module("eliza_robot.profiles.schema").list_profiles
eval_text_policy = importlib.import_module("scripts.eval_text_policy")
train_text_conditioned = importlib.import_module("scripts.train_text_conditioned")
validate_alberta_robot_checkpoint = importlib.import_module(
    "scripts.validate_alberta_robot_checkpoint"
).validate_alberta_robot_checkpoint

DEFAULT_TASKS = ("stand_up", "walk_forward", "turn_left", "turn_right")


def _finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int | float)
        and math.isfinite(float(value))
    )


def _validate_eval_report(report: dict, *, tasks: tuple[str, ...], label: str) -> None:
    if not isinstance(report, dict):
        raise RuntimeError(f"{label} eval did not return a report")
    if not _finite_number(report.get("mean_reward_overall")):
        raise RuntimeError(f"{label} eval has invalid mean_reward_overall")
    task_block = report.get("tasks")
    if not isinstance(task_block, dict):
        raise RuntimeError(f"{label} eval missing tasks")
    missing = [task for task in tasks if task not in task_block]
    if missing:
        raise RuntimeError(f"{label} eval missing task rewards: {missing}")
    invalid = [
        task
        for task in tasks
        if not (
            isinstance(task_block.get(task), dict)
            and _finite_number(task_block[task].get("mean_reward"))
        )
    ]
    if invalid:
        raise RuntimeError(f"{label} eval has invalid task rewards: {invalid}")


def _mean_task_delta(report: dict, baseline: dict) -> dict[str, float]:
    deltas = {}
    for task, stats in report["tasks"].items():
        base = baseline["tasks"].get(task, {}).get("mean_reward", 0.0)
        deltas[task] = float(stats["mean_reward"] - base)
    return deltas


def _task_delta(left: dict, right: dict) -> dict[str, float]:
    deltas = {}
    for task, stats in left["tasks"].items():
        other = right["tasks"].get(task, {}).get("mean_reward", 0.0)
        deltas[task] = float(stats["mean_reward"] - other)
    return deltas


def _fmt(value: object) -> str:
    if _finite_number(value):
        return f"{float(value):.4f}"
    return str(value)


def write_markdown_report(comparison: dict, out_root: Path) -> None:
    """Write a human-readable Alberta-vs-PPO side-by-side report."""
    baseline = comparison["baseline"]
    alberta = comparison["alberta"]
    ppo = comparison.get("ppo")
    lines = [
        "# Alberta vs PPO Robot Backend Comparison",
        "",
        f"Profile: `{comparison['profile_id']}`",
        f"Tasks: `{', '.join(comparison['tasks'])}`",
        f"Requested steps: `{comparison['steps']}`",
        f"Evaluation episodes/task: `{comparison['eval_episodes']}`",
        f"Max eval steps/episode: `{comparison['max_steps']}`",
        f"Domain randomization: `{comparison['domain_rand']}`",
        "",
        "| backend | regime | checkpoint valid | mean reward | delta vs untrained | output dim |",
        "|---|---|---:|---:|---:|---:|",
    ]
    base_mean = float(baseline["mean_reward_overall"])
    a_eval = alberta["eval"]
    lines.append(
        "| Alberta | "
        f"`{alberta['manifest']['regime']}` | "
        f"{bool(alberta['validation']['ok'])} | "
        f"{_fmt(a_eval['mean_reward_overall'])} | "
        f"{_fmt(float(a_eval['mean_reward_overall']) - base_mean)} | "
        f"{a_eval.get('policy_output_dim', 'n/a')} |"
    )
    if ppo is not None:
        p_eval = ppo["eval"]
        lines.append(
            "| PPO | "
            f"`{ppo['manifest']['regime']}` | n/a | "
            f"{_fmt(p_eval['mean_reward_overall'])} | "
            f"{_fmt(float(p_eval['mean_reward_overall']) - base_mean)} | "
            f"{p_eval.get('policy_output_dim', 'n/a')} |"
        )
    lines += [
        "",
        "## Per-Task Reward",
        "",
        "| task | untrained | Alberta | Alberta delta | PPO | PPO delta | Alberta vs PPO |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for task in comparison["tasks"]:
        b = baseline["tasks"][task]["mean_reward"]
        a = alberta["eval"]["tasks"][task]["mean_reward"]
        p = None if ppo is None else ppo["eval"]["tasks"][task]["mean_reward"]
        lines.append(
            f"| `{task}` | {_fmt(b)} | {_fmt(a)} | {_fmt(a - b)} | "
            f"{_fmt(p) if p is not None else 'n/a'} | "
            f"{_fmt(p - b) if p is not None else 'n/a'} | "
            f"{_fmt(a - p) if p is not None else 'n/a'} |"
        )
    lines += [
        "",
        "## Interpretation",
        "",
        "This artifact proves both backends can train, checkpoint, load, and evaluate "
        "through the same profile-driven robot environment and text-conditioned "
        "policy wrapper. Small local step budgets are plumbing smoke evidence; "
        "production learning claims require the Nebius full-training artifacts.",
        "",
        f"Winner by mean reward in this run: `{comparison.get('winner_by_mean_reward', 'n/a')}`.",
    ]
    (out_root / "comparison.md").write_text("\n".join(lines) + "\n")


def compare(
    *,
    profile_id: str,
    tasks: tuple[str, ...],
    out_root: Path,
    steps: int,
    seed: int,
    pca_dim: int,
    episode_steps: int,
    eval_episodes: int,
    max_steps: int,
    domain_rand: bool,
    eval_backend: str,
    train_ppo: bool,
) -> dict:
    out_root.mkdir(parents=True, exist_ok=True)
    alberta_dir = out_root / "alberta"
    ppo_dir = out_root / "ppo"

    t0 = time.time()
    alberta_manifest = train_text_conditioned._train_alberta(
        profile_id,
        alberta_dir,
        total_steps=steps,
        seed=seed,
        include_tasks=tasks,
        pca_dim=pca_dim,
        episode_steps=episode_steps,
        eval_episodes=eval_episodes,
        domain_rand=domain_rand,
    )
    alberta_validation = validate_alberta_robot_checkpoint(
        alberta_dir,
        profile_id=profile_id,
        required_tasks=list(tasks),
        min_steps=steps,
        require_domain_rand=domain_rand,
        require_inference=True,
    )
    if not alberta_validation["ok"]:
        failed = [
            name for name, ok in alberta_validation.get("checks", {}).items() if not ok
        ]
        raise RuntimeError(f"Alberta checkpoint validation failed: {failed}")
    baseline_eval = eval_text_policy.evaluate(
        profile_id,
        tasks=tasks,
        episodes=eval_episodes,
        max_steps=max_steps,
        untrained=True,
        backend=eval_backend,
    )
    _validate_eval_report(baseline_eval, tasks=tasks, label="untrained")
    alberta_eval = eval_text_policy.evaluate(
        profile_id,
        tasks=tasks,
        episodes=eval_episodes,
        max_steps=max_steps,
        untrained=False,
        ckpt=alberta_dir,
        backend=eval_backend,
    )
    _validate_eval_report(alberta_eval, tasks=tasks, label="alberta")

    ppo_manifest = None
    ppo_eval = None
    if train_ppo:
        ppo_manifest = train_text_conditioned._train_ppo(
            profile_id,
            ppo_dir,
            total_steps=steps,
            seed=seed,
            include_tasks=tasks,
            pca_dim=pca_dim,
            domain_rand=domain_rand,
        )
        ppo_eval = eval_text_policy.evaluate(
            profile_id,
            tasks=tasks,
            episodes=eval_episodes,
            max_steps=max_steps,
            untrained=False,
            ckpt=ppo_dir,
            backend=eval_backend,
        )
        _validate_eval_report(ppo_eval, tasks=tasks, label="ppo")

    comparison = {
        "profile_id": profile_id,
        "tasks": list(tasks),
        "steps": int(steps),
        "seed": int(seed),
        "pca_dim": int(pca_dim),
        "episode_steps": int(episode_steps),
        "eval_episodes": int(eval_episodes),
        "max_steps": int(max_steps),
        "domain_rand": bool(domain_rand),
        "wall_clock_s": round(time.time() - t0, 2),
        "baseline": baseline_eval,
        "alberta": {
            "checkpoint": str(alberta_dir),
            "manifest": alberta_manifest,
            "validation": alberta_validation,
            "eval": alberta_eval,
            "delta_vs_untrained": _mean_task_delta(alberta_eval, baseline_eval),
        },
        "ppo": (
            {
                "checkpoint": str(ppo_dir),
                "manifest": ppo_manifest,
                "eval": ppo_eval,
                "delta_vs_untrained": _mean_task_delta(ppo_eval, baseline_eval),
            }
            if ppo_eval is not None
            else None
        ),
    }
    if ppo_eval is not None:
        comparison["alberta_vs_ppo_delta"] = {
            "mean_reward_overall": float(
                alberta_eval["mean_reward_overall"] - ppo_eval["mean_reward_overall"]
            ),
            "tasks": _task_delta(alberta_eval, ppo_eval),
        }
        comparison["winner_by_mean_reward"] = (
            "alberta"
            if alberta_eval["mean_reward_overall"] >= ppo_eval["mean_reward_overall"]
            else "ppo"
        )
    (out_root / "comparison.json").write_text(json.dumps(comparison, indent=2) + "\n")
    write_markdown_report(comparison, out_root)
    return comparison


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=list_profiles(), required=True)
    parser.add_argument("--tasks", nargs="+", default=list(DEFAULT_TASKS))
    parser.add_argument("--out-root", type=Path, default=PKG_ROOT / "evidence" / "backend_compare")
    parser.add_argument("--steps", type=int, default=30_000)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--pca-dim", type=int, default=32)
    parser.add_argument("--episode-steps", type=int, default=200)
    parser.add_argument("--eval-episodes", type=int, default=3)
    parser.add_argument("--max-steps", type=int, default=200)
    parser.add_argument(
        "--eval-backend",
        choices=("auto", "profile", "mjx"),
        default="profile",
    )
    parser.add_argument(
        "--no-domain-rand",
        action="store_true",
        help="Disable Alberta domain randomization for deterministic comparisons.",
    )
    parser.add_argument(
        "--alberta-only",
        action="store_true",
        help="Skip PPO training when only validating the Alberta path.",
    )
    args = parser.parse_args(argv)
    report = compare(
        profile_id=args.profile,
        tasks=tuple(args.tasks),
        out_root=args.out_root,
        steps=args.steps,
        seed=args.seed,
        pca_dim=args.pca_dim,
        episode_steps=args.episode_steps,
        eval_episodes=args.eval_episodes,
        max_steps=args.max_steps,
        domain_rand=not args.no_domain_rand,
        eval_backend=args.eval_backend,
        train_ppo=not args.alberta_only,
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
