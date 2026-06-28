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
HYBRID_PITCH_GAINS = (0.5, 1.0, 2.0, 4.0, 8.0)
HYBRID_ROLL_GAINS = (-0.5, 0.0, 0.5, 1.0, 2.0)
HYBRID_PRE_SCALES = (1.0, 1.15)
STABLE_BRIDGE_SCALE_MULTIPLIERS = (0.50, 0.75, 1.00, 1.25, 1.50, 2.00, 2.50)
STABLE_BRIDGE_HIP_BIAS_DELTAS = (-0.20, -0.10, 0.00, 0.10, 0.20, 0.35)
HYBRID_BRACED_RECOVERY_PARAMS: tuple[dict[str, Any], ...] = (
    {
        "feedback": {"pitch": 4.0, "roll": 0.5, "yaw": -0.5},
        "hybrid_recovery": {
            "switch_step": 20,
            "ramp_steps": 4,
            "pitch_gain": 4.0,
            "roll_gain": 6.0,
            "yaw_gain": 0.0,
            "pre_scale": 0.85,
            "post_bias": 0.0,
            "knee_bias": 0.3337764596642869,
            "hip_pitch_bias": -0.41531124380444756,
            "ank_pitch_bias": 0.4687101372562394,
            "hip_roll_bias": -0.48314861486182237,
            "ank_roll_bias": -0.41811811206214944,
        },
    },
    {
        "feedback": {"pitch": 8.0, "roll": 0.0, "yaw": -0.5},
        "hybrid_recovery": {
            "switch_step": 20,
            "ramp_steps": 6,
            "pitch_gain": 10.0,
            "roll_gain": 4.0,
            "yaw_gain": -2.0,
            "pre_scale": 0.65,
            "post_bias": 0.0,
            "knee_bias": 0.36258326593037715,
            "hip_pitch_bias": -0.6995112730745462,
            "ank_pitch_bias": 0.5600630238740617,
            "hip_roll_bias": -0.516618321435776,
            "ank_roll_bias": -0.4114894360531892,
        },
    },
    {
        "feedback": {"pitch": 6.0, "roll": 2.0, "yaw": 0.5},
        "hybrid_recovery": {
            "switch_dx": 0.30,
            "max_switch_step": 26,
            "ramp_steps": 1,
            "pitch_gain": 4.0,
            "roll_gain": 10.0,
            "yaw_gain": 2.0,
            "pre_scale": 0.65,
            "post_bias": 0.0,
            "knee_bias": -0.15088653206028385,
            "hip_pitch_bias": -0.636867992359232,
            "ank_pitch_bias": 0.6727036853376975,
            "hip_roll_bias": -0.30374909386899873,
            "ank_roll_bias": 0.37961316901534237,
        },
    },
    {
        "params": {
            "scale": 0.8465768408918739,
            "hz": 2.216995601838004,
            "phase0": -3.1391624968163203,
            "hip_bias": 0.15379566442312362,
            "hip_amp": 0.32769881917303806,
            "knee_bias": 0.38726151454357477,
            "knee_amp": 0.36022953057793583,
            "knee_phase": 0.6421970591888169,
            "ank_bias": 0.39116942391997045,
            "ank_amp": 0.127054285507044,
            "ank_phase": -1.9722242080014454,
            "roll_bias": -0.18224959759509585,
            "roll_amp": 0.2966744938237414,
            "ank_roll_amp": 0.12025318883037245,
            "roll_phase": 0.05231739235428862,
            "ank_roll_phase_delta": 1.0592762165532055,
            "yaw_amp": 0.0,
            "yaw_phase": -3.0957997999352855,
        },
        "feedback": {"pitch": 5.0, "roll": 1.5, "yaw": 0.0},
        "hybrid_recovery": {
            "switch_step": 24,
            "ramp_steps": 2,
            "pitch_gain": 0.022786920400847177,
            "roll_gain": -3.9796602205824394,
            "pre_scale": 1.1,
            "post_bias": 0.0,
            "yaw_gain": 2.0138034888751677,
            "knee_bias": -0.12235283455771334,
            "hip_pitch_bias": 0.1627192513265534,
            "ank_pitch_bias": 0.04519850266016692,
            "hip_roll_bias": -0.1462445349103719,
            "ank_roll_bias": 0.12288233087665291,
        },
    },
)


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
                    for roll_gain in HYBRID_ROLL_GAINS:
                        for pre_scale in HYBRID_PRE_SCALES:
                            row = dict(base_row)
                            row["hybrid_recovery"] = {
                                "switch_step": switch_step,
                                "ramp_steps": ramp_steps,
                                "pitch_gain": pitch_gain,
                                "roll_gain": roll_gain,
                                "pre_scale": pre_scale,
                                "post_bias": 0.0,
                            }
                            params.append(row)
    for braced in HYBRID_BRACED_RECOVERY_PARAMS:
        row = dict(braced.get("params") or base)
        row["feedback"] = dict(braced["feedback"])
        row["hybrid_recovery"] = dict(braced["hybrid_recovery"])
        params.append(row)
    return params


