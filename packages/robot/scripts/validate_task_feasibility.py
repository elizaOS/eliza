#!/usr/bin/env python3
"""CPU-safe curriculum task feasibility smoke for profile MuJoCo envs.

This is not a training validator. It answers a narrower question: can the
declared reset + success predicates be satisfied at all by deterministic
controllers in the lightweight profile env? A failure here means training is
likely chasing an impossible or under-specified objective.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample  # noqa: E402
from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    TextConditionedProfileEnv,
)
from eliza_robot.sim.mujoco.gait import BezierGaitController  # noqa: E402
from eliza_robot.sim.mujoco.gait.controller import (  # noqa: E402
    L_ANK_PITCH,
    L_HIP_PITCH,
    R_ANK_PITCH,
    R_HIP_PITCH,
)

DEFAULT_TASKS = (
    "stand_up",
    "sit_down",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)

_MOTION_CLIP_DIR = ROOT / "assets" / "profiles" / "hiwonder-ainex" / "motions"


@dataclass(frozen=True)
class _PrimitiveSpec:
    name: str
    action_scale: float
    factory: Callable[[TextConditionedProfileEnv, str], Callable[[int], np.ndarray | None]]


def _sample(t_s: float, info: dict) -> TelemetrySample:
    return TelemetrySample(
        t_s=t_s,
        torso_x_m=_finite_or_none(info.get("root_x")),
        torso_y_m=_finite_or_none(info.get("root_y")),
        torso_z_m=_finite_or_none(info.get("torso_z")),
        yaw_rad=_finite_or_none(info.get("root_yaw")),
        imu_roll_rad=float(info.get("imu_roll", 0.0) or 0.0),
        imu_pitch_rad=float(info.get("imu_pitch", 0.0) or 0.0),
        extra={"stand_height_m": info.get("stand_height_m")},
    )


def _finite_or_none(value: object) -> float | None:
    try:
        out = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def _safe_min(values: list[float]) -> float | None:
    return min(values) if values else None


def _safe_max(values: list[float]) -> float | None:
    return max(values) if values else None


def _safe_max_abs(values: list[float]) -> float | None:
    return max(abs(value) for value in values) if values else None


def _wrap_pi(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


def _termination_reason(
    info: dict,
    *,
    terminated: bool,
    truncated: bool,
) -> str | None:
    for key in (
        "termination_reason",
        "terminal_reason",
        "done_reason",
        "terminated_reason",
    ):
        value = info.get(key)
        if isinstance(value, str) and value:
            return value
    if terminated:
        torso_z = _finite_or_none(info.get("torso_z"))
        fall_threshold = _finite_or_none(info.get("fall_threshold"))
        upright_proj = _finite_or_none(info.get("upright_proj"))
        if torso_z is not None and fall_threshold is not None and torso_z < fall_threshold:
            return "torso_z_below_fall_threshold"
        if upright_proj is not None and upright_proj < 0.0:
            return "upright_projection_negative"
        return "terminated"
    if truncated:
        return "episode_step_limit"
    return None


def _predicate_row(
    *,
    name: str,
    expected: object,
    actual: object,
    unmet: bool,
    observed_extreme: object | None = None,
) -> dict:
    row = {
        "predicate": name,
        "expected": expected,
        "actual": actual,
        "unmet": bool(unmet),
    }
    if observed_extreme is not None:
        row["observed_extreme"] = observed_extreme
    return row


def _success_predicate_diagnostics(
    *,
    success: dict,
    final_info: dict,
    traces: dict[str, list[float]],
    start_torso_z_m: float,
    stand_height_m: float,
    elapsed_s: float,
) -> list[dict]:
    diagnostics: list[dict] = []
    torso_z = _finite_or_none(final_info.get("torso_z"))
    delta_x = _finite_or_none(final_info.get("delta_x"))
    delta_y = _finite_or_none(final_info.get("delta_y"))
    delta_yaw = _finite_or_none(final_info.get("delta_yaw"))
    window_s = float(success.get("window_s", math.inf))
    within_window = elapsed_s <= window_s + 0.5

    if "torso_z_min_m" in success:
        threshold = float(success["torso_z_min_m"])
        diagnostics.append(
            _predicate_row(
                name="torso_z_min_m",
                expected={">=": threshold},
                actual=torso_z,
                unmet=torso_z is None or torso_z < threshold,
                observed_extreme={
                    "min": _safe_min(traces["torso_z"]),
                    "max": _safe_max(traces["torso_z"]),
                },
            )
        )
    if "torso_z_max_m" in success:
        threshold = float(success["torso_z_max_m"])
        diagnostics.append(
            _predicate_row(
                name="torso_z_max_m",
                expected={"<=": threshold},
                actual=torso_z,
                unmet=torso_z is None or torso_z > threshold,
                observed_extreme={
                    "min": _safe_min(traces["torso_z"]),
                    "max": _safe_max(traces["torso_z"]),
                },
            )
        )
    if "torso_z_min_ratio" in success:
        threshold = stand_height_m * float(success["torso_z_min_ratio"])
        diagnostics.append(
            _predicate_row(
                name="torso_z_min_ratio",
                expected={
                    ">=": threshold,
                    "ratio_of_stand_height": float(success["torso_z_min_ratio"]),
                },
                actual=torso_z,
                unmet=torso_z is None or torso_z < threshold,
                observed_extreme={
                    "min": _safe_min(traces["torso_z"]),
                    "max": _safe_max(traces["torso_z"]),
                },
            )
        )
    if "torso_z_max_ratio" in success:
        threshold = stand_height_m * float(success["torso_z_max_ratio"])
        diagnostics.append(
            _predicate_row(
                name="torso_z_max_ratio",
                expected={
                    "<=": threshold,
                    "ratio_of_stand_height": float(success["torso_z_max_ratio"]),
                },
                actual=torso_z,
                unmet=torso_z is None or torso_z > threshold,
                observed_extreme={
                    "min": _safe_min(traces["torso_z"]),
                    "max": _safe_max(traces["torso_z"]),
                },
            )
        )
    if "torso_z_delta_min_m" in success:
        threshold = float(success["torso_z_delta_min_m"])
        actual = None if torso_z is None else torso_z - start_torso_z_m
        diagnostics.append(
            _predicate_row(
                name="torso_z_delta_min_m",
                expected={">=": threshold},
                actual=actual,
                unmet=actual is None or actual < threshold,
            )
        )
    if "torso_z_delta_min_ratio" in success:
        threshold = stand_height_m * float(success["torso_z_delta_min_ratio"])
        actual = None if torso_z is None else torso_z - start_torso_z_m
        diagnostics.append(
            _predicate_row(
                name="torso_z_delta_min_ratio",
                expected={
                    ">=": threshold,
                    "ratio_of_stand_height": float(success["torso_z_delta_min_ratio"]),
                },
                actual=actual,
                unmet=actual is None or actual < threshold,
            )
        )

    if "delta_x_m_min" in success:
        threshold = float(success["delta_x_m_min"])
        diagnostics.append(
            _predicate_row(
                name="delta_x_m_min",
                expected={">=": threshold, "within_window_s": window_s},
                actual=delta_x,
                unmet=delta_x is None or delta_x < threshold or not within_window,
                observed_extreme={"max": _safe_max(traces["delta_x"])},
            )
        )
    if "delta_x_m_max" in success:
        threshold = float(success["delta_x_m_max"])
        diagnostics.append(
            _predicate_row(
                name="delta_x_m_max",
                expected={"<=": threshold, "within_window_s": window_s},
                actual=delta_x,
                unmet=delta_x is None or delta_x > threshold or not within_window,
                observed_extreme={"min": _safe_min(traces["delta_x"])},
            )
        )
    if "delta_y_m_min" in success:
        threshold = float(success["delta_y_m_min"])
        diagnostics.append(
            _predicate_row(
                name="delta_y_m_min",
                expected={">=": threshold, "within_window_s": window_s},
                actual=delta_y,
                unmet=delta_y is None or delta_y < threshold or not within_window,
                observed_extreme={"max": _safe_max(traces["delta_y"])},
            )
        )
    if "delta_y_m_max" in success:
        threshold = float(success["delta_y_m_max"])
        diagnostics.append(
            _predicate_row(
                name="delta_y_m_max",
                expected={"<=": threshold, "within_window_s": window_s},
                actual=delta_y,
                unmet=delta_y is None or delta_y > threshold or not within_window,
                observed_extreme={"min": _safe_min(traces["delta_y"])},
            )
        )
    if "max_abs_delta_x_m" in success:
        limit = float(success["max_abs_delta_x_m"])
        actual = None if delta_x is None else abs(delta_x)
        diagnostics.append(
            _predicate_row(
                name="max_abs_delta_x_m",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
                observed_extreme={"max_abs": _safe_max_abs(traces["delta_x"])},
            )
        )
    if "max_abs_delta_y_m" in success:
        limit = float(success["max_abs_delta_y_m"])
        actual = None if delta_y is None else abs(delta_y)
        diagnostics.append(
            _predicate_row(
                name="max_abs_delta_y_m",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
                observed_extreme={"max_abs": _safe_max_abs(traces["delta_y"])},
            )
        )
    if "max_lateral_drift_m" in success:
        limit = float(success["max_lateral_drift_m"])
        actual = None if delta_y is None else abs(delta_y)
        diagnostics.append(
            _predicate_row(
                name="max_lateral_drift_m",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
                observed_extreme={"max_abs_delta_y_m": _safe_max_abs(traces["delta_y"])},
            )
        )
    if "max_forward_drift_m" in success:
        limit = float(success["max_forward_drift_m"])
        actual = None if delta_x is None else abs(delta_x)
        diagnostics.append(
            _predicate_row(
                name="max_forward_drift_m",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
                observed_extreme={"max_abs_delta_x_m": _safe_max_abs(traces["delta_x"])},
            )
        )
    if "max_translation_drift_m" in success:
        limit = float(success["max_translation_drift_m"])
        actual = None if delta_x is None or delta_y is None else math.hypot(delta_x, delta_y)
        observed = [
            math.hypot(dx, dy)
            for dx, dy in zip(traces["delta_x"], traces["delta_y"], strict=False)
        ]
        diagnostics.append(
            _predicate_row(
                name="max_translation_drift_m",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
                observed_extreme={"max": _safe_max(observed)},
            )
        )
    if "delta_yaw_rad_min" in success:
        threshold = float(success["delta_yaw_rad_min"])
        actual = None if delta_yaw is None else _wrap_pi(delta_yaw)
        diagnostics.append(
            _predicate_row(
                name="delta_yaw_rad_min",
                expected={">=": threshold, "within_window_s": window_s},
                actual=actual,
                unmet=actual is None or actual < threshold or not within_window,
                observed_extreme={"max": _safe_max(traces["delta_yaw"])},
            )
        )
    if "delta_yaw_rad_max" in success:
        threshold = float(success["delta_yaw_rad_max"])
        actual = None if delta_yaw is None else _wrap_pi(delta_yaw)
        diagnostics.append(
            _predicate_row(
                name="delta_yaw_rad_max",
                expected={"<=": threshold, "within_window_s": window_s},
                actual=actual,
                unmet=actual is None or actual > threshold or not within_window,
                observed_extreme={"min": _safe_min(traces["delta_yaw"])},
            )
        )
    if "abs_delta_yaw_rad_min" in success:
        threshold = float(success["abs_delta_yaw_rad_min"])
        actual = None if delta_yaw is None else abs(_wrap_pi(delta_yaw))
        diagnostics.append(
            _predicate_row(
                name="abs_delta_yaw_rad_min",
                expected={">=": threshold, "within_window_s": window_s},
                actual=actual,
                unmet=actual is None or actual < threshold or not within_window,
                observed_extreme={"max_abs": _safe_max_abs(traces["delta_yaw"])},
            )
        )
    if "max_abs_delta_yaw_rad" in success:
        limit = float(success["max_abs_delta_yaw_rad"])
        actual = None if delta_yaw is None else abs(_wrap_pi(delta_yaw))
        diagnostics.append(
            _predicate_row(
                name="max_abs_delta_yaw_rad",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
                observed_extreme={"max_abs": _safe_max_abs(traces["delta_yaw"])},
            )
        )
    if success.get("no_fall") is True:
        fell = bool(final_info.get("terminated", False))
        diagnostics.append(
            _predicate_row(
                name="no_fall",
                expected=True,
                actual=not fell,
                unmet=fell,
            )
        )
    return diagnostics


def _deterministic_action(env: TextConditionedProfileEnv, task_id: str, step: int) -> np.ndarray:
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    if task_id == "stand_up":
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            if "hip_pitch" in joint.name:
                action[idx] = -1.0
            elif "knee" in joint.name:
                action[idx] = 1.0
            elif "ank_pitch" in joint.name:
                action[idx] = -1.0
        return action
    phase = 1.0 if (step // 12) % 2 == 0 else -1.0
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        side = -1.0 if name.startswith("l_") else 1.0
        if task_id in {"walk_forward", "walk_backward"}:
            direction = 1.0 if task_id == "walk_forward" else -1.0
            if "hip_pitch" in name:
                action[idx] = 0.7 * phase * side * direction
            elif "knee" in name:
                action[idx] = -0.5 * phase * side
            elif "ank_pitch" in name:
                action[idx] = 0.35 * phase * side * direction
        elif task_id in {"sidestep_left", "sidestep_right"}:
            direction = 1.0 if task_id == "sidestep_left" else -1.0
            if "hip_roll" in name or "ank_roll" in name:
                action[idx] = 0.6 * direction * phase
        elif task_id in {"turn_left", "turn_right"}:
            direction = 1.0 if task_id == "turn_left" else -1.0
            if "hip_yaw" in name:
                action[idx] = 0.7 * direction
            elif "hip_pitch" in name:
                action[idx] = 0.4 * phase * side
            elif "knee" in name:
                action[idx] = -0.3 * phase * side
        elif task_id == "sit_down":
            if "hip_pitch" in name:
                action[idx] = -1.0
            elif "knee" in name or "ank_pitch" in name:
                action[idx] = 1.0
    return action


def _controller_command(task_id: str) -> tuple[float, float, float] | None:
    if task_id == "walk_forward":
        return (0.20, 0.0, 0.0)
    if task_id == "walk_backward":
        return (-0.16, 0.0, 0.0)
    if task_id == "sidestep_left":
        return (0.0, 0.14, 0.0)
    if task_id == "sidestep_right":
        return (0.0, -0.14, 0.0)
    if task_id == "turn_left":
        return (0.0, 0.0, 0.55)
    if task_id == "turn_right":
        return (0.0, 0.0, -0.55)
    return None


def _target_pose_to_env_action(
    env: TextConditionedProfileEnv,
    target_by_name: dict[str, float],
) -> np.ndarray:
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    scale = float(env.config.action_scale)
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        target = target_by_name.get(joint.name)
        if target is None:
            continue
        action[idx] = float((target - env._home_pose[idx]) / scale)  # noqa: SLF001
    return np.clip(action, -1.0, 1.0).astype(np.float32)


def _bezier_action(
    env: TextConditionedProfileEnv,
    controller: BezierGaitController,
    task_id: str,
) -> np.ndarray | None:
    command = _controller_command(task_id)
    if command is None:
        return None
    target = controller.step(*command, dt=env.config.control_dt_s)
    joints_by_index = {
        int(joint.index): joint.name
        for joint in env.profile.kinematics.joints
    }
    target_by_name = {
        joints_by_index[index]: float(value)
        for index, value in enumerate(target)
        if index in joints_by_index
    }
    return _target_pose_to_env_action(env, target_by_name)


def _make_deterministic_action(
    env: TextConditionedProfileEnv,
    task_id: str,
) -> Callable[[int], np.ndarray | None]:
    return partial(_deterministic_action, env, task_id)


def _make_bezier_action(
    env: TextConditionedProfileEnv,
    task_id: str,
    *,
    profile_controller: bool,
    swing_height: float = 0.06,
    cycle_hz: float = 2.0,
    stance_width: float = 0.08,
    foot_offset: float = 0.0,
) -> Callable[[int], np.ndarray | None]:
    if profile_controller:
        controller = BezierGaitController(profile=env.profile)
    else:
        controller = BezierGaitController(
            swing_height=swing_height,
            cycle_hz=cycle_hz,
            stance_width=stance_width,
            foot_offset=foot_offset,
        )

    def _action(_step: int) -> np.ndarray | None:
        return _bezier_action(env, controller, task_id)

    return _action


def _motion_clip_for_task(task_id: str) -> tuple[str, Callable[[np.ndarray], np.ndarray]] | None:
    if task_id == "walk_forward":
        return "walk_forward_clip.npz", lambda joints: joints
    if task_id == "walk_backward":
        def _backward(joints: np.ndarray) -> np.ndarray:
            out = joints.copy()
            out[:, [R_HIP_PITCH, R_ANK_PITCH, L_HIP_PITCH, L_ANK_PITCH]] *= -1.0
            return out

        return "walk_forward_clip.npz", _backward
    if task_id == "turn_left":
        return "turn_left_clip.npz", lambda joints: joints
    if task_id == "turn_right":
        return "turn_left_clip.npz", lambda joints: -joints
    return None


def _make_motion_clip_action(
    env: TextConditionedProfileEnv,
    task_id: str,
) -> Callable[[int], np.ndarray | None]:
    clip_spec = _motion_clip_for_task(task_id)
    if clip_spec is None:
        return lambda _step: None
    clip_name, transform = clip_spec
    clip_path = _MOTION_CLIP_DIR / clip_name
    if not clip_path.is_file():
        return lambda _step: None
    data = np.load(clip_path)
    joints = transform(np.asarray(data["joints"], dtype=np.float64))
    joints_by_index = {int(joint.index): joint.name for joint in env.profile.kinematics.joints}

    def _action(step: int) -> np.ndarray | None:
        target = joints[step % joints.shape[0]]
        target_by_name = {
            joints_by_index[index]: float(value)
            for index, value in enumerate(target)
            if index in joints_by_index
        }
        return _target_pose_to_env_action(env, target_by_name)

    return _action


def _primitive_specs(profile_id: str, task_id: str) -> list[_PrimitiveSpec]:
    specs = [
        _PrimitiveSpec("deterministic_smoke", 0.3, _make_deterministic_action),
    ]
    if profile_id == "hiwonder-ainex" and _controller_command(task_id) is not None:
        specs.extend(
            [
                _PrimitiveSpec("deterministic_wide", 1.0, _make_deterministic_action),
                _PrimitiveSpec(
                    "bezier_profile",
                    0.6,
                    partial(_make_bezier_action, profile_controller=True),
                ),
                _PrimitiveSpec(
                    "bezier_trimmed",
                    1.0,
                    partial(_make_bezier_action, profile_controller=False),
                ),
            ]
        )
        if _motion_clip_for_task(task_id) is not None:
            specs.append(_PrimitiveSpec("motion_clip", 1.0, _make_motion_clip_action))
    return specs


def _progress_ratio(success: dict, traces: dict[str, list[float]]) -> float:
    ratios: list[float] = []
    if "delta_x_m_min" in success:
        target = float(success["delta_x_m_min"])
        observed = _safe_max(traces["delta_x"])
        if observed is not None and target > 0.0:
            ratios.append(observed / target)
    if "delta_x_m_max" in success:
        target = abs(float(success["delta_x_m_max"]))
        observed = _safe_min(traces["delta_x"])
        if observed is not None and target > 0.0:
            ratios.append(abs(min(0.0, observed)) / target)
    if "delta_y_m_min" in success:
        target = float(success["delta_y_m_min"])
        observed = _safe_max(traces["delta_y"])
        if observed is not None and target > 0.0:
            ratios.append(observed / target)
    if "delta_y_m_max" in success:
        target = abs(float(success["delta_y_m_max"]))
        observed = _safe_min(traces["delta_y"])
        if observed is not None and target > 0.0:
            ratios.append(abs(min(0.0, observed)) / target)
    if "delta_yaw_rad_min" in success:
        target = float(success["delta_yaw_rad_min"])
        observed = _safe_max(traces["delta_yaw"])
        if observed is not None and target > 0.0:
            ratios.append(observed / target)
    if "delta_yaw_rad_max" in success:
        target = abs(float(success["delta_yaw_rad_max"]))
        observed = _safe_min(traces["delta_yaw"])
        if observed is not None and target > 0.0:
            ratios.append(abs(min(0.0, observed)) / target)
    return float(max(0.0, min(max(ratios), 1.5))) if ratios else 0.0


def _rollout_candidate(
    profile: str,
    task_id: str,
    *,
    max_steps: int,
    primitive: _PrimitiveSpec,
) -> dict:
    env = TextConditionedProfileEnv(
        profile,
        ProfileEnvConfig(
            include_tasks=(task_id,),
            exclude_tasks=(),
            episode_steps=max_steps,
            domain_rand=False,
            action_scale=primitive.action_scale,
        ),
    )
    env.reset(seed=0)
    task = load_curriculum().by_id(task_id)
    checker = GoalChecker(task, episode_start_t_s=0.0)
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=env._episode_start_x,  # noqa: SLF001
            torso_y_m=env._episode_start_y,  # noqa: SLF001
            torso_z_m=env._episode_start_torso_z,  # noqa: SLF001
            yaw_rad=env._episode_start_yaw,  # noqa: SLF001
            extra={"stand_height_m": env._stand_height_m},  # noqa: SLF001
        )
    )
    traces = {"torso_z": [], "delta_x": [], "delta_y": [], "delta_yaw": []}
    result = None
    last_info: dict = {}
    terminated = False
    truncated = False
    action_for_step = primitive.factory(env, task_id)
    for step in range(max_steps):
        action = action_for_step(step)
        if action is None:
            action = _deterministic_action(env, task_id, step)
        _, _, terminated, truncated, last_info = env.step(action)
        last_info["terminated"] = terminated
        last_info["truncated"] = truncated
        for key in traces:
            value = _finite_or_none(last_info.get(key))
            if value is not None:
                traces[key].append(value)
        result = checker.update(_sample((step + 1) * env.config.control_dt_s, last_info))
        if result.success or result.failed or terminated or truncated:
            break
    if result is None:
        raise RuntimeError("rollout produced no result")
    elapsed_s = len(traces["torso_z"]) * env.config.control_dt_s
    termination_reason = _termination_reason(
        last_info,
        terminated=terminated,
        truncated=truncated,
    )
    success_predicates = _success_predicate_diagnostics(
        success=task.success,
        final_info=last_info,
        traces=traces,
        start_torso_z_m=float(env._episode_start_torso_z),  # noqa: SLF001
        stand_height_m=float(env._stand_height_m),  # noqa: SLF001
        elapsed_s=elapsed_s,
    )
    diagnostics = {
        "controller": primitive.name,
        "action_scale": primitive.action_scale,
        "termination_reason": termination_reason,
        "torso_z_m": {
            "min": _safe_min(traces["torso_z"]),
            "max": _safe_max(traces["torso_z"]),
            "final": _finite_or_none(last_info.get("torso_z")),
        },
        "delta_x_m": {
            "final": _finite_or_none(last_info.get("delta_x")),
            "max_abs": _safe_max_abs(traces["delta_x"]),
            "min": _safe_min(traces["delta_x"]),
            "max": _safe_max(traces["delta_x"]),
        },
        "delta_y_m": {
            "final": _finite_or_none(last_info.get("delta_y")),
            "max_abs": _safe_max_abs(traces["delta_y"]),
            "min": _safe_min(traces["delta_y"]),
            "max": _safe_max(traces["delta_y"]),
        },
        "delta_yaw_rad": {
            "final": _finite_or_none(last_info.get("delta_yaw")),
            "max_abs": _safe_max_abs(traces["delta_yaw"]),
            "min": _safe_min(traces["delta_yaw"]),
            "max": _safe_max(traces["delta_yaw"]),
        },
        "success_predicates": success_predicates,
        "unmet_success_predicates": [
            row["predicate"] for row in success_predicates if row["unmet"]
        ],
        "progress_ratio": _progress_ratio(task.success, traces),
    }
    score = _candidate_score(
        success=bool(result.success),
        failed=bool(result.failed),
        terminated=bool(terminated),
        progress_ratio=float(diagnostics["progress_ratio"]),
        unmet_count=len(diagnostics["unmet_success_predicates"]),
    )
    return {
        "task_id": task_id,
        "controller": diagnostics["controller"],
        "action_scale": primitive.action_scale,
        "success": bool(result.success),
        "failed": bool(result.failed),
        "reason": result.reason,
        "steps": len(traces["torso_z"]),
        "terminated": bool(terminated),
        "truncated": bool(truncated),
        "termination_reason": termination_reason,
        "start_torso_z_m": float(env._episode_start_torso_z),  # noqa: SLF001
        "stand_height_m": float(env._stand_height_m),  # noqa: SLF001
        "final_torso_z_m": _finite_or_none(last_info.get("torso_z")),
        "min_torso_z_m": _safe_min(traces["torso_z"]),
        "max_torso_z_m": max(traces["torso_z"]) if traces["torso_z"] else None,
        "final_delta_x_m": _finite_or_none(last_info.get("delta_x")),
        "final_delta_y_m": _finite_or_none(last_info.get("delta_y")),
        "final_delta_yaw_rad": _finite_or_none(last_info.get("delta_yaw")),
        "max_abs_delta_x_m": _safe_max_abs(traces["delta_x"]),
        "max_abs_delta_y_m": _safe_max_abs(traces["delta_y"]),
        "max_abs_delta_yaw_rad": _safe_max_abs(traces["delta_yaw"]),
        "progress_ratio": diagnostics["progress_ratio"],
        "candidate_score": score,
        "diagnostics": diagnostics,
    }


def _candidate_score(
    *,
    success: bool,
    failed: bool,
    terminated: bool,
    progress_ratio: float,
    unmet_count: int,
) -> float:
    score = progress_ratio - 0.35 * unmet_count
    if success:
        score += 100.0
    if failed:
        score -= 1.0
    if terminated:
        score -= 0.5
    return float(score)


def _candidate_summary(row: dict) -> dict:
    return {
        "controller": row["controller"],
        "action_scale": row.get("action_scale"),
        "success": row["success"],
        "failed": row["failed"],
        "terminated": row["terminated"],
        "termination_reason": row["termination_reason"],
        "steps": row["steps"],
        "final_torso_z_m": row["final_torso_z_m"],
        "final_delta_x_m": row["final_delta_x_m"],
        "final_delta_y_m": row["final_delta_y_m"],
        "final_delta_yaw_rad": row["final_delta_yaw_rad"],
        "progress_ratio": row["progress_ratio"],
        "unmet_success_predicates": row["diagnostics"]["unmet_success_predicates"],
        "candidate_score": row["candidate_score"],
    }


def _rollout(profile: str, task_id: str, *, max_steps: int) -> dict:
    candidates = [
        _rollout_candidate(profile, task_id, max_steps=max_steps, primitive=primitive)
        for primitive in _primitive_specs(profile, task_id)
    ]
    best = max(candidates, key=lambda row: row["candidate_score"])
    best = dict(best)
    best["candidate_results"] = [_candidate_summary(row) for row in candidates]
    best["diagnostics"] = dict(best["diagnostics"])
    best["diagnostics"]["candidate_results"] = best["candidate_results"]
    return best


def validate(profile: str, tasks: tuple[str, ...], *, max_steps: int) -> dict:
    rows = [_rollout(profile, task, max_steps=max_steps) for task in tasks]
    return {
        "schema": "robot-task-feasibility-v1",
        "profile_id": profile,
        "controller": "bezier_gait_for_hiwonder_locomotion_else_deterministic_smoke",
        "max_steps": max_steps,
        "tasks": rows,
        "n_tasks": len(rows),
        "n_success": sum(1 for row in rows if row["success"]),
        "all_success": all(row["success"] for row in rows),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="hiwonder-ainex")
    parser.add_argument("--tasks", nargs="+", default=list(DEFAULT_TASKS))
    parser.add_argument("--max-steps", type=int, default=500)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    report = validate(args.profile, tuple(args.tasks), max_steps=args.max_steps)
    text = json.dumps(report, indent=2)
    print(text)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    return 0 if report["all_success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
