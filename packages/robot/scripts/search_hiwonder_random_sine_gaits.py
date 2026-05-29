#!/usr/bin/env python3
"""Run a wider reproducible HiWonder sine-gait search with one MuJoCo env.

The fixed open-loop search is intentionally small. This script is the next
skeptical layer: it samples a deterministic set of sine gait parameters and
checks them against the same walk-forward curriculum predicate, while reusing
one environment so the runtime is spent on rollouts rather than repeated model
setup.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.curriculum.goal_checker import GoalChecker  # noqa: E402
from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    TextConditionedProfileEnv,
)
from scripts.search_hiwonder_open_loop_gaits import _failure_frontier  # noqa: E402
from scripts.validate_task_feasibility import (  # noqa: E402
    _finite_or_none,
    _make_sinusoidal_action,
    _safe_max,
    _safe_max_abs,
    _sample,
)

DEFAULT_SEED = 202605283
TRANSITION_SWITCH_STEPS = tuple(range(250, 268))
TRANSITION_HOLD_MODES = ("freeze", "zero")
TRANSITION_BLEND_STEPS = (0, 4, 8, 16)
FEEDBACK_PITCH_GAINS = (-1.0, -0.5, 0.0, 0.5, 1.0, 2.0)
FEEDBACK_ROLL_GAINS = (-1.0, -0.5, 0.0, 0.5)
FEEDBACK_YAW_GAINS = (-0.5, 0.0, 0.5, 1.0)
FEEDBACK_DAMP_STEPS = (240, 250, 260)
FEEDBACK_POST_SCALES = (0.0, 0.25, 0.5)
HYBRID_SWITCH_STEPS = (24, 26, 28, 30, 32)
HYBRID_RAMP_STEPS = (1, 2)
HYBRID_PITCH_GAINS = (0.5, 1.0, 2.0, 4.0)
HYBRID_PRE_SCALES = (1.0, 1.15)


def _candidate_params(*, seed: int, n_candidates: int) -> list[dict[str, float]]:
    rng = random.Random(seed)
    params = []
    for idx in range(n_candidates):
        stable_bias = idx % 3 == 0
        params.append(
            {
                "scale": rng.uniform(0.25, 0.55 if stable_bias else 0.70),
                "hz": rng.uniform(0.70, 2.80),
                "phase0": rng.uniform(-math.pi, math.pi),
                "hip_bias": rng.uniform(-0.10, 0.45),
                "hip_amp": rng.uniform(0.02, 0.75),
                "knee_bias": rng.uniform(-0.05, 0.45),
                "knee_amp": rng.uniform(0.02, 0.70),
                "knee_phase": rng.uniform(-math.pi, math.pi),
                "ank_bias": rng.uniform(-0.02, 0.55),
                "ank_amp": rng.uniform(0.02, 0.75),
                "ank_phase": rng.uniform(-math.pi, math.pi),
                "roll_bias": rng.uniform(-0.28, 0.15),
                "roll_amp": rng.uniform(0.0, 0.65 if stable_bias else 0.80),
                "ank_roll_amp": rng.uniform(0.0, 0.40),
                "roll_phase": rng.uniform(-math.pi, math.pi),
                "ank_roll_phase_delta": rng.uniform(-1.50, 1.50),
                "yaw_amp": (
                    0.0
                    if stable_bias
                    else rng.choice([0.0, rng.uniform(0.0, 0.08)])
                ),
                "yaw_phase": rng.uniform(-math.pi, math.pi),
            }
        )
    return params


def _local_refinement_params(
    base: dict[str, float],
    *,
    seed: int,
    n_candidates: int,
) -> list[dict[str, float]]:
    rng = random.Random(seed)
    params = []
    for _idx in range(n_candidates):
        row = dict(base)
        for key, relative_span in (
            ("scale", 0.20),
            ("hz", 0.25),
            ("hip_amp", 0.20),
            ("knee_amp", 0.25),
            ("ank_amp", 0.25),
            ("roll_amp", 0.25),
            ("ank_roll_amp", 0.25),
        ):
            row[key] = max(
                0.0,
                float(row[key]) * (1.0 + rng.uniform(-relative_span, relative_span)),
            )
        for key, absolute_span in (
            ("hip_bias", 0.08),
            ("knee_bias", 0.08),
            ("ank_bias", 0.08),
            ("roll_bias", 0.08),
            ("phase0", 0.45),
            ("knee_phase", 0.45),
            ("ank_phase", 0.45),
            ("roll_phase", 0.45),
            ("ank_roll_phase_delta", 0.35),
        ):
            row[key] = float(row[key]) + rng.uniform(-absolute_span, absolute_span)
        row["yaw_amp"] = 0.0
        params.append(row)
    return params


def _transition_refinement_params(
    base: dict[str, float],
    *,
    switch_steps: tuple[int, ...] = TRANSITION_SWITCH_STEPS,
    hold_modes: tuple[str, ...] = TRANSITION_HOLD_MODES,
    blend_steps: tuple[int, ...] = TRANSITION_BLEND_STEPS,
) -> list[dict[str, Any]]:
    params = []
    for switch_step in switch_steps:
        for hold_mode in hold_modes:
            for blend_step in blend_steps:
                row = dict(base)
                row["hold_switch_step"] = float(switch_step)
                row["hold_blend_steps"] = float(blend_step)
                row["hold_mode"] = hold_mode
                params.append(row)
    return params


def _feedback_refinement_params(base: dict[str, float]) -> list[dict[str, Any]]:
    params: list[dict[str, Any]] = []
    for pitch in FEEDBACK_PITCH_GAINS:
        for roll in FEEDBACK_ROLL_GAINS:
            for yaw in FEEDBACK_YAW_GAINS:
                row = dict(base)
                row["feedback"] = {
                    "pitch": pitch,
                    "roll": roll,
                    "yaw": yaw,
                }
                params.append(row)
    for pitch in (-1.0, -0.5, 0.5, 1.0, 2.0):
        for roll in (-0.5, 0.0, 0.5):
            for yaw in (-0.5, 0.0, 0.5):
                for damp_after in FEEDBACK_DAMP_STEPS:
                    for post_scale in FEEDBACK_POST_SCALES:
                        row = dict(base)
                        row["feedback"] = {
                            "pitch": pitch,
                            "roll": roll,
                            "yaw": yaw,
                            "damp_after": damp_after,
                            "post_scale": post_scale,
                        }
                        params.append(row)
    return params


def _hybrid_recovery_refinement_params(base: dict[str, Any]) -> list[dict[str, Any]]:
    base_variants = [dict(base)]
    if "feedback" in base:
        base_variants.append({key: value for key, value in base.items() if key != "feedback"})
    params: list[dict[str, Any]] = []
    for base_row in base_variants:
        for switch_step in HYBRID_SWITCH_STEPS:
            for ramp_steps in HYBRID_RAMP_STEPS:
                for pitch_gain in HYBRID_PITCH_GAINS:
                    for pre_scale in HYBRID_PRE_SCALES:
                        row = dict(base_row)
                        row["hybrid_recovery"] = {
                            "switch_step": switch_step,
                            "ramp_steps": ramp_steps,
                            "pitch_gain": pitch_gain,
                            "pre_scale": pre_scale,
                            "post_bias": 0.0,
                        }
                        params.append(row)
    return params


def _count_alternating_contacts(left: list[float], right: list[float]) -> int:
    switches = 0
    last_stance: str | None = None
    for left_contact, right_contact in zip(left, right, strict=False):
        stance = None
        if left_contact > 0.5 and right_contact <= 0.5:
            stance = "left"
        elif right_contact > 0.5 and left_contact <= 0.5:
            stance = "right"
        if stance is not None and last_stance is not None and stance != last_stance:
            switches += 1
        if stance is not None:
            last_stance = stance
    return switches


def _unmet_predicates(
    *,
    dx: float | None,
    dy: float | None,
    yaw: float | None,
    terminated: bool,
    foot_switches: int,
    success_window_s: float,
) -> list[str]:
    unmet = []
    if dx is None or dx < 0.30:
        unmet.append("delta_x_m_min")
    if dy is None or abs(dy) > 0.20:
        unmet.append("max_lateral_drift_m")
    if yaw is None or abs(yaw) > 0.40:
        unmet.append("max_abs_delta_yaw_rad")
    if terminated:
        unmet.append("no_fall")
    if foot_switches < 2:
        unmet.append("min_alternating_foot_contacts")
    if success_window_s < 1.0:
        unmet.append("hold_s")
    return unmet


def _apply_feedback(
    env: TextConditionedProfileEnv,
    action: np.ndarray,
    feedback: dict[str, Any],
    *,
    step: int,
) -> np.ndarray:
    pose = env._root_pose_summary()  # noqa: SLF001
    pitch = float(pose.get("pitch", 0.0))
    roll = float(pose.get("roll", 0.0))
    yaw = float(pose.get("yaw", 0.0)) - float(env._episode_start_yaw)  # noqa: SLF001
    corrected = action.copy()
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        side = 1.0 if name.startswith("l_") else -1.0
        if "hip_pitch" in name:
            corrected[idx] += side * float(feedback.get("pitch", 0.0)) * pitch
        elif "ank_pitch" in name:
            corrected[idx] -= side * float(feedback.get("pitch", 0.0)) * pitch
        elif "hip_roll" in name:
            corrected[idx] += side * float(feedback.get("roll", 0.0)) * roll
        elif "ank_roll" in name:
            corrected[idx] -= side * float(feedback.get("roll", 0.0)) * roll
        elif "hip_yaw" in name:
            corrected[idx] -= side * float(feedback.get("yaw", 0.0)) * yaw
    damp_after = feedback.get("damp_after")
    if damp_after is not None and step >= int(damp_after):
        corrected *= float(feedback.get("post_scale", 0.5))
    return corrected


def _hybrid_recovery_action(
    env: TextConditionedProfileEnv,
    *,
    step: int,
    start_pose: np.ndarray,
    recovery: dict[str, Any],
) -> np.ndarray:
    home_pose = env._home_pose.astype(np.float32)  # noqa: SLF001
    switch_step = int(recovery["switch_step"])
    ramp_steps = max(1, int(recovery.get("ramp_steps", 1)))
    alpha = min(1.0, max(0.0, float(step - switch_step + 1) / float(ramp_steps)))
    alpha = alpha * alpha * (3.0 - 2.0 * alpha)
    target = (1.0 - alpha) * start_pose + alpha * home_pose
    pose = env._root_pose_summary()  # noqa: SLF001
    pitch = float(pose.get("pitch", 0.0))
    pitch_gain = float(recovery.get("pitch_gain", 1.0))
    post_bias = float(recovery.get("post_bias", 0.0))
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        side = 1.0 if name.startswith("l_") else -1.0
        if "hip_pitch" in name:
            target[idx] += side * pitch_gain * pitch + side * post_bias
        elif "ank_pitch" in name:
            target[idx] -= side * pitch_gain * pitch + side * post_bias
    target = np.clip(target, env._lower, env._upper)  # noqa: SLF001
    action_scale = max(float(env.config.action_scale), 1e-6)
    return np.clip((target - home_pose) / action_scale, -1.0, 1.0).astype(
        np.float32
    )


def _rollout_candidate(
    env: TextConditionedProfileEnv,
    *,
    name: str,
    params: dict[str, Any],
    max_steps: int,
) -> dict[str, Any]:
    task_id = "walk_forward"
    task = load_curriculum().by_id(task_id)
    env.reset(seed=0)
    start_info = {
        "root_x": env._episode_start_x,  # noqa: SLF001
        "root_y": env._episode_start_y,  # noqa: SLF001
        "torso_z": env._episode_start_torso_z,  # noqa: SLF001
        "root_yaw": env._episode_start_yaw,  # noqa: SLF001
        "tracked_x": env._episode_start_tracked_x,  # noqa: SLF001
        "tracked_y": env._episode_start_tracked_y,  # noqa: SLF001
        "tracked_z": env._episode_start_tracked_z,  # noqa: SLF001
        "tracked_body_name": env._tracked_body_name,  # noqa: SLF001
        "stand_height_m": env._stand_height_m,  # noqa: SLF001
    }
    checker = GoalChecker(task, episode_start_t_s=0.0)
    checker.update(_sample(0.0, start_info))
    action_for_step = _make_sinusoidal_action(env, task_id, params=params)
    action_scale = float(params["scale"])
    traces = {
        "tracked_delta_x": [],
        "tracked_delta_y": [],
        "delta_yaw": [],
        "left_foot_contact": [],
        "right_foot_contact": [],
    }
    result = None
    max_success_window_s = 0.0
    info: dict[str, Any] = {}
    terminated = False
    truncated = False
    hybrid_start_pose: np.ndarray | None = None
    for step in range(max_steps):
        hybrid_recovery = params.get("hybrid_recovery")
        if (
            isinstance(hybrid_recovery, dict)
            and step >= int(hybrid_recovery["switch_step"])
        ):
            if hybrid_start_pose is None:
                hybrid_start_pose = np.array(
                    [
                        env._data.qpos[qpos_idx]  # noqa: SLF001
                        for qpos_idx in env._joint_qpos_idx  # noqa: SLF001
                    ],
                    dtype=np.float32,
                )
            action = _hybrid_recovery_action(
                env,
                step=step,
                start_pose=hybrid_start_pose,
                recovery=hybrid_recovery,
            )
        else:
            action = np.clip(action_for_step(step) * action_scale, -1.0, 1.0)
            if isinstance(hybrid_recovery, dict):
                action *= float(hybrid_recovery.get("pre_scale", 1.0))
            feedback = params.get("feedback")
            if isinstance(feedback, dict):
                action = _apply_feedback(env, action, feedback, step=step)
        _, _, terminated, truncated, info = env.step(action)
        info["terminated"] = terminated
        info["truncated"] = truncated
        for key in ("tracked_delta_x", "tracked_delta_y", "delta_yaw"):
            value = _finite_or_none(info.get(key))
            if value is not None:
                traces[key].append(value)
        for key in ("left_foot_contact", "right_foot_contact"):
            traces[key].append(1.0 if info.get(key) else 0.0)
        result = checker.update(_sample((step + 1) * env.config.control_dt_s, info))
        max_success_window_s = max(
            max_success_window_s,
            float(result.success_window_s),
        )
        if result.success or result.failed or terminated or truncated:
            break
    if result is None:
        raise RuntimeError("rollout produced no result")
    dx = _finite_or_none(info.get("tracked_delta_x"))
    dy = _finite_or_none(info.get("tracked_delta_y"))
    yaw = _finite_or_none(info.get("delta_yaw"))
    foot_switches = _count_alternating_contacts(
        traces["left_foot_contact"],
        traces["right_foot_contact"],
    )
    unmet = _unmet_predicates(
        dx=dx,
        dy=dy,
        yaw=yaw,
        terminated=terminated,
        foot_switches=foot_switches,
        success_window_s=max_success_window_s,
    )
    return {
        "task_id": task_id,
        "controller": name,
        "action_scale": action_scale,
        "controller_params": params,
        "success": bool(result.success),
        "failed": bool(result.failed),
        "reason": result.reason,
        "steps": len(traces["tracked_delta_x"]),
        "terminated": bool(terminated),
        "truncated": bool(truncated),
        "termination_reason": info.get("done_reason")
        or ("time_limit" if truncated else "fall" if terminated else None),
        "final_delta_x_m": dx,
        "max_delta_x_m": _safe_max(traces["tracked_delta_x"]),
        "final_delta_y_m": dy,
        "max_abs_delta_y_m": _safe_max_abs(traces["tracked_delta_y"]),
        "final_delta_yaw_rad": yaw,
        "max_abs_delta_yaw_rad": _safe_max_abs(traces["delta_yaw"]),
        "max_success_window_s": max_success_window_s,
        "foot_contact_switches": foot_switches,
        "diagnostics": {
            "unmet_success_predicates": unmet,
        },
    }


def _run_candidates(
    env: TextConditionedProfileEnv,
    *,
    prefix: str,
    params: list[dict[str, Any]],
    max_steps: int,
) -> list[dict[str, Any]]:
    return [
        _rollout_candidate(
            env,
            name=f"{prefix}_{idx:03d}",
            params=row,
            max_steps=max_steps,
        )
        for idx, row in enumerate(params)
    ]


def _refine_best_straight(
    env: TextConditionedProfileEnv,
    *,
    broad_frontier: dict[str, Any],
    seed: int,
    n_candidates: int,
    max_steps: int,
) -> dict[str, Any]:
    base = broad_frontier.get("best_forward_straight")
    if not isinstance(base, dict):
        base = broad_frontier.get("best_forward_any")
    if not isinstance(base, dict) or not isinstance(base.get("controller_params"), dict):
        return {
            "base_controller": None,
            "n_candidates": 0,
            "n_success": 0,
            "any_success": False,
            "failure_frontier": _failure_frontier([]),
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"local_{base.get('controller')}",
        params=_local_refinement_params(
            base["controller_params"],
            seed=seed,
            n_candidates=n_candidates,
        ),
        max_steps=max_steps,
    )
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "candidates": candidates,
    }


def _transition_refine_near_walk(
    env: TextConditionedProfileEnv,
    *,
    local_refinement: dict[str, Any],
    max_steps: int,
) -> dict[str, Any]:
    local_frontier = local_refinement.get("failure_frontier")
    local_frontier = local_frontier if isinstance(local_frontier, dict) else {}
    base = local_frontier.get("best_forward_straight")
    if not isinstance(base, dict):
        base = local_frontier.get("best_forward_any")
    if not isinstance(base, dict) or not isinstance(base.get("controller_params"), dict):
        return {
            "base_controller": None,
            "n_candidates": 0,
            "n_success": 0,
            "any_success": False,
            "failure_frontier": _failure_frontier([]),
            "best_by_success_window": None,
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"transition_{base.get('controller')}",
        params=_transition_refinement_params(base["controller_params"]),
        max_steps=max_steps,
    )
    best_by_success_window = max(
        candidates,
        key=lambda row: (
            float(row.get("max_success_window_s") or 0.0),
            float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        ),
        default=None,
    )
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "best_by_success_window": best_by_success_window,
        "candidates": candidates,
    }


def _feedback_refine_near_walk(
    env: TextConditionedProfileEnv,
    *,
    local_refinement: dict[str, Any],
    max_steps: int,
) -> dict[str, Any]:
    local_frontier = local_refinement.get("failure_frontier")
    local_frontier = local_frontier if isinstance(local_frontier, dict) else {}
    base = local_frontier.get("best_forward_straight")
    if not isinstance(base, dict):
        base = local_frontier.get("best_forward_any")
    if not isinstance(base, dict) or not isinstance(base.get("controller_params"), dict):
        return {
            "base_controller": None,
            "n_candidates": 0,
            "n_success": 0,
            "any_success": False,
            "failure_frontier": _failure_frontier([]),
            "best_by_success_window": None,
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"feedback_{base.get('controller')}",
        params=_feedback_refinement_params(base["controller_params"]),
        max_steps=max_steps,
    )
    best_by_success_window = max(
        candidates,
        key=lambda row: (
            float(row.get("max_success_window_s") or 0.0),
            float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        ),
        default=None,
    )
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "best_by_success_window": best_by_success_window,
        "candidates": candidates,
    }


def _hybrid_recovery_refine_near_walk(
    env: TextConditionedProfileEnv,
    *,
    feedback_refinement: dict[str, Any],
    local_refinement: dict[str, Any],
    max_steps: int,
) -> dict[str, Any]:
    feedback_frontier = feedback_refinement.get("failure_frontier")
    feedback_frontier = feedback_frontier if isinstance(feedback_frontier, dict) else {}
    base = feedback_frontier.get("best_forward_straight")
    if not isinstance(base, dict):
        local_frontier = local_refinement.get("failure_frontier")
        local_frontier = local_frontier if isinstance(local_frontier, dict) else {}
        base = local_frontier.get("best_forward_straight")
    if not isinstance(base, dict):
        base = feedback_frontier.get("best_forward_any")
    if not isinstance(base, dict) or not isinstance(base.get("controller_params"), dict):
        return {
            "base_controller": None,
            "n_candidates": 0,
            "n_success": 0,
            "any_success": False,
            "failure_frontier": _failure_frontier([]),
            "best_by_success_window": None,
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"hybrid_{base.get('controller')}",
        params=_hybrid_recovery_refinement_params(base["controller_params"]),
        max_steps=max_steps,
    )
    best_by_success_window = max(
        candidates,
        key=lambda row: (
            float(row.get("max_success_window_s") or 0.0),
            float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        ),
        default=None,
    )
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "best_by_success_window": best_by_success_window,
        "candidates": candidates,
    }


def search(
    *,
    seed: int,
    n_candidates: int,
    n_refinement_candidates: int,
    max_steps: int,
) -> dict[str, Any]:
    env = TextConditionedProfileEnv(
        "hiwonder-ainex",
        ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=max_steps,
            domain_rand=False,
            action_scale=1.0,
        ),
    )
    candidates = _run_candidates(
        env,
        prefix="random_sine",
        params=_candidate_params(seed=seed, n_candidates=n_candidates),
        max_steps=max_steps,
    )
    frontier = _failure_frontier(candidates)
    local_refinement = _refine_best_straight(
        env,
        broad_frontier=frontier,
        seed=seed + 1,
        n_candidates=n_refinement_candidates,
        max_steps=max_steps,
    )
    transition_refinement = _transition_refine_near_walk(
        env,
        local_refinement=local_refinement,
        max_steps=max_steps,
    )
    feedback_refinement = _feedback_refine_near_walk(
        env,
        local_refinement=local_refinement,
        max_steps=max_steps,
    )
    hybrid_recovery_refinement = _hybrid_recovery_refine_near_walk(
        env,
        feedback_refinement=feedback_refinement,
        local_refinement=local_refinement,
        max_steps=max_steps,
    )
    any_success = (
        any(row["success"] for row in candidates)
        or bool(local_refinement.get("any_success"))
        or bool(transition_refinement.get("any_success"))
        or bool(feedback_refinement.get("any_success"))
        or bool(hybrid_recovery_refinement.get("any_success"))
    )
    return {
        "schema": "hiwonder-random-sine-gait-search-v1",
        "profile_id": "hiwonder-ainex",
        "task_id": "walk_forward",
        "seed": seed,
        "max_steps": max_steps,
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any_success,
        "failure_frontier": frontier,
        "local_refinement": local_refinement,
        "transition_refinement": transition_refinement,
        "feedback_refinement": feedback_refinement,
        "hybrid_recovery_refinement": hybrid_recovery_refinement,
        "candidates": candidates,
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    frontier = report.get("failure_frontier")
    frontier = frontier if isinstance(frontier, dict) else {}
    best = frontier.get("best_forward_any")
    best = best if isinstance(best, dict) else {}
    stable = frontier.get("best_forward_no_fall_straight")
    stable = stable if isinstance(stable, dict) else {}
    local = report.get("local_refinement")
    local = local if isinstance(local, dict) else {}
    local_frontier = local.get("failure_frontier")
    local_frontier = local_frontier if isinstance(local_frontier, dict) else {}
    transition = report.get("transition_refinement")
    transition = transition if isinstance(transition, dict) else {}
    transition_frontier = transition.get("failure_frontier")
    transition_frontier = (
        transition_frontier if isinstance(transition_frontier, dict) else {}
    )
    best_transition = transition.get("best_by_success_window")
    best_transition = best_transition if isinstance(best_transition, dict) else {}
    feedback = report.get("feedback_refinement")
    feedback = feedback if isinstance(feedback, dict) else {}
    feedback_frontier = feedback.get("failure_frontier")
    feedback_frontier = (
        feedback_frontier if isinstance(feedback_frontier, dict) else {}
    )
    best_feedback = feedback.get("best_by_success_window")
    best_feedback = best_feedback if isinstance(best_feedback, dict) else {}
    hybrid = report.get("hybrid_recovery_refinement")
    hybrid = hybrid if isinstance(hybrid, dict) else {}
    hybrid_frontier = hybrid.get("failure_frontier")
    hybrid_frontier = hybrid_frontier if isinstance(hybrid_frontier, dict) else {}
    best_hybrid = hybrid.get("best_by_success_window")
    best_hybrid = best_hybrid if isinstance(best_hybrid, dict) else {}
    lines = [
        "# HiWonder Random Sine Gait Search",
        "",
        f"Any success: `{report.get('any_success')}`",
        f"Candidates: `{report.get('n_candidates')}`",
        f"Seed: `{report.get('seed')}`",
        "",
        "## Failure Frontier",
        "",
        f"- primary gap: `{frontier.get('primary_gap')}`",
        f"- forward-displacement candidates: `{frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best forward controller: `{best.get('controller')}`",
        f"- best forward peak dx m: `{best.get('max_delta_x_m')}`",
        f"- best no-fall straight controller: `{stable.get('controller')}`",
        f"- best no-fall straight peak dx m: `{stable.get('max_delta_x_m')}`",
        "",
        "## Local Refinement",
        "",
        f"- base controller: `{local.get('base_controller')}`",
        f"- candidates: `{local.get('n_candidates')}`",
        f"- successes: `{local.get('n_success')}`",
        f"- primary gap: `{local_frontier.get('primary_gap')}`",
        f"- forward-displacement candidates: `{local_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{local_frontier.get('n_forward_no_fall_straight_candidates')}`",
        "",
        "## Transition Refinement",
        "",
        f"- base controller: `{transition.get('base_controller')}`",
        f"- candidates: `{transition.get('n_candidates')}`",
        f"- successes: `{transition.get('n_success')}`",
        f"- primary gap: `{transition_frontier.get('primary_gap')}`",
        f"- forward-displacement candidates: `{transition_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{transition_frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best success-window controller: `{best_transition.get('controller')}`",
        f"- best success window s: `{best_transition.get('max_success_window_s')}`",
        f"- best success-window dx m: `{best_transition.get('final_delta_x_m')}`",
        f"- best success-window failure: `{', '.join(best_transition.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_transition.get('termination_reason') or 'none'}`",
        "",
        "## Feedback Refinement",
        "",
        f"- base controller: `{feedback.get('base_controller')}`",
        f"- candidates: `{feedback.get('n_candidates')}`",
        f"- successes: `{feedback.get('n_success')}`",
        f"- primary gap: `{feedback_frontier.get('primary_gap')}`",
        f"- forward-displacement candidates: `{feedback_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{feedback_frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best success-window controller: `{best_feedback.get('controller')}`",
        f"- best success window s: `{best_feedback.get('max_success_window_s')}`",
        f"- best success-window dx m: `{best_feedback.get('final_delta_x_m')}`",
        f"- best success-window failure: `{', '.join(best_feedback.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_feedback.get('termination_reason') or 'none'}`",
        "",
        "## Hybrid Recovery Refinement",
        "",
        f"- base controller: `{hybrid.get('base_controller')}`",
        f"- candidates: `{hybrid.get('n_candidates')}`",
        f"- successes: `{hybrid.get('n_success')}`",
        f"- primary gap: `{hybrid_frontier.get('primary_gap')}`",
        f"- forward-displacement candidates: `{hybrid_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{hybrid_frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best success-window controller: `{best_hybrid.get('controller')}`",
        f"- best success window s: `{best_hybrid.get('max_success_window_s')}`",
        f"- best success-window dx m: `{best_hybrid.get('final_delta_x_m')}`",
        f"- best success-window failure: `{', '.join(best_hybrid.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_hybrid.get('termination_reason') or 'none'}`",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--n-candidates", type=int, default=240)
    parser.add_argument("--n-refinement-candidates", type=int, default=220)
    parser.add_argument("--max-steps", type=int, default=320)
    parser.add_argument(
        "--out-json",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_random_sine_gait_search.json",
    )
    parser.add_argument(
        "--out-md",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_random_sine_gait_search.md",
    )
    args = parser.parse_args(argv)

    report = search(
        seed=args.seed,
        n_candidates=args.n_candidates,
        n_refinement_candidates=args.n_refinement_candidates,
        max_steps=args.max_steps,
    )
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(args.out_md, report)
    print(json.dumps(report, indent=2))
    return 0 if report["any_success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