def _stable_bridge_refinement_params(base: dict[str, Any]) -> list[dict[str, Any]]:
    params: list[dict[str, Any]] = []
    for remove_feedback in (False, True):
        for remove_hybrid in (False, True):
            for scale_multiplier in STABLE_BRIDGE_SCALE_MULTIPLIERS:
                for hip_bias_delta in STABLE_BRIDGE_HIP_BIAS_DELTAS:
                    row = dict(base)
                    row["scale"] = float(base["scale"]) * scale_multiplier
                    row["hip_bias"] = float(base["hip_bias"]) + hip_bias_delta
                    if remove_feedback:
                        row.pop("feedback", None)
                    if remove_hybrid:
                        row.pop("hybrid_recovery", None)
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
    max_abs_yaw: float | None,
    torso_z: float | None,
    stand_height_m: float | None,
    max_swing_foot_clearance_m: float | None,
    max_foot_slip_m_s: float | None,
    max_self_collision_count: float | None,
    terminated: bool,
    foot_switches: int,
    success_window_s: float,
) -> list[str]:
    unmet = []
    if (
        torso_z is None
        or stand_height_m is None
        or torso_z < stand_height_m * 0.75
    ):
        unmet.append("torso_z_min_ratio")
    if dx is None or dx < 0.30:
        unmet.append("delta_x_m_min")
    if dy is None or abs(dy) > 0.20:
        unmet.append("max_lateral_drift_m")
    if max_abs_yaw is None or max_abs_yaw > 0.40:
        unmet.append("max_abs_delta_yaw_rad")
    if terminated:
        unmet.append("no_fall")
    if foot_switches < 2:
        unmet.append("min_alternating_foot_contacts")
    if max_swing_foot_clearance_m is None or max_swing_foot_clearance_m < 0.015:
        unmet.append("min_swing_foot_clearance_m")
    if max_foot_slip_m_s is None or max_foot_slip_m_s > 0.35:
        unmet.append("max_foot_slip_m_s")
    if max_self_collision_count is None or max_self_collision_count > 0:
        unmet.append("max_self_collision_count")
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


def _failure_info(info: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "tracked_delta_x",
        "tracked_delta_y",
        "delta_yaw",
        "torso_z",
        "stand_height_m",
        "fall_threshold",
        "upright_proj",
        "imu_roll",
        "imu_pitch",
        "left_foot_contact",
        "right_foot_contact",
        "left_foot_z",
        "right_foot_z",
        "max_swing_foot_clearance_m",
        "max_foot_slip_m_s",
        "self_collision_count",
        "max_self_collision_count",
        "done_reason",
        "success_predicate_now",
        "success_bound_violation",
        "raw_action_max_abs",
        "effective_action_max_abs",
    )
    return {key: info.get(key) for key in keys if key in info}


def _max_self_collision_observed(
    *,
    current_counts: list[float],
    max_counts: list[float],
    final_info: dict[str, Any],
) -> float | None:
    candidates = list(current_counts) + list(max_counts)
    for key in ("max_self_collision_count", "self_collision_count"):
        value = _finite_or_none(final_info.get(key))
        if value is not None:
            candidates.append(value)
    return _safe_max(candidates)


