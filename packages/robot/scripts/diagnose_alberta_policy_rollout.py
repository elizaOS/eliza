"""Write step-level MuJoCo rollout diagnostics for an Alberta checkpoint."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.curriculum.goal_checker import GoalChecker
from eliza_robot.rl.alberta.train_robot import _telemetry_sample_from_info
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy
from eliza_robot.rl.text_conditioned.profile_env import (
    ProfileEnvConfig,
    make_text_conditioned_env,
)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if np.isfinite(number) else default


def _reward_totals(steps: list[dict[str, Any]]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for step in steps:
        terms = step.get("reward_terms")
        if not isinstance(terms, dict):
            continue
        for key, value in terms.items():
            totals[key] = totals.get(key, 0.0) + _float(value)
    return {key: float(value) for key, value in sorted(totals.items())}


def _first_step(steps: list[dict[str, Any]], predicate) -> int | None:
    for step in steps:
        if predicate(step):
            return int(step["step"])
    return None


def _episode_summary(
    *,
    steps: list[dict[str, Any]],
    final_info: dict[str, Any],
    goal_result: Any,
    slip_limit: float | None,
    fall_pitch: float,
    fall_roll: float,
    required_contacts: int | None,
) -> dict[str, Any]:
    max_abs_pitch = max(abs(_float(step.get("imu_pitch"))) for step in steps) if steps else 0.0
    max_abs_roll = max(abs(_float(step.get("imu_roll"))) for step in steps) if steps else 0.0
    max_foot_slip = max((_float(step.get("max_foot_slip_m_s")) for step in steps), default=0.0)
    max_tracked_dx = max((_float(step.get("tracked_delta_x")) for step in steps), default=0.0)
    max_abs_yaw = max(abs(_float(step.get("delta_yaw"))) for step in steps) if steps else 0.0
    first_slip_step = (
        _first_step(steps, lambda step: _float(step.get("max_foot_slip_m_s")) > slip_limit)
        if slip_limit is not None
        else None
    )
    first_required_contacts_step = (
        _first_step(
            steps,
            lambda step: _float(step.get("foot_contact_switch_count")) >= required_contacts,
        )
        if required_contacts is not None
        else None
    )
    first_no_support_after_required_contacts_step = (
        _first_step(
            steps,
            lambda step: (
                required_contacts is not None
                and _float(step.get("foot_contact_switch_count")) >= required_contacts
                and not bool(step.get("left_foot_contact"))
                and not bool(step.get("right_foot_contact"))
            ),
        )
        if required_contacts is not None
        else None
    )
    first_near_fall_tilt_step = _first_step(
        steps,
        lambda step: (
            abs(_float(step.get("imu_pitch"))) >= 0.9 * fall_pitch
            or abs(_float(step.get("imu_roll"))) >= 0.9 * fall_roll
        ),
    )
    reward_totals = _reward_totals(steps)
    return {
        "steps": len(steps),
        "terminated_reason": final_info.get("done_reason"),
        "goal_success": bool(getattr(goal_result, "success", False)),
        "goal_reason": getattr(goal_result, "reason", None),
        "goal_success_window_s": getattr(goal_result, "success_window_s", None),
        "final_tracked_delta_x_m": _float(final_info.get("tracked_delta_x")),
        "final_tracked_delta_y_m": _float(final_info.get("tracked_delta_y")),
        "final_tracked_z_m": _float(final_info.get("tracked_z")),
        "final_delta_yaw_rad": _float(final_info.get("delta_yaw")),
        "max_tracked_delta_x_m": max_tracked_dx,
        "max_abs_delta_yaw_rad": max_abs_yaw,
        "max_abs_pitch_rad": max_abs_pitch,
        "max_abs_roll_rad": max_abs_roll,
        "max_foot_slip_m_s": max_foot_slip,
        "foot_contact_switch_count": int(_float(final_info.get("foot_contact_switch_count"))),
        "first_slip_limit_step": first_slip_step,
        "first_required_contacts_step": first_required_contacts_step,
        "first_no_support_after_required_contacts_step": (
            first_no_support_after_required_contacts_step
        ),
        "first_near_fall_tilt_step": first_near_fall_tilt_step,
        "reward_totals": reward_totals,
    }


def diagnose(args: argparse.Namespace) -> dict[str, Any]:
    ckpt_dir = Path(args.checkpoint_dir)
    manifest = _load_json(ckpt_dir / "manifest.json")
    policy = TextConditionedPolicy(ckpt_dir, strict_manifest=True)
    feedback = manifest.get("locomotion_prior_feedback")
    if not isinstance(feedback, dict):
        feedback = {}
    env = make_text_conditioned_env(
        manifest.get("profile_id", args.profile),
        config=ProfileEnvConfig(
            include_tasks=(args.task,),
            exclude_tasks=(),
            pca_dim=int(manifest.get("pca_dim", 32)),
            episode_steps=int(args.max_steps or manifest.get("episode_steps", 200)),
            action_scale=float(manifest.get("action_scale", 1.0)),
            locomotion_action_prior=str(manifest.get("locomotion_action_prior", "none")),
            locomotion_prior_residual_scale=float(
                manifest.get("locomotion_prior_residual_scale", 0.0)
            ),
            locomotion_prior_residual_mode=str(
                manifest.get("locomotion_prior_residual_mode", "joint")
            ),
            locomotion_prior_feedback_pitch=float(feedback.get("pitch", 0.0)),
            locomotion_prior_feedback_roll=float(feedback.get("roll", 0.0)),
            locomotion_prior_feedback_yaw=float(feedback.get("yaw", 0.0)),
            domain_rand=bool(args.domain_rand),
        ),
    )
    task = env.active_tasks[0]
    success = task.success
    slip_limit = (
        float(success["max_foot_slip_m_s"])
        if "max_foot_slip_m_s" in success
        else None
    )
    required_contacts = (
        int(success["min_alternating_foot_contacts"])
        if "min_alternating_foot_contacts" in success
        else None
    )
    fall_pitch = float(success.get("fall_pitch_rad", 0.6))
    fall_roll = float(success.get("fall_roll_rad", 0.6))
    proprio_dim = int(manifest.get("proprio_dim", 0))
    if proprio_dim <= 0:
        proprio_dim = int(env.observation_space.shape[0]) - int(manifest.get("pca_dim", 32))
    episodes = []
    for episode in range(int(args.episodes)):
        obs, info = env.reset(seed=int(args.seed) + episode)
        checker = GoalChecker(task, episode_start_t_s=0.0)
        result = checker.update(_telemetry_sample_from_info(0.0, info))
        steps: list[dict[str, Any]] = []
        final_info = info
        for step_idx in range(int(args.max_steps or manifest.get("episode_steps", 200))):
            action, matched_task = policy.act(
                args.task,
                obs[:proprio_dim],
                deterministic=True,
                output_dim=env.action_space.shape[0],
            )
            obs, reward, terminated, truncated, info = env.step(action)
            result = checker.update(
                _telemetry_sample_from_info(
                    (step_idx + 1) * env.config.control_dt_s,
                    info,
                )
            )
            final_info = info
            steps.append(
                {
                    "step": step_idx + 1,
                    "t_s": (step_idx + 1) * env.config.control_dt_s,
                    "matched_task": matched_task,
                    "reward": float(reward),
                    "done_reason": info.get("done_reason"),
                    "tracked_delta_x": _float(info.get("tracked_delta_x")),
                    "tracked_delta_y": _float(info.get("tracked_delta_y")),
                    "tracked_z": _float(info.get("tracked_z")),
                    "delta_yaw": _float(info.get("delta_yaw")),
                    "imu_pitch": _float(info.get("imu_pitch")),
                    "imu_roll": _float(info.get("imu_roll")),
                    "left_foot_contact": bool(info.get("left_foot_contact")),
                    "right_foot_contact": bool(info.get("right_foot_contact")),
                    "foot_contact_switch_count": int(
                        _float(info.get("foot_contact_switch_count"))
                    ),
                    "left_foot_slip_m_s": _float(info.get("left_foot_slip_m_s")),
                    "right_foot_slip_m_s": _float(info.get("right_foot_slip_m_s")),
                    "max_foot_slip_m_s": _float(info.get("max_foot_slip_m_s")),
                    "locomotion_prior_goal_hold_scale": _float(
                        info.get("locomotion_prior_goal_hold_scale"),
                        1.0,
                    ),
                    "locomotion_prior_residual_stability_scale": _float(
                        info.get("locomotion_prior_residual_stability_scale"),
                        1.0,
                    ),
                    "reward_terms": info.get("reward_terms", {}),
                }
            )
            if terminated or truncated:
                break
        episodes.append(
            {
                "episode": episode,
                "summary": _episode_summary(
                    steps=steps,
                    final_info=final_info,
                    goal_result=result,
                    slip_limit=slip_limit,
                    fall_pitch=fall_pitch,
                    fall_roll=fall_roll,
                    required_contacts=required_contacts,
                ),
                "steps": steps,
            }
        )
    return {
        "schema": "alberta-policy-rollout-diagnostic-v1",
        "checkpoint_dir": str(ckpt_dir),
        "profile_id": manifest.get("profile_id", args.profile),
        "task": args.task,
        "episodes": episodes,
        "success": {
            "slip_limit_m_s": slip_limit,
            "required_alternating_contacts": required_contacts,
            "fall_pitch_rad": fall_pitch,
            "fall_roll_rad": fall_roll,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint-dir", required=True)
    parser.add_argument("--profile", default="hiwonder-ainex")
    parser.add_argument("--task", default="walk_forward")
    parser.add_argument("--episodes", type=int, default=1)
    parser.add_argument("--max-steps", type=int, default=0)
    parser.add_argument("--seed", type=int, default=28_000)
    parser.add_argument("--domain-rand", action="store_true")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    report = diagnose(args)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({**report, "episodes": [e["summary"] for e in report["episodes"]]}, indent=2))


if __name__ == "__main__":
    main()
