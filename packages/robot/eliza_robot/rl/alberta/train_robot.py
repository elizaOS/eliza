"""Train a robot policy on the real MuJoCo env with the Alberta controller.

This is the productionization of the Alberta integration: the *same* streaming
continual controller proven on the fast JointReach benchmark, now driving the
profile-driven MuJoCo ``TextConditionedProfileEnv``. It trains either a single
task or a continual sequence of tasks (one phase each, weights preserved across
phases — the robot accumulates skills) and writes a checkpoint + a
``manifest.json`` with ``regime="alberta_streaming"`` so the existing
``TextConditionedPolicy`` inference path can load and run it.

Run::

    uv run python -m eliza_robot.rl.alberta.train_robot \
        --profile hiwonder-ainex --tasks stand_up walk_forward --steps-per-task 4000

Keep step budgets modest locally — the MuJoCo humanoid is far heavier than the
benchmark env. Heavy/long training offloads to the GPU recipes; this path proves
the train -> checkpoint -> load -> infer round trip works end to end on Alberta.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np

from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample
from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.loop import evaluate, train_online


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def steps_per_task_from_total(total_steps: int, task_count: int) -> int:
    """Convert a user-facing total env-step budget into a per-task phase budget."""
    if total_steps < 1:
        raise ValueError("total_steps must be >= 1")
    if task_count < 1:
        raise ValueError("task_count must be >= 1")
    return max(1, int(math.ceil(total_steps / task_count)))


def _optional_float(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(out):
        return None
    return out


def _telemetry_sample_from_info(t_s: float, info: dict) -> TelemetrySample:
    return TelemetrySample(
        t_s=t_s,
        torso_x_m=_optional_float(info.get("root_x")),
        torso_y_m=_optional_float(info.get("root_y")),
        torso_z_m=_optional_float(info.get("torso_z")),
        yaw_rad=_optional_float(info.get("root_yaw")),
        imu_roll_rad=float(info.get("imu_roll", 0.0) or 0.0),
        imu_pitch_rad=float(info.get("imu_pitch", 0.0) or 0.0),
        extra={"stand_height_m": info.get("stand_height_m")},
    )


def _evaluate_task_success(
    controller: AlbertaContinualController,
    env,
    task,
    *,
    episodes: int,
    max_episode_steps: int,
    seed: int,
) -> dict:
    """Evaluate greedy policy against GoalChecker, not reward alone."""
    original_tasks = env.active_tasks
    env.active_tasks = [task]
    successes: list[bool] = []
    failures: list[bool] = []
    returns: list[float] = []
    lengths: list[int] = []
    reasons: list[str] = []
    try:
        for ep in range(max(1, int(episodes))):
            obs, info = env.reset(seed=seed + ep)
            checker = GoalChecker(task, episode_start_t_s=0.0)
            last_result = checker.update(_telemetry_sample_from_info(0.0, info))
            total = 0.0
            steps = 0
            terminated = False
            truncated = False
            while steps < max_episode_steps:
                action = controller.act_greedy(np.asarray(obs, dtype=np.float32))
                obs, reward, terminated, truncated, info = env.step(action)
                total += float(reward)
                steps += 1
                last_result = checker.update(
                    _telemetry_sample_from_info(
                        steps * env.config.control_dt_s,
                        info,
                    )
                )
                if terminated or truncated or last_result.success or last_result.failed:
                    break
            success = bool(last_result.success)
            failed = bool(last_result.failed or (terminated and not success))
            reason = str(last_result.reason or "")
            if failed and not reason:
                reason = "env_terminated_before_goal_success"
            successes.append(success)
            failures.append(failed)
            returns.append(total)
            lengths.append(steps)
            if reason:
                reasons.append(reason)
    finally:
        env.active_tasks = original_tasks
    return {
        "episodes": len(successes),
        "success_rate": float(np.mean(successes)) if successes else 0.0,
        "failure_rate": float(np.mean(failures)) if failures else 0.0,
        "mean_return": float(np.mean(returns)) if returns else 0.0,
        "mean_length": float(np.mean(lengths)) if lengths else 0.0,
        "reasons": reasons[:5],
    }


def train_robot(
    profile_id: str,
    tasks: list[str],
    steps_per_task: int,
    out_dir: Path,
    *,
    pca_dim: int = 32,
    episode_steps: int = 200,
    eval_episodes: int = 3,
    seed: int = 0,
    requested_total_steps: int | None = None,
    domain_rand: bool = True,
    require_phase_success: bool = False,
    min_phase_success_rate: float = 1.0,
    phase_eval_interval_steps: int | None = None,
) -> dict:
    """Train an Alberta controller on the MuJoCo env over a task sequence."""
    from eliza_robot.curriculum.loader import load_curriculum
    from eliza_robot.profiles.schema import load_profile
    from eliza_robot.rl.text_conditioned.profile_env import (
        ProfileEnvConfig,
        make_text_conditioned_env,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    profile = load_profile(profile_id)
    curriculum = load_curriculum()
    # One env spanning all requested tasks (shared obs/action space); pin a
    # single task per phase so the controller learns them sequentially.
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            tier_subset=(),
            include_tasks=tuple(tasks),
            exclude_tasks=(),
            pca_dim=pca_dim,
            episode_steps=episode_steps,
            domain_rand=domain_rand,
        ),
    )
    obs_dim = int(env.observation_space.shape[0])
    action_dim = int(env.action_space.shape[0])

    feature_cfg = FeatureConfig(
        mode="sparse_gated",
        embed_dim=pca_dim,
        n_prototypes=64,
        gate_hard=True,
        proprio_random_dim=32,
        seed=seed,
    )
    controller_cfg = AlbertaControllerConfig(
        obs_dim=obs_dim,
        action_dim=action_dim,
        gamma=0.5,
        actor_step_size=5e-3,
        critic_step_size=1e-2,
        log_sigma_init=-1.0,
        normalize=False,
        obgd_kappa=2.0,
        features=feature_cfg,
        seed=seed,
    )
    controller = AlbertaContinualController(controller_cfg)

    # Snapshot the full active-task list once; pinning replaces env.active_tasks
    # per phase, so we must index into this stable snapshot, not the mutated list.
    all_active = {t.id: t for t in env.active_tasks}
    history = []
    promotion_rows = []
    total_steps_run = 0
    eval_interval = int(phase_eval_interval_steps or steps_per_task)
    eval_interval = max(1, eval_interval)
    for phase, task in enumerate(tasks):
        if task not in all_active:
            raise ValueError(f"task {task!r} not in env active tasks {list(all_active)}")
        task_spec = all_active[task]
        env.active_tasks = [task_spec]
        phase_steps_run = 0
        phase_train_returns = []
        promoted = False
        promotion_eval = None
        while phase_steps_run < steps_per_task:
            chunk_steps = min(eval_interval, steps_per_task - phase_steps_run)
            stats = train_online(
                controller,
                env,
                chunk_steps,
                max_episode_steps=episode_steps,
                seed=seed + phase + phase_steps_run,
            )
            phase_steps_run += int(stats.total_steps)
            total_steps_run += int(stats.total_steps)
            phase_train_returns.extend(stats.episode_returns)
            ev = evaluate(
                controller,
                env,
                eval_episodes,
                max_episode_steps=episode_steps,
                seed=10_000 + phase + phase_steps_run,
            )
            promotion_eval = _evaluate_task_success(
                controller,
                env,
                task_spec,
                episodes=eval_episodes,
                max_episode_steps=episode_steps,
                seed=20_000 + phase + phase_steps_run,
            )
            promoted = (
                float(promotion_eval["success_rate"]) >= float(min_phase_success_rate)
            )
            if promoted:
                break
        if promotion_eval is None:
            promotion_eval = {
                "episodes": 0,
                "success_rate": 0.0,
                "failure_rate": 0.0,
                "mean_return": 0.0,
                "mean_length": 0.0,
                "reasons": [],
            }
            ev = evaluate(
                controller,
                env,
                eval_episodes,
                max_episode_steps=episode_steps,
                seed=10_000 + phase,
            )
        promotion_blocker = None if promoted else "phase_success_rate_below_threshold"
        history.append(
            {
                "phase": phase,
                "task": task,
                "train_steps": int(phase_steps_run),
                "train_episodes": len(phase_train_returns),
                "train_mean_return": float(np.mean(phase_train_returns))
                if phase_train_returns
                else 0.0,
                "eval_mean_return": ev.mean_return,
                "eval_success_rate": promotion_eval["success_rate"],
                "eval_failure_rate": promotion_eval["failure_rate"],
                "eval_mean_length": promotion_eval["mean_length"],
                "promoted": promoted,
                "promotion_passed": promoted,
                "promotion_blocker": promotion_blocker,
                "promotion_reasons": promotion_eval["reasons"],
            }
        )
        promotion_rows.append(
            {
                "phase": phase,
                "task": task,
                "attempt": 1,
                "steps_trained": int(phase_steps_run),
                "cumulative_steps": int(total_steps_run),
                "eval_episodes": int(eval_episodes),
                "eval_mean_return": float(ev.mean_return),
                "success_rate": promotion_eval["success_rate"],
                "eval_success_rate": promotion_eval["success_rate"],
                "failure_rate": promotion_eval["failure_rate"],
                "eval_failures": int(
                    round(
                        float(promotion_eval["failure_rate"])
                        * int(promotion_eval["episodes"])
                    )
                ),
                "promoted": promoted,
                "promotion_passed": promoted,
                "promotion_reason": (
                    "success_rate_gte_threshold"
                    if promoted
                    else "success_rate_below_threshold"
                ),
                "blocker": promotion_blocker,
            }
        )
        print(
            f"[phase {phase}] task={task:14s} train_steps={phase_steps_run:8d} "
            f"eval_ret={ev.mean_return:8.2f} "
            f"success={promotion_eval['success_rate']:.2f} promoted={promoted}"
        )
        if require_phase_success and not promoted:
            raise RuntimeError(
                f"task {task!r} did not reach phase promotion threshold "
                f"{min_phase_success_rate:.3f}; success_rate="
                f"{promotion_eval['success_rate']:.3f}"
            )

    # Persist controller params + manifest in the TextConditionedPolicy layout.
    snap = controller.state_dict()
    np.savez(out_dir / "alberta_policy.npz", **snap)
    all_promoted = all(row["promoted"] for row in promotion_rows)
    failed_phase = next(
        (row["phase"] for row in promotion_rows if not row["promoted"]),
        None,
    )
    manifest = {
        "regime": "alberta_streaming",
        "phase_promotion_schema": "alberta-phase-promotion-v1",
        "curriculum_version": curriculum.version,
        "pca_dim": pca_dim,
        "active_tasks": list(tasks),
        "obs_dim": obs_dim,
        "action_dim": action_dim,
        "output_dim": len(profile.kinematics.joints),
        "profile_id": profile_id,
        "profile_version": profile.version,
        "proprio_dim": obs_dim - pca_dim,
        "text_dim": pca_dim,
        "ckpt": "alberta_policy.npz",
        "requested_total_steps": int(
            requested_total_steps
            if requested_total_steps is not None
            else steps_per_task * len(tasks)
        ),
        "steps_per_task": int(steps_per_task),
        "total_steps": int(total_steps_run),
        "episode_steps": int(episode_steps),
        "eval_episodes": int(eval_episodes),
        "seed": int(seed),
        "domain_rand": bool(domain_rand),
        "phase_promotion": {
            "gate": "curriculum_goal_checker",
            "status": "completed" if all_promoted else "failed",
            "success_threshold": float(min_phase_success_rate),
            "eval_episodes": int(eval_episodes),
            "eval_interval_steps": int(eval_interval),
            "max_phase_attempts": 1,
            "promoted_phase_count": sum(1 for row in promotion_rows if row["promoted"]),
            "requested_phase_count": len(tasks),
            "failed_phase": failed_phase,
            "enabled": bool(require_phase_success),
            "min_success_rate": float(min_phase_success_rate),
            "all_promoted": bool(all_promoted),
            "phases": promotion_rows,
        },
        # Full controller config so TextConditionedPolicy can rebuild the exact
        # feature map + agent for inference.
        "controller": {
            "gamma": controller_cfg.gamma,
            "actor_step_size": controller_cfg.actor_step_size,
            "critic_step_size": controller_cfg.critic_step_size,
            "actor_lamda": controller_cfg.actor_lamda,
            "critic_lamda": controller_cfg.critic_lamda,
            "log_sigma_init": controller_cfg.log_sigma_init,
            "log_sigma_min": controller_cfg.log_sigma_min,
            "log_sigma_max": controller_cfg.log_sigma_max,
            "action_low": controller_cfg.action_low,
            "action_high": controller_cfg.action_high,
            "obgd_kappa": controller_cfg.obgd_kappa,
            "normalize": controller_cfg.normalize,
            "normalizer_decay": controller_cfg.normalizer_decay,
            "decouple_global_bias": controller_cfg.decouple_global_bias,
            "features": {
                "mode": feature_cfg.mode,
                "embed_dim": feature_cfg.embed_dim,
                "n_prototypes": feature_cfg.n_prototypes,
                "gate_hard": feature_cfg.gate_hard,
                "gate_temperature": feature_cfg.gate_temperature,
                "proprio_random_dim": feature_cfg.proprio_random_dim,
                "random_dim": feature_cfg.random_dim,
                "scale": feature_cfg.scale,
                "seed": feature_cfg.seed,
            },
        },
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "history": history,
    }
    if profile_id == "asimov-1":
        from eliza_robot.asimov_1.constants import (
            ASIMOV1_GENERATED_MANIFEST,
            ASIMOV1_GENERATED_MJCF,
        )

        manifest.update(
            {
                "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
                "mjcf_xml_sha256": _sha256_file(ASIMOV1_GENERATED_MJCF),
                "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
                "asset_manifest_sha256": _sha256_file(ASIMOV1_GENERATED_MANIFEST),
            }
        )
    if not all_promoted:
        manifest["non_production"] = True
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote checkpoint + manifest to {out_dir}")
    return manifest


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Train a robot policy with the Alberta controller")
    p.add_argument("--profile", default="hiwonder-ainex")
    p.add_argument("--tasks", nargs="+", default=["stand_up", "walk_forward"])
    p.add_argument("--steps-per-task", type=int, default=4000)
    p.add_argument("--episode-steps", type=int, default=200)
    p.add_argument("--eval-episodes", type=int, default=3)
    p.add_argument("--pca-dim", type=int, default=32)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out-dir", default="checkpoints/alberta_text_conditioned")
    p.add_argument("--require-phase-success", action="store_true")
    p.add_argument("--min-phase-success-rate", type=float, default=1.0)
    p.add_argument("--phase-eval-interval-steps", type=int, default=None)
    p.add_argument(
        "--no-domain-rand",
        action="store_true",
        help="disable MuJoCo domain randomization for deterministic debugging",
    )
    args = p.parse_args(argv)
    train_robot(
        args.profile,
        args.tasks,
        args.steps_per_task,
        Path(args.out_dir),
        pca_dim=args.pca_dim,
        episode_steps=args.episode_steps,
        eval_episodes=args.eval_episodes,
        seed=args.seed,
        domain_rand=not args.no_domain_rand,
        require_phase_success=args.require_phase_success,
        min_phase_success_rate=args.min_phase_success_rate,
        phase_eval_interval_steps=args.phase_eval_interval_steps,
    )


if __name__ == "__main__":
    main()