def _hybrid_recovery_action(
    env: TextConditionedProfileEnv,
    *,
    step: int,
    switch_step: int | None = None,
    start_pose: np.ndarray,
    recovery: dict[str, Any],
) -> np.ndarray:
    home_pose = env._home_pose.astype(np.float32)  # noqa: SLF001
    switch_step = int(switch_step if switch_step is not None else recovery["switch_step"])
    ramp_steps = max(1, int(recovery.get("ramp_steps", 1)))
    alpha = min(1.0, max(0.0, float(step - switch_step + 1) / float(ramp_steps)))
    alpha = alpha * alpha * (3.0 - 2.0 * alpha)
    target = (1.0 - alpha) * start_pose + alpha * home_pose
    pose = env._root_pose_summary()  # noqa: SLF001
    pitch = float(pose.get("pitch", 0.0))
    roll = float(pose.get("roll", 0.0))
    yaw = float(pose.get("yaw", 0.0)) - float(env._episode_start_yaw)  # noqa: SLF001
    pitch_gain = float(recovery.get("pitch_gain", 1.0))
    roll_gain = float(recovery.get("roll_gain", 0.0))
    yaw_gain = float(recovery.get("yaw_gain", 0.0))
    post_bias = float(recovery.get("post_bias", 0.0))
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        side = 1.0 if name.startswith("l_") else -1.0
        if "knee" in name:
            target[idx] += float(recovery.get("knee_bias", 0.0))
        if "hip_pitch" in name:
            target[idx] += (
                float(recovery.get("hip_pitch_bias", 0.0))
                + side * pitch_gain * pitch
                + side * post_bias
            )
        elif "ank_pitch" in name:
            target[idx] += float(recovery.get("ank_pitch_bias", 0.0))
            target[idx] -= side * pitch_gain * pitch + side * post_bias
        elif "hip_roll" in name:
            target[idx] += side * (
                float(recovery.get("hip_roll_bias", 0.0)) + roll_gain * roll
            )
        elif "ank_roll" in name:
            target[idx] -= side * (
                float(recovery.get("ank_roll_bias", 0.0)) + roll_gain * roll
            )
        elif "hip_yaw" in name:
            target[idx] -= side * yaw_gain * yaw
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
    continue_after_goal_failure: bool = False,
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
        "self_collision_count": [],
        "max_self_collision_count": [],
    }
    result = None
    max_success_window_s = 0.0
    info: dict[str, Any] = {}
    terminated = False
    truncated = False
    hybrid_start_pose: np.ndarray | None = None
    hybrid_switch_step: int | None = None
    latched_goal_failure: dict[str, Any] | None = None
    post_goal_failure_dx: list[float] = []
    post_goal_failure_max_success_window_s = 0.0
    for step in range(max_steps):
        hybrid_recovery = params.get("hybrid_recovery")
        if isinstance(hybrid_recovery, dict) and hybrid_switch_step is None:
            tracked_dx = _finite_or_none(info.get("tracked_delta_x"))
            if (
                (
                    "switch_step" in hybrid_recovery
                    and step >= int(hybrid_recovery["switch_step"])
                )
                or (
                    "switch_dx" in hybrid_recovery
                    and tracked_dx is not None
                    and tracked_dx >= float(hybrid_recovery["switch_dx"])
                )
                or (
                    "max_switch_step" in hybrid_recovery
                    and step >= int(hybrid_recovery["max_switch_step"])
                )
            ):
                hybrid_switch_step = step
        if (
            isinstance(hybrid_recovery, dict)
            and hybrid_switch_step is not None
            and step >= hybrid_switch_step
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
                switch_step=hybrid_switch_step,
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
        for key in ("self_collision_count", "max_self_collision_count"):
            value = _finite_or_none(info.get(key))
            if value is not None:
                traces[key].append(value)
        result = checker.update(_sample((step + 1) * env.config.control_dt_s, info))
        if result.failed and latched_goal_failure is None:
            latched_goal_failure = {
                "step": step + 1,
                "t_s": (step + 1) * env.config.control_dt_s,
                "reason": result.reason,
                "info": _failure_info(info),
                "hybrid_switch_step": hybrid_switch_step,
                "hybrid_active_at_failure": hybrid_switch_step is not None,
            }
        if latched_goal_failure is not None:
            value = _finite_or_none(info.get("tracked_delta_x"))
            if value is not None:
                post_goal_failure_dx.append(value)
            post_goal_failure_max_success_window_s = max(
                post_goal_failure_max_success_window_s,
                float(result.success_window_s),
            )
        max_success_window_s = max(
            max_success_window_s,
            float(result.success_window_s),
        )
        if (
            result.success
            or terminated
            or truncated
            or (result.failed and not continue_after_goal_failure)
        ):
            break
    if result is None:
        raise RuntimeError("rollout produced no result")
    dx = _finite_or_none(info.get("tracked_delta_x"))
    dy = _finite_or_none(info.get("tracked_delta_y"))
    yaw = _finite_or_none(info.get("delta_yaw"))
    max_abs_yaw = _safe_max_abs(traces["delta_yaw"])
    torso_z = _finite_or_none(info.get("torso_z"))
    stand_height_m = _finite_or_none(info.get("stand_height_m"))
    max_swing_foot_clearance_m = _finite_or_none(
        info.get("max_swing_foot_clearance_m")
    )
    max_foot_slip_m_s = _finite_or_none(info.get("max_foot_slip_m_s"))
    max_self_collision_count = _max_self_collision_observed(
        current_counts=traces["self_collision_count"],
        max_counts=traces["max_self_collision_count"],
        final_info=info,
    )
    foot_switches = _count_alternating_contacts(
        traces["left_foot_contact"],
        traces["right_foot_contact"],
    )
    unmet = _unmet_predicates(
        dx=dx,
        dy=dy,
        max_abs_yaw=max_abs_yaw,
        torso_z=torso_z,
        stand_height_m=stand_height_m,
        max_swing_foot_clearance_m=max_swing_foot_clearance_m,
        max_foot_slip_m_s=max_foot_slip_m_s,
        max_self_collision_count=max_self_collision_count,
        terminated=terminated,
        foot_switches=foot_switches,
        success_window_s=max_success_window_s,
    )
    strict_success = bool(result.success) and latched_goal_failure is None
    return {
        "task_id": task_id,
        "controller": name,
        "action_scale": action_scale,
        "controller_params": params,
        "success": strict_success,
        "failed": bool(result.failed or latched_goal_failure is not None),
        "reason": (
            str(latched_goal_failure["reason"])
            if latched_goal_failure is not None
            else result.reason
        ),
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
        "final_torso_z_m": torso_z,
        "stand_height_m": stand_height_m,
        "max_swing_foot_clearance_m": max_swing_foot_clearance_m,
        "max_foot_slip_m_s": max_foot_slip_m_s,
        "max_self_collision_count": max_self_collision_count,
        "max_abs_delta_yaw_rad": max_abs_yaw,
        "max_success_window_s": max_success_window_s,
        "foot_contact_switches": foot_switches,
        "goal_failure_latched": latched_goal_failure is not None,
        "first_goal_failure_step": (
            latched_goal_failure["step"] if latched_goal_failure is not None else None
        ),
        "first_goal_failure_t_s": (
            latched_goal_failure["t_s"] if latched_goal_failure is not None else None
        ),
        "first_goal_failure_reason": (
            latched_goal_failure["reason"] if latched_goal_failure is not None else None
        ),
        "first_goal_failure_info": (
            latched_goal_failure["info"] if latched_goal_failure is not None else None
        ),
        "post_goal_failure_steps": len(post_goal_failure_dx),
        "post_goal_failure_final_delta_x_m": (
            post_goal_failure_dx[-1] if post_goal_failure_dx else None
        ),
        "post_goal_failure_max_delta_x_m": _safe_max(post_goal_failure_dx),
        "post_goal_failure_max_success_window_s": (
            post_goal_failure_max_success_window_s
        ),
        "recovered_success_after_goal_failure": bool(
            latched_goal_failure is not None and result.success
        ),
        "hybrid_switch_step": hybrid_switch_step,
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
    continue_after_goal_failure: bool = False,
) -> list[dict[str, Any]]:
    return [
        _rollout_candidate(
            env,
            name=f"{prefix}_{idx:03d}",
            params=row,
            max_steps=max_steps,
            continue_after_goal_failure=continue_after_goal_failure,
        )
        for idx, row in enumerate(params)
    ]


def _physical_gate_score(row: dict[str, Any]) -> tuple:
    unmet = set(row.get("diagnostics", {}).get("unmet_success_predicates") or [])
    gate_names = {
        "torso_z_min_ratio",
        "delta_x_m_min",
        "max_lateral_drift_m",
        "max_abs_delta_yaw_rad",
        "no_fall",
        "min_alternating_foot_contacts",
        "min_swing_foot_clearance_m",
        "max_foot_slip_m_s",
        "max_self_collision_count",
        "hold_s",
    }
    passed = len(gate_names - unmet)
    return (
        bool(row.get("success")),
        passed,
        "hold_s" not in unmet,
        "no_fall" not in unmet,
        "max_foot_slip_m_s" not in unmet,
        "torso_z_min_ratio" not in unmet,
        float(row.get("max_success_window_s") or 0.0),
        float(row.get("final_delta_x_m") or 0.0),
        -abs(float(row.get("final_delta_y_m") or 0.0)),
        -abs(float(row.get("final_delta_yaw_rad") or 0.0)),
    )


def _stable_bridge_score(row: dict[str, Any]) -> tuple:
    unmet = set(row.get("diagnostics", {}).get("unmet_success_predicates") or [])
    return (
        bool(row.get("success")),
        "torso_z_min_ratio" not in unmet,
        "max_foot_slip_m_s" not in unmet,
        "max_lateral_drift_m" not in unmet,
        "max_abs_delta_yaw_rad" not in unmet,
        "min_alternating_foot_contacts" not in unmet,
        "max_self_collision_count" not in unmet,
        float(row.get("final_delta_x_m") or 0.0),
        "no_fall" not in unmet,
        "hold_s" not in unmet,
    )


def _top_by(candidates: list[dict[str, Any]], *, key, limit: int = 20) -> list[dict[str, Any]]:
    return sorted(candidates, key=key, reverse=True)[:limit]


def _refine_best_straight(
    env: TextConditionedProfileEnv,
    *,
    broad_frontier: dict[str, Any],
    seed: int,
    n_candidates: int,
    max_steps: int,
    continue_after_goal_failure: bool = False,
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
            "top_by_physical_gates": [],
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
        continue_after_goal_failure=continue_after_goal_failure,
    )
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "top_by_physical_gates": _top_by(candidates, key=_physical_gate_score),
        "candidates": candidates,
    }


