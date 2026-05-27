"""Continual-learning head-to-head: Alberta streaming control vs PPO.

Trains each learner on a sequence of tasks (one task per phase, in order) over a
*shared* observation/action space, and after every phase evaluates on **all**
tasks to build the task x phase performance matrix ``R``. From ``R`` we compute
the standard continual-learning metrics (ACC / BWT / Forgetting / FWT, see
:mod:`eliza_robot.rl.alberta.metrics`). The whole comparison is deterministic
given a seed, and writes a JSON evidence bundle plus a forgetting-curve plot.

Run::

    uv run python -m eliza_robot.rl.alberta.benchmark --steps-per-task 30000 --seeds 3
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from eliza_robot.rl.alberta.agent import AlbertaControllerConfig
from eliza_robot.rl.alberta.baselines import (
    AlbertaSequentialLearner,
    PPOSequentialLearner,
    SACSequentialLearner,
)
from eliza_robot.rl.alberta.continual_env import JointReachConfig, JointReachEnv
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.metrics import ContinualMetrics, compute_continual_metrics
from eliza_robot.rl.alberta.obstacle_course import (
    ObstacleCourseConfig,
    ObstacleCourseEnv,
)


@dataclass
class BenchmarkConfig:
    env_kind: str = "joint_reach"
    n_tasks: int = 4
    n_joints: int = 6
    steps_per_task: int = 30000
    eval_episodes: int = 10
    seeds: int = 3
    # Alberta controller knobs (the regime found stable for first-order servo).
    gamma: float = 0.5
    actor_step_size: float = 1e-2
    critic_step_size: float = 2e-2
    actor_lamda: float = 0.7
    critic_lamda: float = 0.7
    log_sigma_init: float = -1.0
    embed_dim: int = 16
    # Generously over-provisioned so distinct tasks land on distinct prototype
    # blocks (collision-free) — a collision shares a block between two tasks and
    # reintroduces interference. ~T^2/(2*n_prototypes) collision probability.
    n_prototypes: int = 256
    gate_temperature: float = 0.1
    proprio_random_dim: int = 64
    obstacle_episode_steps: int = 80
    learners: tuple[str, ...] = ("alberta", "ppo")


def _build_env(cfg: BenchmarkConfig, seed: int) -> JointReachEnv | ObstacleCourseEnv:
    if cfg.env_kind == "joint_reach":
        return JointReachEnv(
            n_tasks=cfg.n_tasks,
            config=JointReachConfig(n_joints=cfg.n_joints, embed_dim=cfg.embed_dim),
            seed=seed,
        )
    if cfg.env_kind == "obstacle_course":
        return ObstacleCourseEnv(
            n_tasks=cfg.n_tasks,
            config=ObstacleCourseConfig(
                embed_dim=cfg.embed_dim,
                episode_steps=cfg.obstacle_episode_steps,
            ),
            seed=seed,
        )
    raise ValueError(f"unknown benchmark env_kind {cfg.env_kind!r}")


def _config_dict(cfg: BenchmarkConfig) -> dict:
    data = asdict(cfg)
    data["learners"] = list(cfg.learners)
    return data


def _alberta_controller_config(cfg: BenchmarkConfig, env: JointReachEnv, seed: int) -> AlbertaControllerConfig:
    return AlbertaControllerConfig(
        obs_dim=int(env.observation_space.shape[0]),
        action_dim=int(env.action_space.shape[0]),
        gamma=cfg.gamma,
        actor_step_size=cfg.actor_step_size,
        critic_step_size=cfg.critic_step_size,
        actor_lamda=cfg.actor_lamda,
        critic_lamda=cfg.critic_lamda,
        log_sigma_init=cfg.log_sigma_init,
        normalize=False,
        obgd_kappa=2.0,
        decouple_global_bias=True,
        features=FeatureConfig(
            mode="sparse_gated",
            embed_dim=cfg.embed_dim,
            n_prototypes=cfg.n_prototypes,
            gate_hard=True,
            gate_temperature=cfg.gate_temperature,
            proprio_random_dim=cfg.proprio_random_dim,
            seed=seed,
        ),
        seed=seed,
    )


def run_learner(learner, cfg: BenchmarkConfig) -> tuple[np.ndarray, np.ndarray, list[dict], list[list[dict]]]:
    """Train ``learner`` task-by-task, returning ``(R, baseline)``.

    ``R[i, j]`` = mean eval return on task ``j`` after training phase ``i``.
    ``baseline[j]`` = mean eval return on task ``j`` before any training.
    """
    T = cfg.n_tasks
    baseline = np.array([learner.eval_task(j, cfg.eval_episodes) for j in range(T)], dtype=np.float64)
    baseline_motion = [
        learner.eval_task_motion(j, cfg.eval_episodes)
        if cfg.env_kind == "obstacle_course" and hasattr(learner, "eval_task_motion")
        else {}
        for j in range(T)
    ]
    R = np.zeros((T, T), dtype=np.float64)
    motion_matrix: list[list[dict]] = []
    for i in range(T):
        learner.train_phase(i, cfg.steps_per_task)
        motion_row: list[dict] = []
        for j in range(T):
            R[i, j] = learner.eval_task(j, cfg.eval_episodes)
            motion_row.append(
                learner.eval_task_motion(j, cfg.eval_episodes)
                if cfg.env_kind == "obstacle_course" and hasattr(learner, "eval_task_motion")
                else {}
            )
        motion_matrix.append(motion_row)
    return R, baseline, baseline_motion, motion_matrix


@dataclass
class LearnerResult:
    name: str
    matrix: list[list[float]]
    baseline: list[float]
    metrics: dict
    seed: int
    motion_baseline: list[dict] | None = None
    motion_matrix: list[list[dict]] | None = None


def run_benchmark(cfg: BenchmarkConfig, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    requested = tuple(dict.fromkeys(cfg.learners))
    invalid = sorted(set(requested) - {"alberta", "ppo", "sac"})
    if invalid:
        raise ValueError(f"unknown learner(s): {', '.join(invalid)}")
    if "alberta" not in requested or "ppo" not in requested:
        raise ValueError("benchmark evidence must include at least alberta and ppo")
    per_seed: dict[str, list[ContinualMetrics]] = {name: [] for name in requested}
    results: list[LearnerResult] = []

    for s in range(cfg.seeds):
        seed = 1000 + s
        metrics_for_seed: dict[str, ContinualMetrics] = {}
        for name in requested:
            env = _build_env(cfg, seed)
            if name == "alberta":
                learner = AlbertaSequentialLearner(env, _alberta_controller_config(cfg, env, seed))
            elif name == "ppo":
                learner = PPOSequentialLearner(env, seed=seed)
            elif name == "sac":
                learner = SACSequentialLearner(env, seed=seed)
            else:  # guarded above
                raise AssertionError(name)
            R, baseline, motion_baseline, motion_matrix = run_learner(learner, cfg)
            metrics = compute_continual_metrics(R, baseline)
            per_seed[name].append(metrics)
            metrics_for_seed[name] = metrics
            results.append(
                LearnerResult(
                    name,
                    R.tolist(),
                    baseline.tolist(),
                    metrics.to_dict(),
                    seed,
                    motion_baseline=motion_baseline if cfg.env_kind == "obstacle_course" else None,
                    motion_matrix=motion_matrix if cfg.env_kind == "obstacle_course" else None,
                )
            )

        parts = [
            f"{name} ACC={metrics.acc:6.1f} BWT={metrics.bwt:6.2f} Forget={metrics.forgetting:5.2f}"
            for name, metrics in metrics_for_seed.items()
        ]
        print(f"[seed {seed}] " + " | ".join(parts))

    summary = _summarize(per_seed)
    adaptation = _adaptation_summary(results)
    motion = _motion_summary(results) if cfg.env_kind == "obstacle_course" else {}
    bundle = {
        "config": _config_dict(cfg),
        "summary": summary,
        "adaptation": adaptation,
        "motion": motion,
        "results": [asdict(r) for r in results],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (out_dir / "continual_benchmark.json").write_text(json.dumps(bundle, indent=2))
    _plot(per_seed, results, out_dir)
    _write_report(cfg, summary, results, out_dir)
    return bundle


def _write_report(cfg: BenchmarkConfig, summary: dict, results, out_dir: Path) -> None:
    a, p = summary.get("alberta"), summary.get("ppo")
    lines = [
        "# Continual learning: Alberta vs PPO",
        "",
        f"Environment: `{cfg.env_kind}`.",
        "",
        f"Sequential training on {cfg.n_tasks} task(s) sharing one observation/action "
        f"space, {cfg.steps_per_task} env-steps/task, {cfg.seeds} seed(s). After every "
        "phase both learners are evaluated on **all** tasks; metrics are computed from "
        "the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).",
        "",
        f"Learners: `{', '.join(cfg.learners)}`.",
        "",
        "| metric | Alberta | PPO | better |",
        "|--------|---------|-----|--------|",
    ]
    if a and p:
        def row(key, arrow, lower_better=False):
            av, pv = a[key]["mean"], p[key]["mean"]
            if lower_better:
                win = "Alberta" if av < pv else "PPO"
            else:
                win = "Alberta" if av > pv else "PPO"
            return (
                f"| {key.upper()} {arrow} | {av:.2f} ± {a[key]['std']:.2f} | "
                f"{pv:.2f} ± {p[key]['std']:.2f} | **{win}** |"
            )

        lines += [
            row("acc", "↑"),
            row("bwt", "↑ (0 = no forgetting)"),
            row("forgetting", "↓", lower_better=True),
            row("fwt", "↑"),
        ]
    adaptation = _adaptation_summary(results)
    if adaptation:
        lines += [
            "",
            "## New-task adaptation and old-task retention",
            "",
            "| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |",
            "|---|---:|---:|---:|---:|",
        ]
        for learner, item in adaptation.items():
            lines.append(
                f"| `{learner}` | {float(item['mean_new_task_gain']):.2f} | "
                f"{float(item['tasks_with_positive_gain']):.1f}/{float(item['task_count']):.1f} | "
                f"{float(item['first_task_retention_delta']):.2f} | "
                f"{float(item['mean_final_minus_best']):.2f} |"
            )
    motion = _motion_summary(results) if cfg.env_kind == "obstacle_course" else {}
    if motion:
        lines += [
            "",
            "## Physical obstacle-course rollout checks",
            "",
            "| learner | final success rate | final collision rate | final passed-obstacle rate | final forward progress m | min obstacle clearance m |",
            "|---|---:|---:|---:|---:|---:|",
        ]
        for learner, item in motion.items():
            lines.append(
                f"| `{learner}` | {float(item['final_success_rate_mean']):.2f} | "
                f"{float(item['final_collision_rate_mean']):.2f} | "
                f"{float(item['final_passed_obstacle_rate_mean']):.2f} | "
                f"{float(item['final_forward_progress_m_mean']):.2f} | "
                f"{float(item['final_min_obstacle_clearance_m_min']):.2f} |"
            )
    lines += [
        "",
        "- **ACC** — final average performance across all tasks.",
        "- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.",
        "- **Forgetting** — mean drop from each task's best-ever to its final score.",
        "- **FWT** — forward transfer.",
        "",
        "Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over "
        "a sparse, task-localized representation (disjoint weight blocks per task). PPO's "
        "dense replay-based updates overwrite earlier skills as new tasks are learned.",
    ]
    (out_dir / "continual_benchmark.md").write_text("\n".join(lines) + "\n")


def _summarize(per_seed: dict[str, list[ContinualMetrics]]) -> dict:
    summary: dict[str, dict] = {}
    for name, metrics_list in per_seed.items():
        if not metrics_list:
            continue
        summary[name] = {
            key: {
                "mean": float(np.mean([getattr(m, key) for m in metrics_list])),
                "std": float(np.std([getattr(m, key) for m in metrics_list])),
            }
            for key in ("acc", "bwt", "forgetting", "fwt")
        }
    return summary


def _adaptation_summary(results: list[LearnerResult]) -> dict[str, dict[str, float | int]]:
    by_learner: dict[str, list[dict[str, float | int]]] = {}
    for result in results:
        matrix = np.asarray(result.matrix, dtype=np.float64)
        baseline = np.asarray(result.baseline, dtype=np.float64)
        if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1]:
            continue
        if baseline.shape != (matrix.shape[0],):
            continue
        diag = np.diag(matrix)
        final = matrix[-1]
        best = matrix.max(axis=0)
        new_task_gain = diag - baseline
        final_minus_best = final - best
        first_task_retention_delta = float(matrix[-1, 0] - matrix[0, 0])
        by_learner.setdefault(result.name, []).append(
            {
                "mean_new_task_gain": float(new_task_gain.mean()),
                "min_new_task_gain": float(new_task_gain.min()),
                "tasks_with_positive_gain": int((new_task_gain > 0.0).sum()),
                "task_count": int(matrix.shape[0]),
                "mean_final_minus_best": float(final_minus_best.mean()),
                "min_final_minus_best": float(final_minus_best.min()),
                "first_task_retention_delta": first_task_retention_delta,
            }
        )

    summary: dict[str, dict[str, float | int]] = {}
    for learner, rows in by_learner.items():
        if not rows:
            continue
        numeric_keys = (
            "mean_new_task_gain",
            "min_new_task_gain",
            "tasks_with_positive_gain",
            "task_count",
            "mean_final_minus_best",
            "min_final_minus_best",
            "first_task_retention_delta",
        )
        summary[learner] = {
            key: float(np.mean([float(row[key]) for row in rows]))
            for key in numeric_keys
        }
        summary[learner]["seeds"] = len(rows)
    return summary


def _motion_summary(results: list[LearnerResult]) -> dict[str, dict[str, float | int]]:
    by_learner: dict[str, list[dict[str, float]]] = {}
    for result in results:
        if not result.motion_matrix:
            continue
        final_row = result.motion_matrix[-1]
        if not final_row:
            continue
        by_learner.setdefault(result.name, []).append(
            {
                "final_success_rate_mean": float(
                    np.mean([float(item.get("success_rate", 0.0)) for item in final_row])
                ),
                "final_collision_rate_mean": float(
                    np.mean([float(item.get("collision_rate", 0.0)) for item in final_row])
                ),
                "final_passed_obstacle_rate_mean": float(
                    np.mean([float(item.get("passed_obstacle_rate", 0.0)) for item in final_row])
                ),
                "final_forward_progress_m_mean": float(
                    np.mean([float(item.get("mean_forward_progress_m", 0.0)) for item in final_row])
                ),
                "final_min_obstacle_clearance_m_min": float(
                    np.min([float(item.get("min_obstacle_clearance_m", 0.0)) for item in final_row])
                ),
            }
        )
    return {
        learner: {
            "seeds": len(rows),
            "final_success_rate_mean": float(
                np.mean([row["final_success_rate_mean"] for row in rows])
            ),
            "final_collision_rate_mean": float(
                np.mean([row["final_collision_rate_mean"] for row in rows])
            ),
            "final_passed_obstacle_rate_mean": float(
                np.mean([row["final_passed_obstacle_rate_mean"] for row in rows])
            ),
            "final_forward_progress_m_mean": float(
                np.mean([row["final_forward_progress_m_mean"] for row in rows])
            ),
            "final_min_obstacle_clearance_m_min": float(
                np.min([row["final_min_obstacle_clearance_m_min"] for row in rows])
            ),
        }
        for learner, rows in by_learner.items()
        if rows
    }


def _plot(per_seed, results, out_dir: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return

    # Mean retention curve: performance on task 0 across phases, both learners.
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.5))
    for name in ("alberta", "ppo"):
        mats = [np.array(r.matrix) for r in results if r.name == name]
        if not mats:
            continue
        stacked = np.stack(mats)  # (seeds, T, T)
        T = stacked.shape[1]
        # task 0 performance after each phase
        task0_curve = stacked[:, :, 0].mean(axis=0)
        ax1.plot(range(T), task0_curve, marker="o", label=name)
    ax1.set_xlabel("training phase (task index trained)")
    ax1.set_ylabel("eval return on task 0")
    ax1.set_title("Retention of task 0 as later tasks are learned")
    ax1.legend()
    ax1.grid(alpha=0.3)

    # Bar chart of summary metrics.
    summary = _summarize(per_seed)
    keys = ["acc", "bwt", "forgetting", "fwt"]
    x = np.arange(len(keys))
    width = 0.35
    names = [name for name in per_seed if name in summary]
    width = min(0.8 / max(len(names), 1), 0.35)
    offset_center = (len(names) - 1) / 2
    for k, name in enumerate(names):
        if name not in summary:
            continue
        means = [summary[name][key]["mean"] for key in keys]
        errs = [summary[name][key]["std"] for key in keys]
        ax2.bar(x + (k - offset_center) * width, means, width, yerr=errs, label=name, capsize=3)
    ax2.set_xticks(x)
    ax2.set_xticklabels(["ACC↑", "BWT↑", "Forget↓", "FWT↑"])
    ax2.set_title("Continual-learning metrics")
    ax2.axhline(0, color="k", lw=0.5)
    ax2.legend()
    ax2.grid(alpha=0.3, axis="y")

    fig.tight_layout()
    fig.savefig(out_dir / "continual_benchmark.png", dpi=120)
    plt.close(fig)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Alberta vs PPO continual-learning benchmark")
    p.add_argument(
        "--env",
        choices=("joint_reach", "obstacle_course"),
        default="joint_reach",
        help="Continual benchmark environment.",
    )
    p.add_argument("--n-tasks", type=int, default=4)
    p.add_argument("--n-joints", type=int, default=6)
    p.add_argument("--steps-per-task", type=int, default=30000)
    p.add_argument("--eval-episodes", type=int, default=10)
    p.add_argument("--seeds", type=int, default=3)
    p.add_argument("--gamma", type=float, default=0.5)
    p.add_argument("--actor-step-size", type=float, default=BenchmarkConfig.actor_step_size)
    p.add_argument("--critic-step-size", type=float, default=BenchmarkConfig.critic_step_size)
    p.add_argument("--actor-lamda", type=float, default=0.7)
    p.add_argument("--critic-lamda", type=float, default=BenchmarkConfig.critic_lamda)
    p.add_argument("--proprio-random-dim", type=int, default=64)
    p.add_argument("--n-prototypes", type=int, default=192)
    p.add_argument("--obstacle-episode-steps", type=int, default=80)
    p.add_argument(
        "--learners",
        nargs="+",
        choices=("alberta", "ppo", "sac"),
        default=list(BenchmarkConfig.learners),
        help="Sequential learners to run. Alberta and PPO are required; add sac for an off-policy baseline.",
    )
    p.add_argument("--out-dir", type=str, default="evidence/alberta")
    args = p.parse_args(argv)

    cfg = BenchmarkConfig(
        env_kind=args.env,
        n_tasks=args.n_tasks,
        n_joints=args.n_joints,
        steps_per_task=args.steps_per_task,
        eval_episodes=args.eval_episodes,
        seeds=args.seeds,
        gamma=args.gamma,
        actor_step_size=args.actor_step_size,
        critic_step_size=args.critic_step_size,
        actor_lamda=args.actor_lamda,
        critic_lamda=args.critic_lamda,
        proprio_random_dim=args.proprio_random_dim,
        n_prototypes=args.n_prototypes,
        obstacle_episode_steps=args.obstacle_episode_steps,
        learners=tuple(args.learners),
    )
    bundle = run_benchmark(cfg, Path(args.out_dir))
    print("\n=== SUMMARY (mean over seeds) ===")
    for name, m in bundle["summary"].items():
        print(
            f"{name:8s} ACC={m['acc']['mean']:6.2f}  BWT={m['bwt']['mean']:6.2f}  "
            f"Forgetting={m['forgetting']['mean']:6.2f}  FWT={m['fwt']['mean']:6.2f}"
        )


if __name__ == "__main__":
    main()