def _transition_refine_near_walk(
    env: TextConditionedProfileEnv,
    *,
    local_refinement: dict[str, Any],
    max_steps: int,
    continue_after_goal_failure: bool = False,
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
            "best_by_physical_gates": None,
            "top_by_success_window": [],
            "top_by_physical_gates": [],
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"transition_{base.get('controller')}",
        params=_transition_refinement_params(base["controller_params"]),
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    best_by_success_window = max(
        candidates,
        key=lambda row: (
            float(row.get("max_success_window_s") or 0.0),
            float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        ),
        default=None,
    )
    best_by_physical_gates = max(candidates, key=_physical_gate_score, default=None)
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "best_by_success_window": best_by_success_window,
        "best_by_physical_gates": best_by_physical_gates,
        "top_by_success_window": _top_by(
            candidates,
            key=lambda row: (
                float(row.get("max_success_window_s") or 0.0),
                float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
            ),
        ),
        "top_by_physical_gates": _top_by(candidates, key=_physical_gate_score),
        "candidates": candidates,
    }


def _feedback_refine_near_walk(
    env: TextConditionedProfileEnv,
    *,
    local_refinement: dict[str, Any],
    max_steps: int,
    continue_after_goal_failure: bool = False,
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
            "top_by_success_window": [],
            "top_by_physical_gates": [],
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"feedback_{base.get('controller')}",
        params=_feedback_refinement_params(base["controller_params"]),
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    best_by_success_window = max(
        candidates,
        key=lambda row: (
            float(row.get("max_success_window_s") or 0.0),
            float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        ),
        default=None,
    )
    best_by_physical_gates = max(candidates, key=_physical_gate_score, default=None)
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "best_by_success_window": best_by_success_window,
        "best_by_physical_gates": best_by_physical_gates,
        "top_by_success_window": _top_by(
            candidates,
            key=lambda row: (
                float(row.get("max_success_window_s") or 0.0),
                float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
            ),
        ),
        "top_by_physical_gates": _top_by(candidates, key=_physical_gate_score),
        "candidates": candidates,
    }


def _hybrid_recovery_refine_near_walk(
    env: TextConditionedProfileEnv,
    *,
    feedback_refinement: dict[str, Any],
    local_refinement: dict[str, Any],
    max_steps: int,
    continue_after_goal_failure: bool = False,
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
            "best_by_physical_gates": None,
            "top_by_success_window": [],
            "top_by_physical_gates": [],
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"hybrid_{base.get('controller')}",
        params=_hybrid_recovery_refinement_params(base["controller_params"]),
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    best_by_success_window = max(
        candidates,
        key=lambda row: (
            float(row.get("max_success_window_s") or 0.0),
            float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        ),
        default=None,
    )
    best_by_physical_gates = max(candidates, key=_physical_gate_score, default=None)
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "best_by_success_window": best_by_success_window,
        "best_by_physical_gates": best_by_physical_gates,
        "top_by_success_window": _top_by(
            candidates,
            key=lambda row: (
                float(row.get("max_success_window_s") or 0.0),
                float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
            ),
        ),
        "top_by_physical_gates": _top_by(candidates, key=_physical_gate_score),
        "candidates": candidates,
    }


def _stable_bridge_refine_near_walk(
    env: TextConditionedProfileEnv,
    *,
    hybrid_recovery_refinement: dict[str, Any],
    max_steps: int,
    continue_after_goal_failure: bool = False,
) -> dict[str, Any]:
    base = hybrid_recovery_refinement.get("best_by_physical_gates")
    if not isinstance(base, dict) or not isinstance(base.get("controller_params"), dict):
        return {
            "base_controller": None,
            "n_candidates": 0,
            "n_success": 0,
            "any_success": False,
            "failure_frontier": _failure_frontier([]),
            "best_by_success_window": None,
            "best_by_physical_gates": None,
            "best_by_stable_bridge": None,
            "top_by_success_window": [],
            "top_by_physical_gates": [],
            "top_by_stable_bridge": [],
            "candidates": [],
        }
    candidates = _run_candidates(
        env,
        prefix=f"stable_bridge_{base.get('controller')}",
        params=_stable_bridge_refinement_params(base["controller_params"]),
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    best_by_success_window = max(
        candidates,
        key=lambda row: (
            float(row.get("max_success_window_s") or 0.0),
            float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        ),
        default=None,
    )
    best_by_physical_gates = max(candidates, key=_physical_gate_score, default=None)
    best_by_stable_bridge = max(candidates, key=_stable_bridge_score, default=None)
    return {
        "base_controller": base.get("controller"),
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any(row["success"] for row in candidates),
        "failure_frontier": _failure_frontier(candidates),
        "best_by_success_window": best_by_success_window,
        "best_by_physical_gates": best_by_physical_gates,
        "best_by_stable_bridge": best_by_stable_bridge,
        "top_by_success_window": _top_by(
            candidates,
            key=lambda row: (
                float(row.get("max_success_window_s") or 0.0),
                float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
            ),
        ),
        "top_by_physical_gates": _top_by(candidates, key=_physical_gate_score),
        "top_by_stable_bridge": _top_by(candidates, key=_stable_bridge_score),
        "candidates": candidates,
    }


def search(
    *,
    seed: int,
    n_candidates: int,
    n_refinement_candidates: int,
    max_steps: int,
    continue_after_goal_failure: bool = False,
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
        continue_after_goal_failure=continue_after_goal_failure,
    )
    frontier = _failure_frontier(candidates)
    local_refinement = _refine_best_straight(
        env,
        broad_frontier=frontier,
        seed=seed + 1,
        n_candidates=n_refinement_candidates,
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    transition_refinement = _transition_refine_near_walk(
        env,
        local_refinement=local_refinement,
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    feedback_refinement = _feedback_refine_near_walk(
        env,
        local_refinement=local_refinement,
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    hybrid_recovery_refinement = _hybrid_recovery_refine_near_walk(
        env,
        feedback_refinement=feedback_refinement,
        local_refinement=local_refinement,
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    stable_bridge_refinement = _stable_bridge_refine_near_walk(
        env,
        hybrid_recovery_refinement=hybrid_recovery_refinement,
        max_steps=max_steps,
        continue_after_goal_failure=continue_after_goal_failure,
    )
    any_success = (
        any(row["success"] for row in candidates)
        or bool(local_refinement.get("any_success"))
        or bool(transition_refinement.get("any_success"))
        or bool(feedback_refinement.get("any_success"))
        or bool(hybrid_recovery_refinement.get("any_success"))
        or bool(stable_bridge_refinement.get("any_success"))
    )
    return {
        "schema": "hiwonder-random-sine-gait-search-v1",
        "profile_id": "hiwonder-ainex",
        "task_id": "walk_forward",
        "seed": seed,
        "max_steps": max_steps,
        "continue_after_goal_failure": continue_after_goal_failure,
        "n_candidates": len(candidates),
        "n_success": sum(1 for row in candidates if row["success"]),
        "any_success": any_success,
        "failure_frontier": frontier,
        "local_refinement": local_refinement,
        "transition_refinement": transition_refinement,
        "feedback_refinement": feedback_refinement,
        "hybrid_recovery_refinement": hybrid_recovery_refinement,
        "stable_bridge_refinement": stable_bridge_refinement,
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
    best_hybrid_physical = hybrid.get("best_by_physical_gates")
    best_hybrid_physical = (
        best_hybrid_physical if isinstance(best_hybrid_physical, dict) else {}
    )
    stable_bridge_refinement = report.get("stable_bridge_refinement")
    stable_bridge_refinement = (
        stable_bridge_refinement if isinstance(stable_bridge_refinement, dict) else {}
    )
    stable_bridge_frontier = stable_bridge_refinement.get("failure_frontier")
    stable_bridge_frontier = (
        stable_bridge_frontier if isinstance(stable_bridge_frontier, dict) else {}
    )
    best_stable_bridge = stable_bridge_refinement.get("best_by_stable_bridge")
    best_stable_bridge = (
        best_stable_bridge if isinstance(best_stable_bridge, dict) else {}
    )
    best_stable_bridge_physical = stable_bridge_refinement.get("best_by_physical_gates")
    best_stable_bridge_physical = (
        best_stable_bridge_physical
        if isinstance(best_stable_bridge_physical, dict)
        else {}
    )
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
        f"- best physical-gates controller: `{best_hybrid_physical.get('controller')}`",
        f"- best physical-gates dx m: `{best_hybrid_physical.get('final_delta_x_m')}`",
        f"- best physical-gates torso z m: `{best_hybrid_physical.get('final_torso_z_m')}`",
        f"- best physical-gates max foot slip m/s: `{best_hybrid_physical.get('max_foot_slip_m_s')}`",
        f"- best physical-gates failure: `{', '.join(best_hybrid_physical.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_hybrid_physical.get('termination_reason') or 'none'}`",
        "",
        "## Stable Bridge Refinement",
        "",
        f"- base controller: `{stable_bridge_refinement.get('base_controller')}`",
        f"- candidates: `{stable_bridge_refinement.get('n_candidates')}`",
        f"- successes: `{stable_bridge_refinement.get('n_success')}`",
        f"- primary gap: `{stable_bridge_frontier.get('primary_gap')}`",
        f"- forward-displacement candidates: `{stable_bridge_frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall + straight candidates: `{stable_bridge_frontier.get('n_forward_no_fall_straight_candidates')}`",
        f"- best stable-bridge controller: `{best_stable_bridge.get('controller')}`",
        f"- best stable-bridge dx m: `{best_stable_bridge.get('final_delta_x_m')}`",
        f"- best stable-bridge torso z m: `{best_stable_bridge.get('final_torso_z_m')}`",
        f"- best stable-bridge max foot slip m/s: `{best_stable_bridge.get('max_foot_slip_m_s')}`",
        f"- best stable-bridge failure: `{', '.join(best_stable_bridge.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_stable_bridge.get('termination_reason') or 'none'}`",
        f"- best physical-gates controller: `{best_stable_bridge_physical.get('controller')}`",
        f"- best physical-gates dx m: `{best_stable_bridge_physical.get('final_delta_x_m')}`",
        f"- best physical-gates failure: `{', '.join(best_stable_bridge_physical.get('diagnostics', {}).get('unmet_success_predicates') or []) or best_stable_bridge_physical.get('termination_reason') or 'none'}`",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--n-candidates", type=int, default=240)
    parser.add_argument("--n-refinement-candidates", type=int, default=220)
    parser.add_argument("--max-steps", type=int, default=320)
    parser.add_argument(
        "--continue-after-goal-failure",
        action="store_true",
        help=(
            "diagnostic only: keep rolling after GoalChecker failure while "
            "latching strict failure; env termination still stops the rollout"
        ),
    )
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
        continue_after_goal_failure=args.continue_after_goal_failure,
    )
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(args.out_md, report)
    print(json.dumps(report, indent=2))
    return 0 if report["any_success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
