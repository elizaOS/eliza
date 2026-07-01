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
from collections import Counter
from dataclasses import replace
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np

from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample
from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.loop import evaluate, train_online

DEFAULT_ACTION_SCALE_INITIAL = 0.15
DEFAULT_LOCOMOTION_PRIOR_ACTION_SCALE_INITIAL = 0.28
DEFAULT_LOCOMOTION_PRIOR_RESIDUAL_SCALE_INITIAL = 0.0
DEFAULT_LOCOMOTION_PRIOR_RESIDUAL_SCALE_INCREMENT = 0.01
DEFAULT_ACTION_SCALE_INCREMENT = 0.05
DEFAULT_PHASE_EVAL_INTERVAL_STEPS = 50_000
DEFAULT_HIWONDER_SINE_FEEDBACK = {
    "pitch": 2.0,
    "roll": -1.5,
    "yaw": 0.25,
}
ACTION_SCALE_SCHEDULE_SCHEMA = "alberta-action-scale-schedule-v1"
LOCOMOTION_PRIOR_RESIDUAL_SCHEDULE_SCHEMA = "alberta-locomotion-prior-residual-schedule-v1"


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


def _float_stats(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"min": None, "max": None, "mean": None, "final": None}
    return {
        "min": float(np.min(values)),
        "max": float(np.max(values)),
        "mean": float(np.mean(values)),
        "final": float(values[-1]),
    }


def _build_action_scale_schedule(
    *,
    target_scale: float,
    initial_scale: float | None,
    increment: float,
    min_success_rate: float,
    allow_stable_partial_progress: bool = True,
    allow_safe_locomotion_prior_scale: bool = False,
) -> dict:
    target = float(target_scale)
    initial = DEFAULT_ACTION_SCALE_INITIAL if initial_scale is None else float(initial_scale)
    step = float(increment)
    if not np.isfinite(target) or target <= 0.0:
        raise ValueError("action_scale must be finite and > 0")
    if not np.isfinite(initial) or initial <= 0.0:
        raise ValueError("action_scale_initial must be finite and > 0")
    if not np.isfinite(step) or step <= 0.0:
        raise ValueError("action_scale_increment must be finite and > 0")
    if initial > target:
        raise ValueError("action_scale_initial must be <= action_scale")
    if allow_stable_partial_progress:
        mode = "no_fall_physical_gate_ramp"
    elif allow_safe_locomotion_prior_scale:
        mode = "safe_locomotion_prior_gate_ramp"
    else:
        mode = "full_physical_success_gate_ramp"
    criteria = {
        "failure_rate_lte": 0.0,
        "success_rate_gte": float(min_success_rate),
    }
    if allow_stable_partial_progress:
        criteria["physical_success_or_stable_partial_progress"] = True
    elif allow_safe_locomotion_prior_scale:
        criteria["physical_success_or_safe_locomotion_prior_scale"] = True
    else:
        criteria["physical_success"] = True
    if allow_stable_partial_progress:
        rationale = (
            "start at a stable small action scale, then ramp after either "
            "full GoalChecker physical success or no-fall partial directional "
            "progress with drift checks still passing"
        )
    elif allow_safe_locomotion_prior_scale:
        rationale = (
            "start prior-assisted locomotion at a stable gait amplitude, then "
            "ramp action scale after eval episodes prove no fall, no support "
            "contract failure, valid tracked height, and yaw/drift/slip/"
            "self-collision checks still passing; promotion and residual "
            "authority remain stricter"
        )
    else:
        rationale = (
            "start at a stable small action scale, then ramp only after "
            "full GoalChecker physical success"
        )
    return {
        "schema": ACTION_SCALE_SCHEDULE_SCHEMA,
        "mode": mode,
        "enabled": initial < target,
        "initial_scale": initial,
        "target_scale": target,
        "increment": min(step, target),
        "criteria": criteria,
        "rationale": rationale,
    }


def _build_locomotion_prior_residual_schedule(
    *,
    target_scale: float,
    initial_scale: float | None,
    increment: float,
    locomotion_action_prior: str,
) -> dict:
    target = float(target_scale)
    initial = (
        min(target, DEFAULT_LOCOMOTION_PRIOR_RESIDUAL_SCALE_INITIAL)
        if initial_scale is None
        else float(initial_scale)
    )
    step = float(increment)
    if not np.isfinite(target) or target < 0.0:
        raise ValueError("locomotion_prior_residual_scale must be finite and >= 0")
    if not np.isfinite(initial) or initial < 0.0:
        raise ValueError("locomotion_prior_residual_scale_initial must be finite and >= 0")
    if not np.isfinite(step) or step <= 0.0:
        raise ValueError("locomotion_prior_residual_scale_increment must be finite and > 0")
    if initial > target:
        raise ValueError(
            "locomotion_prior_residual_scale_initial must be <= "
            "locomotion_prior_residual_scale"
        )
    enabled = locomotion_action_prior != "none" and initial < target
    return {
        "schema": LOCOMOTION_PRIOR_RESIDUAL_SCHEDULE_SCHEMA,
        "mode": "stable_partial_progress_gate_ramp",
        "enabled": enabled,
        "initial_scale": initial,
        "target_scale": target,
        "increment": min(step, target) if target > 0.0 else step,
        "criteria": {
            "failure_rate_lte": 0.0,
            "physical_success_or_stable_partial_progress": True,
        },
        "rationale": (
            "when using a locomotion prior, start with no residual override so "
            "the robot first demonstrates stable supported motion, then admit "
            "learned residual control after either full GoalChecker physical "
            "success or stable partial progress; actor updates are scaled by "
            "current residual authority so the residual policy only learns while "
            "its actions are causal"
        ),
    }


def _initial_action_scale_for_training(
    *,
    target_scale: float,
    requested_initial_scale: float | None,
    locomotion_action_prior: str,
) -> float | None:
    if requested_initial_scale is not None:
        return requested_initial_scale
    if locomotion_action_prior != "none":
        return min(float(target_scale), DEFAULT_LOCOMOTION_PRIOR_ACTION_SCALE_INITIAL)
    return None


def _resolve_locomotion_prior_feedback(
    *,
    locomotion_action_prior: str,
    pitch: float | None,
    roll: float | None,
    yaw: float | None,
) -> tuple[float, float, float]:
    if locomotion_action_prior == "hiwonder_sine":
        return (
            float(DEFAULT_HIWONDER_SINE_FEEDBACK["pitch"] if pitch is None else pitch),
            float(DEFAULT_HIWONDER_SINE_FEEDBACK["roll"] if roll is None else roll),
            float(DEFAULT_HIWONDER_SINE_FEEDBACK["yaw"] if yaw is None else yaw),
        )
    return (
        float(0.0 if pitch is None else pitch),
        float(0.0 if roll is None else roll),
        float(0.0 if yaw is None else yaw),
    )


def _parse_hidden_sizes(value: str | tuple[int, ...] | list[int]) -> tuple[int, ...]:
    if isinstance(value, str):
        parts = [part.strip() for part in value.replace("x", ",").split(",")]
        sizes = tuple(int(part) for part in parts if part)
    else:
        sizes = tuple(int(part) for part in value)
    if not sizes or any(size <= 0 for size in sizes):
        raise ValueError("hidden sizes must contain positive integers")
    return sizes


def _controller_manifest(
    *,
    controller_type: str,
    linear_cfg: AlbertaControllerConfig | None,
    feature_cfg: FeatureConfig | None,
    cbp_cfg,
) -> dict:
    if controller_type == "linear":
        if linear_cfg is None or feature_cfg is None:
            raise ValueError("linear controller manifest requires linear config")
        return {
            "type": "linear_stream_ac_v1",
            "gamma": linear_cfg.gamma,
            "actor_step_size": linear_cfg.actor_step_size,
            "critic_step_size": linear_cfg.critic_step_size,
            "actor_lamda": linear_cfg.actor_lamda,
            "critic_lamda": linear_cfg.critic_lamda,
            "log_sigma_init": linear_cfg.log_sigma_init,
            "log_sigma_min": linear_cfg.log_sigma_min,
            "log_sigma_max": linear_cfg.log_sigma_max,
            "action_low": linear_cfg.action_low,
            "action_high": linear_cfg.action_high,
            "obgd_kappa": linear_cfg.obgd_kappa,
            "normalize": linear_cfg.normalize,
            "normalizer_decay": linear_cfg.normalizer_decay,
            "decouple_global_bias": linear_cfg.decouple_global_bias,
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
        }
    if cbp_cfg is None:
        raise ValueError("cbp controller manifest requires cbp config")
    return {
        "type": "cbp_stream_ac_v1",
        "obs_dim": int(cbp_cfg.obs_dim),
        "action_dim": int(cbp_cfg.action_dim),
        "hidden_sizes": list(cbp_cfg.hidden_sizes),
        "gamma": float(cbp_cfg.gamma),
        "actor_step_size": float(cbp_cfg.actor_step_size),
        "critic_step_size": float(cbp_cfg.critic_step_size),
        "actor_lamda": float(cbp_cfg.actor_lamda),
        "critic_lamda": float(cbp_cfg.critic_lamda),
        "log_sigma_init": float(cbp_cfg.log_sigma_init),
        "log_sigma_min": float(cbp_cfg.log_sigma_min),
        "log_sigma_max": float(cbp_cfg.log_sigma_max),
        "learn_log_sigma": bool(cbp_cfg.learn_log_sigma),
        "action_low": float(cbp_cfg.action_low),
        "action_high": float(cbp_cfg.action_high),
        "obgd_kappa": cbp_cfg.obgd_kappa,
        "sparsity": float(cbp_cfg.sparsity),
        "leaky_relu_slope": float(cbp_cfg.leaky_relu_slope),
        "use_layer_norm": bool(cbp_cfg.use_layer_norm),
        "normalize": bool(cbp_cfg.normalize),
        "normalizer_decay": float(cbp_cfg.normalizer_decay),
        "seed": int(cbp_cfg.seed),
        "cbp": {
            "enabled": bool(cbp_cfg.cbp.enabled),
            "decay_rate": float(cbp_cfg.cbp.decay_rate),
            "replacement_rate": float(cbp_cfg.cbp.replacement_rate),
            "maturity_threshold": int(cbp_cfg.cbp.maturity_threshold),
        },
        "retention": {
            "mode": cbp_cfg.retention.mode,
            "n_slots": int(cbp_cfg.retention.n_slots),
            "embed_dim": int(cbp_cfg.retention.embed_dim),
            "trunk_step_scale": float(cbp_cfg.retention.trunk_step_scale),
            "trunk_freeze_after": int(cbp_cfg.retention.trunk_freeze_after),
            "proto_seed": int(cbp_cfg.retention.proto_seed),
        },
    }


def _set_env_action_scale(env, action_scale: float) -> None:
    env.config = replace(env.config, action_scale=float(action_scale))


def _set_env_locomotion_prior_residual_scale(env, residual_scale: float) -> None:
    env.config = replace(
        env.config,
        locomotion_prior_residual_scale=float(residual_scale),
    )


def _uses_staged_biped_prior(task_id: str, staged_biped_action_prior: str) -> bool:
    if staged_biped_action_prior == "none":
        return False
    return task_id in {
        "weight_shift_left",
        "weight_shift_right",
        "lift_left_foot",
        "lift_right_foot",
        "step_in_place",
        "step_forward",
    }


def _effective_locomotion_prior_residual_scale(
    *,
    task_id: str,
    staged_biped_action_prior: str,
    locomotion_action_prior: str = "none",
    current_scale: float,
) -> float:
    if _uses_staged_biped_prior(task_id, staged_biped_action_prior):
        return 0.0
    if (
        task_id in {"walk_forward_bridge", "walk_forward_mid_bridge"}
        and locomotion_action_prior == "hiwonder_bounded_step_walk"
    ):
        return 0.0
    return float(current_scale)


def _starts_final_bounded_walk_with_zero_residual(
    *, task_id: str, locomotion_action_prior: str
) -> bool:
    return task_id == "walk_forward" and locomotion_action_prior == "hiwonder_bounded_step_walk"


def _action_scale_gate_passed(
    promotion_eval: dict,
    *,
    task_id: str,
    min_success_rate: float,
    allow_stable_partial_progress: bool = True,
    allow_safe_locomotion_prior_scale: bool = False,
) -> bool:
    if float(promotion_eval.get("failure_rate", 1.0)) > 0.0:
        return False
    if _promotion_passed(promotion_eval, min_success_rate):
        return True
    if not allow_stable_partial_progress:
        return (
            allow_safe_locomotion_prior_scale
            and _safe_locomotion_prior_scale_gate_passed(
                promotion_eval,
                task_id=task_id,
            )
        )
    return _stable_partial_progress_gate_passed(promotion_eval, task_id=task_id)


def _safe_locomotion_prior_scale_gate_passed(
    promotion_eval: dict,
    *,
    task_id: str,
) -> bool:
    if task_id not in {
        "walk_forward",
        "walk_backward",
        "sidestep_left",
        "sidestep_right",
    }:
        return False
    if float(promotion_eval.get("failure_rate", 1.0)) > 0.0:
        return False
    if float(promotion_eval.get("physical_fall_rate", 0.0) or 0.0) > 0.0:
        return False
    if float(promotion_eval.get("support_contract_failure_rate", 0.0) or 0.0) > 0.0:
        return False
    checks = (
        promotion_eval.get("physical_checks")
        if isinstance(promotion_eval.get("physical_checks"), dict)
        else {}
    )
    if not checks:
        return False
    required_true = [
        "tracked_height_present",
        "no_fall",
        "yaw_drift_bound",
        "max_foot_slip_m_s",
        "max_self_collision_count",
    ]
    if task_id in {"walk_forward", "walk_backward"}:
        required_true.append("tracked_lateral_drift_bound")
    else:
        required_true.append("tracked_forward_drift_bound")
    return all(checks.get(key) is True for key in required_true)


def _scale_gate_reason(
    promotion_eval: dict,
    *,
    task_id: str,
    min_success_rate: float,
    allow_safe_locomotion_prior_scale: bool = False,
) -> str:
    if _promotion_passed(promotion_eval, min_success_rate):
        return "full_physical_success_gate_passed"
    if _stable_partial_progress_gate_passed(promotion_eval, task_id=task_id):
        return "stable_partial_progress_gate_passed"
    if allow_safe_locomotion_prior_scale and _safe_locomotion_prior_scale_gate_passed(
        promotion_eval,
        task_id=task_id,
    ):
        return "safe_locomotion_prior_scale_gate_passed"
    return "unknown_gate_passed"


def _stable_partial_progress_gate_passed(promotion_eval: dict, *, task_id: str) -> bool:
    checks = (
        promotion_eval.get("physical_checks")
        if isinstance(promotion_eval.get("physical_checks"), dict)
        else {}
    )
    if checks.get("no_fall") is False:
        return False
    task_success = {
        task.id: task.success for task in load_curriculum().tasks
    }.get(task_id, {})
    if (
        "min_alternating_foot_contacts" in task_success
        and checks.get("min_alternating_foot_contacts") is not True
    ):
        return False
    for key in (
        "tracked_lateral_drift_bound",
        "tracked_forward_drift_bound",
        "yaw_drift_bound",
        "tracked_translation_drift_bound",
    ):
        if key in checks and checks[key] is not True:
            return False
    summary = (
        promotion_eval.get("movement_summary")
        if isinstance(promotion_eval.get("movement_summary"), dict)
        else {}
    )

    def _stat(series: str, key: str) -> float | None:
        values = summary.get(series)
        if not isinstance(values, dict):
            return None
        return _optional_float(values.get(key))

    if task_id == "walk_forward":
        value = _stat("tracked_delta_x_m", "max")
        return value is not None and value >= 0.05
    if task_id == "walk_backward":
        value = _stat("tracked_delta_x_m", "min")
        return value is not None and value <= -0.04
    if task_id == "sidestep_left":
        value = _stat("tracked_delta_y_m", "max")
        return value is not None and value >= 0.04
    if task_id == "sidestep_right":
        value = _stat("tracked_delta_y_m", "min")
        return value is not None and value <= -0.04
    return False


def _bounded_step_walk_final_residual_gate_passed(
    promotion_eval: dict,
    *,
    task_id: str,
) -> bool:
    """Admit final walk residuals only after a stable near-target prior.

    The bounded-step prior is already a strong causal controller for the final
    walk. Letting residuals ramp on generic 5 cm partial progress can degrade
    that prior before the residual policy has earned meaningful authority. This
    gate keeps residual learning available, but only once the prior is close to
    the final displacement target and the physical side constraints are clean.
    """
    if task_id != "walk_forward":
        return _stable_partial_progress_gate_passed(promotion_eval, task_id=task_id)
    if float(promotion_eval.get("failure_rate", 1.0)) > 0.0:
        return False
    if float(promotion_eval.get("physical_fall_rate", 0.0) or 0.0) > 0.0:
        return False
    if float(promotion_eval.get("support_contract_failure_rate", 0.0) or 0.0) > 0.0:
        return False
    checks = (
        promotion_eval.get("physical_checks")
        if isinstance(promotion_eval.get("physical_checks"), dict)
        else {}
    )
    required_checks = (
        "tracked_height_present",
        "no_fall",
        "tracked_lateral_drift_bound",
        "yaw_drift_bound",
        "min_alternating_foot_contacts",
        "min_swing_foot_clearance_m",
        "max_foot_slip_m_s",
        "max_self_collision_count",
    )
    if any(checks.get(key) is not True for key in required_checks):
        return False

    summary = (
        promotion_eval.get("movement_summary")
        if isinstance(promotion_eval.get("movement_summary"), dict)
        else {}
    )
    tracked_dx = summary.get("tracked_delta_x_m")
    if not isinstance(tracked_dx, dict):
        return False
    max_dx = _optional_float(tracked_dx.get("max"))
    if max_dx is None:
        return False
    task_success = {
        task.id: task.success for task in load_curriculum().tasks
    }.get(task_id, {})
    final_target = _optional_float(task_success.get("delta_x_m_min")) or 0.30
    return max_dx + 1e-9 >= 0.90 * final_target


def _physical_checks(task_id: str, summary: dict[str, dict[str, float | None]]) -> dict[str, bool]:
    def stat(series: str, key: str) -> float | None:
        values = summary.get(series)
        if not isinstance(values, dict):
            return None
        value = values.get(key)
        if isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if np.isfinite(number) else None

    min_x = stat("tracked_delta_x_m", "min")
    max_x = stat("tracked_delta_x_m", "max")
    min_y = stat("tracked_delta_y_m", "min")
    max_y = stat("tracked_delta_y_m", "max")
    min_yaw = stat("delta_yaw_rad", "min")
    max_yaw = stat("delta_yaw_rad", "max")
    observed_max_abs_yaw = stat("max_abs_delta_yaw_rad", "max")
    max_abs_yaw = max(abs(v) for v in (min_yaw, max_yaw) if v is not None) if (
        min_yaw is not None or max_yaw is not None
    ) else None
    if observed_max_abs_yaw is not None:
        max_abs_yaw = max(
            observed_max_abs_yaw,
            max_abs_yaw if max_abs_yaw is not None else 0.0,
        )
    min_tracked_z = stat("tracked_z_m", "min")
    min_tracked_dz = stat("tracked_delta_z_m", "min")
    max_translation = stat("tracked_translation_drift_m", "max")
    max_swing_clearance = stat("max_swing_foot_clearance_m", "max")
    max_foot_slip = stat("max_foot_slip_m_s", "max")
    max_self_collision = stat("max_self_collision_count", "max")
    checks: dict[str, bool] = {
        "tracked_height_present": min_tracked_z is not None and min_tracked_z > 0.0,
    }
    if task_id == "stand_up":
        checks["torso_height_gain"] = min_tracked_dz is not None and min_tracked_dz >= 0.02
        checks["tracked_height_gain"] = min_tracked_dz is not None and min_tracked_dz >= 0.02
    elif task_id == "walk_forward":
        checks["tracked_delta_x_forward"] = max_x is not None and max_x >= 0.30
        checks["tracked_lateral_drift_bound"] = max_y is not None and min_y is not None and max(abs(max_y), abs(min_y)) <= 0.20
        checks["yaw_drift_bound"] = max_abs_yaw is not None and max_abs_yaw <= 0.40
    elif task_id == "walk_backward":
        checks["tracked_delta_x_backward"] = min_x is not None and min_x <= -0.20
        checks["tracked_lateral_drift_bound"] = max_y is not None and min_y is not None and max(abs(max_y), abs(min_y)) <= 0.20
        checks["yaw_drift_bound"] = max_abs_yaw is not None and max_abs_yaw <= 0.40
    elif task_id == "sidestep_left":
        checks["tracked_delta_y_left"] = max_y is not None and max_y >= 0.20
        checks["tracked_forward_drift_bound"] = max_x is not None and min_x is not None and max(abs(max_x), abs(min_x)) <= 0.20
        checks["yaw_drift_bound"] = max_abs_yaw is not None and max_abs_yaw <= 0.40
    elif task_id == "sidestep_right":
        checks["tracked_delta_y_right"] = min_y is not None and min_y <= -0.20
        checks["tracked_forward_drift_bound"] = max_x is not None and min_x is not None and max(abs(max_x), abs(min_x)) <= 0.20
        checks["yaw_drift_bound"] = max_abs_yaw is not None and max_abs_yaw <= 0.40
    elif task_id == "turn_left":
        checks["delta_yaw_left"] = max_yaw is not None and max_yaw >= 0.70
        checks["tracked_translation_drift_bound"] = max_translation is not None and max_translation <= 0.25
    elif task_id == "turn_right":
        checks["delta_yaw_right"] = min_yaw is not None and min_yaw <= -0.70
        checks["tracked_translation_drift_bound"] = max_translation is not None and max_translation <= 0.25
    elif task_id == "turn_around":
        checks["delta_yaw_turn_around"] = max_abs_yaw is not None and max_abs_yaw >= 2.60
        checks["tracked_translation_drift_bound"] = max_translation is not None and max_translation <= 0.35
    if task_id in {
        "walk_forward",
        "walk_backward",
        "sidestep_left",
        "sidestep_right",
    }:
        checks["min_swing_foot_clearance_m"] = (
            max_swing_clearance is not None and max_swing_clearance >= 0.015
        )
        checks["max_foot_slip_m_s"] = (
            max_foot_slip is not None and max_foot_slip <= 0.35
        )
        checks["max_self_collision_count"] = (
            max_self_collision is not None and max_self_collision <= 0.0
        )
    return checks


def _telemetry_sample_from_info(t_s: float, info: dict) -> TelemetrySample:
    return TelemetrySample(
        t_s=t_s,
        torso_x_m=_optional_float(info.get("root_x")),
        torso_y_m=_optional_float(info.get("root_y")),
        torso_z_m=_optional_float(info.get("torso_z")),
        yaw_rad=_optional_float(info.get("root_yaw")),
        imu_roll_rad=float(info.get("imu_roll", 0.0) or 0.0),
        imu_pitch_rad=float(info.get("imu_pitch", 0.0) or 0.0),
        extra={
            "stand_height_m": info.get("stand_height_m"),
            "left_foot_contact": info.get("left_foot_contact"),
            "right_foot_contact": info.get("right_foot_contact"),
            "left_foot_z_m": info.get("left_foot_z"),
            "right_foot_z_m": info.get("right_foot_z"),
            "left_foot_slip_m_s": info.get("left_foot_slip_m_s"),
            "right_foot_slip_m_s": info.get("right_foot_slip_m_s"),
            "max_swing_foot_clearance_m": info.get("max_swing_foot_clearance_m"),
            "max_foot_slip_m_s": info.get("max_foot_slip_m_s"),
            "self_collision_count": info.get("self_collision_count"),
            "root_x_m": info.get("root_x"),
            "root_y_m": info.get("root_y"),
            "torso_z_m": info.get("torso_z"),
            "tracked_x_m": info.get("tracked_x"),
            "tracked_y_m": info.get("tracked_y"),
            "tracked_z_m": info.get("tracked_z"),
        },
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
    physical_falls: list[bool] = []
    support_contract_failures: list[bool] = []
    done_reasons: list[str] = []
    returns: list[float] = []
    lengths: list[int] = []
    reasons: list[str] = []
    final_delta_x: list[float] = []
    final_delta_y: list[float] = []
    final_delta_yaw: list[float] = []
    final_torso_z: list[float] = []
    final_tracked_delta_x: list[float] = []
    final_tracked_delta_y: list[float] = []
    final_tracked_delta_z: list[float] = []
    final_tracked_z: list[float] = []
    tracked_translation_drift: list[float] = []
    max_tracked_delta_x: list[float] = []
    min_tracked_delta_x: list[float] = []
    max_tracked_delta_y: list[float] = []
    min_tracked_delta_y: list[float] = []
    max_abs_delta_yaw: list[float] = []
    final_foot_contact_switches: list[float] = []
    max_swing_foot_clearance: list[float] = []
    max_foot_slip: list[float] = []
    max_self_collision: list[float] = []
    action_l2: list[float] = []
    action_abs_mean: list[float] = []
    action_max_abs: list[float] = []
    effective_action_max_abs: list[float] = []
    locomotion_prior_action_max_abs: list[float] = []
    locomotion_prior_residual_max_abs: list[float] = []
    locomotion_prior_residual_pre_guard_max_abs: list[float] = []
    locomotion_prior_residual_stability_scales: list[float] = []
    locomotion_prior_residual_scales: list[float] = []
    tracked_body_names: list[str] = []
    reward_term_totals: dict[str, list[float]] = {}
    self_collision_count_sum: list[float] = []
    self_collision_active_steps: list[float] = []
    self_collision_pre_fall_max: list[float] = []
    self_collision_terminal_max: list[float] = []
    support_contract_pre_fall_sum: list[float] = []
    support_contract_terminal_sum: list[float] = []
    try:
        for ep in range(max(1, int(episodes))):
            obs, info = env.reset(seed=seed + ep)
            checker = GoalChecker(task, episode_start_t_s=0.0)
            last_result = checker.update(_telemetry_sample_from_info(0.0, info))
            total = 0.0
            episode_reward_terms: dict[str, float] = {}
            episode_tracked_dx = [0.0]
            episode_tracked_dy = [0.0]
            episode_delta_yaw = [0.0]
            episode_self_collision = [
                float(info.get("self_collision_count", 0.0) or 0.0)
            ]
            episode_support_contract_terms: list[float] = []
            steps = 0
            terminated = False
            truncated = False
            while steps < max_episode_steps:
                action = controller.act_greedy(np.asarray(obs, dtype=np.float32))
                action_l2.append(float(np.linalg.norm(action)))
                action_abs_mean.append(float(np.mean(np.abs(action))))
                action_max_abs.append(float(np.max(np.abs(action))))
                obs, reward, terminated, truncated, info = env.step(action)
                effective_action_max_abs.append(
                    float(info.get("effective_action_max_abs", 0.0) or 0.0)
                )
                locomotion_prior_action_max_abs.append(
                    float(info.get("locomotion_prior_action_max_abs", 0.0) or 0.0)
                )
                locomotion_prior_residual_max_abs.append(
                    float(info.get("locomotion_prior_residual_max_abs", 0.0) or 0.0)
                )
                locomotion_prior_residual_pre_guard_max_abs.append(
                    float(
                        info.get(
                            "locomotion_prior_residual_pre_guard_max_abs",
                            0.0,
                        )
                        or 0.0
                    )
                )
                locomotion_prior_residual_stability_scales.append(
                    float(
                        info.get("locomotion_prior_residual_stability_scale", 1.0)
                        or 0.0
                    )
                )
                locomotion_prior_residual_scales.append(
                    float(info.get("locomotion_prior_residual_scale", 0.0) or 0.0)
                )
                total += float(reward)
                reward_terms = info.get("reward_terms")
                support_contract_term = 0.0
                if isinstance(reward_terms, dict):
                    for key, value in reward_terms.items():
                        number = _optional_float(value)
                        if number is not None:
                            episode_reward_terms[key] = (
                                episode_reward_terms.get(key, 0.0) + number
                            )
                            if key == "support_contract":
                                support_contract_term = number
                episode_support_contract_terms.append(support_contract_term)
                steps += 1
                episode_tracked_dx.append(
                    float(info.get("tracked_delta_x", info.get("delta_x", 0.0)) or 0.0)
                )
                episode_tracked_dy.append(
                    float(info.get("tracked_delta_y", info.get("delta_y", 0.0)) or 0.0)
                )
                episode_delta_yaw.append(float(info.get("delta_yaw", 0.0) or 0.0))
                episode_self_collision.append(
                    float(info.get("self_collision_count", 0.0) or 0.0)
                )
                last_result = checker.update(
                    _telemetry_sample_from_info(
                        steps * env.config.control_dt_s,
                        info,
                    )
                )
                if terminated or truncated or last_result.success or last_result.failed:
                    break
            success = bool(last_result.success)
            done_reason = str(info.get("done_reason") or "")
            physical_fall = bool(
                done_reason == "fall" or str(last_result.reason or "").startswith("fall:")
            )
            support_contract_failed = done_reason == "support_contract"
            failed = bool(last_result.failed or (terminated and not success))
            reason = str(last_result.reason or "")
            if failed and not reason:
                reason = (
                    f"env_terminated_before_goal_success:{done_reason}"
                    if done_reason
                    else "env_terminated_before_goal_success"
                )
            successes.append(success)
            failures.append(failed)
            physical_falls.append(physical_fall)
            support_contract_failures.append(support_contract_failed)
            if done_reason:
                done_reasons.append(done_reason)
            returns.append(total)
            lengths.append(steps)
            final_delta_x.append(float(info.get("delta_x", 0.0) or 0.0))
            final_delta_y.append(float(info.get("delta_y", 0.0) or 0.0))
            final_delta_yaw.append(float(info.get("delta_yaw", 0.0) or 0.0))
            final_torso_z.append(float(info.get("torso_z", 0.0) or 0.0))
            tx = float(info.get("tracked_delta_x", info.get("delta_x", 0.0)) or 0.0)
            ty = float(info.get("tracked_delta_y", info.get("delta_y", 0.0)) or 0.0)
            tz = float(info.get("tracked_delta_z", 0.0) or 0.0)
            final_tracked_delta_x.append(tx)
            final_tracked_delta_y.append(ty)
            final_tracked_delta_z.append(tz)
            final_tracked_z.append(float(info.get("tracked_z", info.get("torso_z", 0.0)) or 0.0))
            tracked_translation_drift.append(float(np.hypot(tx, ty)))
            max_tracked_delta_x.append(float(np.max(episode_tracked_dx)))
            min_tracked_delta_x.append(float(np.min(episode_tracked_dx)))
            max_tracked_delta_y.append(float(np.max(episode_tracked_dy)))
            min_tracked_delta_y.append(float(np.min(episode_tracked_dy)))
            max_abs_delta_yaw.append(float(np.max(np.abs(episode_delta_yaw))))
            step_collisions = episode_self_collision[1:]
            terminal_fall = bool(terminated and str(info.get("done_reason") or "") == "fall")
            pre_fall_collisions = step_collisions[:-1] if terminal_fall else step_collisions
            terminal_collisions = step_collisions[-1:] if terminal_fall else []
            pre_fall_support = (
                episode_support_contract_terms[:-1]
                if terminal_fall
                else episode_support_contract_terms
            )
            terminal_support = (
                episode_support_contract_terms[-1:] if terminal_fall else []
            )
            self_collision_count_sum.append(float(np.sum(step_collisions)))
            self_collision_active_steps.append(
                float(np.sum(np.asarray(step_collisions, dtype=np.float32) > 0.0))
            )
            self_collision_pre_fall_max.append(
                float(np.max(pre_fall_collisions)) if pre_fall_collisions else 0.0
            )
            self_collision_terminal_max.append(
                float(np.max(terminal_collisions)) if terminal_collisions else 0.0
            )
            support_contract_pre_fall_sum.append(float(np.sum(pre_fall_support)))
            support_contract_terminal_sum.append(float(np.sum(terminal_support)))
            final_foot_contact_switches.append(
                float(info.get("foot_contact_switch_count", 0.0) or 0.0)
            )
            max_swing_foot_clearance.append(
                float(info.get("max_swing_foot_clearance_m", 0.0) or 0.0)
            )
            max_foot_slip.append(float(info.get("max_foot_slip_m_s", 0.0) or 0.0))
            max_self_collision.append(float(np.max(episode_self_collision)))
            tracked_name = str(info.get("tracked_body_name") or "")
            if tracked_name:
                tracked_body_names.append(tracked_name)
            for key, value in episode_reward_terms.items():
                reward_term_totals.setdefault(key, []).append(value)
            if reason:
                reasons.append(reason)
    finally:
        env.active_tasks = original_tasks
    movement_summary = {
        "delta_x_m": _float_stats(final_delta_x),
        "delta_y_m": _float_stats(final_delta_y),
        "delta_yaw_rad": _float_stats(final_delta_yaw),
        "torso_z_m": _float_stats(final_torso_z),
        "tracked_delta_x_m": _float_stats(final_tracked_delta_x),
        "tracked_delta_y_m": _float_stats(final_tracked_delta_y),
        "tracked_delta_z_m": _float_stats(final_tracked_delta_z),
        "tracked_z_m": _float_stats(final_tracked_z),
        "tracked_translation_drift_m": _float_stats(tracked_translation_drift),
        "max_tracked_delta_x_m": _float_stats(max_tracked_delta_x),
        "min_tracked_delta_x_m": _float_stats(min_tracked_delta_x),
        "max_tracked_delta_y_m": _float_stats(max_tracked_delta_y),
        "min_tracked_delta_y_m": _float_stats(min_tracked_delta_y),
        "max_abs_delta_yaw_rad": _float_stats(max_abs_delta_yaw),
        "foot_contact_switches": _float_stats(final_foot_contact_switches),
        "max_swing_foot_clearance_m": _float_stats(max_swing_foot_clearance),
        "max_foot_slip_m_s": _float_stats(max_foot_slip),
        "max_self_collision_count": _float_stats(max_self_collision),
    }
    physical_checks = _physical_checks(task.id, movement_summary)
    success_rate = float(np.mean(successes)) if successes else 0.0
    failure_rate = float(np.mean(failures)) if failures else 0.0
    physical_fall_rate = float(np.mean(physical_falls)) if physical_falls else 0.0
    support_contract_failure_rate = (
        float(np.mean(support_contract_failures)) if support_contract_failures else 0.0
    )
    if task.success.get("no_fall") is True:
        physical_checks["no_fall"] = physical_fall_rate <= 0.0
    if "hold_s" in task.success:
        physical_checks["hold_s"] = success_rate >= 1.0
    if "min_alternating_foot_contacts" in task.success:
        min_switches = float(task.success["min_alternating_foot_contacts"])
        observed_min = movement_summary["foot_contact_switches"]["min"]
        physical_checks["min_alternating_foot_contacts"] = (
            observed_min is not None and observed_min >= min_switches
        )
    if "min_swing_foot_clearance_m" in task.success:
        required_clearance = float(task.success["min_swing_foot_clearance_m"])
        observed_max = movement_summary["max_swing_foot_clearance_m"]["max"]
        physical_checks["min_swing_foot_clearance_m"] = (
            observed_max is not None and observed_max >= required_clearance
        )
    if "max_foot_slip_m_s" in task.success:
        slip_limit = float(task.success["max_foot_slip_m_s"])
        observed_max = movement_summary["max_foot_slip_m_s"]["max"]
        physical_checks["max_foot_slip_m_s"] = (
            observed_max is not None and observed_max <= slip_limit
        )
    if "max_self_collision_count" in task.success:
        collision_limit = float(task.success["max_self_collision_count"])
        observed_max = movement_summary["max_self_collision_count"]["max"]
        physical_checks["max_self_collision_count"] = (
            observed_max is not None and observed_max <= collision_limit
        )
    if "left_foot_contact_required" in task.success:
        physical_checks["left_foot_contact_required"] = success_rate >= 1.0
    if "right_foot_contact_required" in task.success:
        physical_checks["right_foot_contact_required"] = success_rate >= 1.0
    return {
        "episodes": len(successes),
        "success_rate": success_rate,
        "failure_rate": failure_rate,
        "physical_fall_rate": physical_fall_rate,
        "support_contract_failure_rate": support_contract_failure_rate,
        "termination_summary": {
            "done_reason_counts": dict(sorted(Counter(done_reasons).items())),
            "physical_fall_rate": physical_fall_rate,
            "support_contract_failure_rate": support_contract_failure_rate,
        },
        "mean_return": float(np.mean(returns)) if returns else 0.0,
        "mean_length": float(np.mean(lengths)) if lengths else 0.0,
        "mean_final_delta_x_m": float(np.mean(final_delta_x)) if final_delta_x else 0.0,
        "mean_final_delta_y_m": float(np.mean(final_delta_y)) if final_delta_y else 0.0,
        "mean_final_delta_yaw_rad": float(np.mean(final_delta_yaw))
        if final_delta_yaw
        else 0.0,
        "mean_final_torso_z_m": float(np.mean(final_torso_z)) if final_torso_z else 0.0,
        "tracked_body_name": tracked_body_names[0] if tracked_body_names else "",
        "mean_final_tracked_delta_x_m": float(np.mean(final_tracked_delta_x))
        if final_tracked_delta_x
        else 0.0,
        "mean_final_tracked_delta_y_m": float(np.mean(final_tracked_delta_y))
        if final_tracked_delta_y
        else 0.0,
        "mean_final_tracked_delta_z_m": float(np.mean(final_tracked_delta_z))
        if final_tracked_delta_z
        else 0.0,
        "mean_final_tracked_z_m": float(np.mean(final_tracked_z))
        if final_tracked_z
        else 0.0,
        "movement_summary": movement_summary,
        "reward_term_summary": {
            key: _float_stats(values) for key, values in sorted(reward_term_totals.items())
        },
        "support_collision_diagnostics": {
            "self_collision_count_sum": _float_stats(self_collision_count_sum),
            "self_collision_active_steps": _float_stats(self_collision_active_steps),
            "self_collision_pre_fall_max": _float_stats(self_collision_pre_fall_max),
            "self_collision_terminal_max": _float_stats(self_collision_terminal_max),
            "support_contract_pre_fall_sum": _float_stats(
                support_contract_pre_fall_sum
            ),
            "support_contract_terminal_sum": _float_stats(
                support_contract_terminal_sum
            ),
        },
        "action_summary": {
            "l2_norm": _float_stats(action_l2),
            "mean_abs": _float_stats(action_abs_mean),
            "max_abs": _float_stats(action_max_abs),
            "effective_max_abs": _float_stats(effective_action_max_abs),
            "locomotion_prior_max_abs": _float_stats(locomotion_prior_action_max_abs),
            "locomotion_prior_residual_max_abs": _float_stats(
                locomotion_prior_residual_max_abs
            ),
            "locomotion_prior_residual_pre_guard_max_abs": _float_stats(
                locomotion_prior_residual_pre_guard_max_abs
            ),
            "locomotion_prior_residual_stability_scale": _float_stats(
                locomotion_prior_residual_stability_scales
            ),
            "locomotion_prior_residual_scale": _float_stats(
                locomotion_prior_residual_scales
            ),
        },
        "physical_checks": physical_checks,
        "physical_success": bool(physical_checks) and all(physical_checks.values()),
        "reasons": reasons[:5],
    }


def _promotion_passed(promotion_eval: dict, min_phase_success_rate: float) -> bool:
    return (
        float(promotion_eval.get("success_rate", 0.0))
        >= float(min_phase_success_rate)
        and promotion_eval.get("physical_success") is True
    )


def _promotion_blocker(
    promotion_eval: dict, min_phase_success_rate: float
) -> str | None:
    if float(promotion_eval.get("success_rate", 0.0)) < float(min_phase_success_rate):
        return "phase_success_rate_below_threshold"
    if promotion_eval.get("physical_success") is not True:
        return "phase_physical_success_missing"
    return None


def train_robot(
    profile_id: str,
    tasks: list[str],
    steps_per_task: int,
    out_dir: Path,
    *,
    controller_type: str = "linear",
    pca_dim: int = 32,
    episode_steps: int = 200,
    eval_episodes: int = 3,
    seed: int = 0,
    requested_total_steps: int | None = None,
    domain_rand: bool = True,
    action_scale: float = 0.3,
    action_scale_initial: float | None = None,
    action_scale_increment: float = DEFAULT_ACTION_SCALE_INCREMENT,
    gamma: float = 0.97,
    actor_step_size: float = 5e-3,
    critic_step_size: float = 1e-2,
    log_sigma_init: float = -1.0,
    normalize: bool = True,
    require_phase_success: bool = False,
    min_phase_success_rate: float = 1.0,
    phase_eval_interval_steps: int | None = None,
    locomotion_action_prior: str = "none",
    staged_biped_action_prior: str = "none",
    locomotion_prior_residual_scale: float = 1.0,
    locomotion_prior_residual_scale_initial: float | None = None,
    locomotion_prior_residual_scale_increment: float = (
        DEFAULT_LOCOMOTION_PRIOR_RESIDUAL_SCALE_INCREMENT
    ),
    locomotion_prior_residual_mode: str = "joint",
    locomotion_prior_feedback_pitch: float | None = None,
    locomotion_prior_feedback_roll: float | None = None,
    locomotion_prior_feedback_yaw: float | None = None,
    cbp_hidden_sizes: str | tuple[int, ...] | list[int] = (128, 128),
    cbp_replacement_rate: float = 1e-4,
    cbp_maturity_threshold: int = 100,
    cbp_retention_mode: str = "multihead",
    cbp_retention_slots: int | None = None,
    cbp_trunk_step_scale: float = 0.5,
    cbp_trunk_freeze_after: int = 0,
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
    active_action_prior = (
        locomotion_action_prior
        if locomotion_action_prior != "none"
        else staged_biped_action_prior
    )
    action_scale_schedule = _build_action_scale_schedule(
        target_scale=action_scale,
        initial_scale=_initial_action_scale_for_training(
            target_scale=action_scale,
            requested_initial_scale=action_scale_initial,
            locomotion_action_prior=active_action_prior,
        ),
        increment=action_scale_increment,
        min_success_rate=min_phase_success_rate,
        allow_stable_partial_progress=active_action_prior == "none",
        allow_safe_locomotion_prior_scale=locomotion_action_prior != "none",
    )
    current_action_scale = float(action_scale_schedule["initial_scale"])
    residual_scale_schedule = _build_locomotion_prior_residual_schedule(
        target_scale=locomotion_prior_residual_scale,
        initial_scale=locomotion_prior_residual_scale_initial,
        increment=locomotion_prior_residual_scale_increment,
        locomotion_action_prior=active_action_prior,
    )
    current_locomotion_prior_residual_scale = float(
        residual_scale_schedule["initial_scale"]
    )
    (
        locomotion_prior_feedback_pitch,
        locomotion_prior_feedback_roll,
        locomotion_prior_feedback_yaw,
    ) = _resolve_locomotion_prior_feedback(
        locomotion_action_prior=locomotion_action_prior,
        pitch=locomotion_prior_feedback_pitch,
        roll=locomotion_prior_feedback_roll,
        yaw=locomotion_prior_feedback_yaw,
    )
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
            action_scale=current_action_scale,
            locomotion_action_prior=locomotion_action_prior,
            staged_biped_action_prior=staged_biped_action_prior,
            locomotion_prior_residual_scale=current_locomotion_prior_residual_scale,
            locomotion_prior_residual_mode=locomotion_prior_residual_mode,
            locomotion_prior_feedback_pitch=locomotion_prior_feedback_pitch,
            locomotion_prior_feedback_roll=locomotion_prior_feedback_roll,
            locomotion_prior_feedback_yaw=locomotion_prior_feedback_yaw,
            domain_rand=domain_rand,
        ),
    )
    obs_dim = int(env.observation_space.shape[0])
    action_dim = int(env.action_space.shape[0])

    controller_type = controller_type.lower().strip()
    if controller_type not in {"linear", "cbp"}:
        raise ValueError("controller_type must be 'linear' or 'cbp'")
    feature_cfg: FeatureConfig | None = None
    cbp_controller_cfg = None
    if controller_type == "linear":
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
            gamma=gamma,
            actor_step_size=actor_step_size,
            critic_step_size=critic_step_size,
            log_sigma_init=log_sigma_init,
            normalize=normalize,
            obgd_kappa=2.0,
            features=feature_cfg,
            seed=seed,
        )
        controller = AlbertaContinualController(controller_cfg)
    else:
        from alberta_framework.core.continual_backprop import ContinualBackpropConfig

        from eliza_robot.rl.alberta.cbp_agent import (
            AlbertaCBPController,
            CBPControllerConfig,
            RetentionConfig,
        )

        hidden_sizes = _parse_hidden_sizes(cbp_hidden_sizes)
        retention_mode = cbp_retention_mode.lower().strip()
        if retention_mode not in {"none", "multihead"}:
            raise ValueError("cbp_retention_mode must be 'none' or 'multihead'")
        retention_slots = (
            max(1, len(tasks) * 2)
            if cbp_retention_slots is None
            else int(cbp_retention_slots)
        )
        cbp_controller_cfg = CBPControllerConfig(
            obs_dim=obs_dim,
            action_dim=action_dim,
            gamma=gamma,
            actor_step_size=actor_step_size,
            critic_step_size=critic_step_size,
            log_sigma_init=log_sigma_init,
            normalize=normalize,
            obgd_kappa=2.0,
            hidden_sizes=hidden_sizes,
            cbp=ContinualBackpropConfig(
                replacement_rate=float(cbp_replacement_rate),
                maturity_threshold=int(cbp_maturity_threshold),
            ),
            retention=RetentionConfig(
                mode=retention_mode,
                n_slots=max(1, retention_slots),
                embed_dim=pca_dim,
                trunk_step_scale=float(cbp_trunk_step_scale),
                trunk_freeze_after=int(cbp_trunk_freeze_after),
                proto_seed=seed + 12_345,
            ),
            seed=seed,
        )
        controller = AlbertaCBPController(cbp_controller_cfg)

    # Snapshot the full active-task list once; pinning replaces env.active_tasks
    # per phase, so we must index into this stable snapshot, not the mutated list.
    all_active = {t.id: t for t in env.active_tasks}
    history = []
    promotion_rows = []
    action_scale_events = [
        {
            "phase": None,
            "task": None,
            "step": 0,
            "from_scale": None,
            "to_scale": current_action_scale,
            "reason": "initial_stability_scale",
            "gate_passed": True,
        }
    ]
    residual_scale_events = [
        {
            "phase": None,
            "task": None,
            "step": 0,
            "from_scale": None,
            "to_scale": current_locomotion_prior_residual_scale,
            "reason": "initial_prior_residual_scale",
            "gate_passed": True,
        }
    ]
    total_steps_run = 0
    eval_interval = int(
        phase_eval_interval_steps
        if phase_eval_interval_steps is not None
        else min(DEFAULT_PHASE_EVAL_INTERVAL_STEPS, steps_per_task)
    )
    eval_interval = max(1, eval_interval)
    for phase, task in enumerate(tasks):
        if task not in all_active:
            raise ValueError(f"task {task!r} not in env active tasks {list(all_active)}")
        task_spec = all_active[task]
        phase_residual_target_scale = (
            0.0
            if _effective_locomotion_prior_residual_scale(
                task_id=task,
                staged_biped_action_prior=staged_biped_action_prior,
                locomotion_action_prior=locomotion_action_prior,
                current_scale=float(residual_scale_schedule["target_scale"]),
            )
            == 0.0
            else float(residual_scale_schedule["target_scale"])
        )
        phase_residual_scale_start = _effective_locomotion_prior_residual_scale(
            task_id=task,
            staged_biped_action_prior=staged_biped_action_prior,
            locomotion_action_prior=locomotion_action_prior,
            current_scale=current_locomotion_prior_residual_scale,
        )
        if _starts_final_bounded_walk_with_zero_residual(
            task_id=task,
            locomotion_action_prior=locomotion_action_prior,
        ):
            phase_residual_scale_start = 0.0
        _set_env_locomotion_prior_residual_scale(env, phase_residual_scale_start)
        env.active_tasks = [task_spec]
        pre_ev = evaluate(
            controller,
            env,
            eval_episodes,
            max_episode_steps=episode_steps,
            seed=30_000 + phase,
        )
        pre_success_eval = _evaluate_task_success(
            controller,
            env,
            task_spec,
            episodes=eval_episodes,
            max_episode_steps=episode_steps,
            seed=40_000 + phase,
        )
        phase_steps_run = 0
        phase_train_returns = []
        phase_scale_start = current_action_scale
        phase_scale_events = []
        phase_residual_scale_events = []
        promoted = False
        first_promotion_step: int | None = None
        promotion_eval = None
        while phase_steps_run < steps_per_task:
            if hasattr(controller, "set_actor_update_scale"):
                target_residual_scale = float(residual_scale_schedule["target_scale"])
                effective_residual_scale = _effective_locomotion_prior_residual_scale(
                    task_id=task,
                    staged_biped_action_prior=staged_biped_action_prior,
                    locomotion_action_prior=locomotion_action_prior,
                    current_scale=current_locomotion_prior_residual_scale,
                )
                if _starts_final_bounded_walk_with_zero_residual(
                    task_id=task,
                    locomotion_action_prior=locomotion_action_prior,
                ):
                    effective_residual_scale = float(
                        env.config.locomotion_prior_residual_scale
                    )
                if active_action_prior == "none":
                    actor_update_scale = 1.0
                elif effective_residual_scale <= 0.0:
                    actor_update_scale = 0.0
                elif target_residual_scale > 0.0:
                    actor_update_scale = (
                        effective_residual_scale / target_residual_scale
                    )
                else:
                    actor_update_scale = 0.0
                controller.set_actor_update_scale(actor_update_scale)
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
            promoted = _promotion_passed(promotion_eval, min_phase_success_rate)
            if promoted and first_promotion_step is None:
                first_promotion_step = int(phase_steps_run)
            gate_passed = _action_scale_gate_passed(
                promotion_eval,
                task_id=task,
                min_success_rate=min_phase_success_rate,
                allow_stable_partial_progress=active_action_prior == "none",
                allow_safe_locomotion_prior_scale=locomotion_action_prior != "none",
            )
            residual_partial_gate_passed = (
                _bounded_step_walk_final_residual_gate_passed(
                    promotion_eval,
                    task_id=task,
                )
                if (
                    task == "walk_forward"
                    and locomotion_action_prior == "hiwonder_bounded_step_walk"
                )
                else _stable_partial_progress_gate_passed(
                    promotion_eval,
                    task_id=task,
                )
            )
            residual_gate_passed = _promotion_passed(
                promotion_eval,
                min_phase_success_rate,
            ) or residual_partial_gate_passed
            target_scale = float(action_scale_schedule["target_scale"])
            if (
                action_scale_schedule["enabled"]
                and gate_passed
                and current_action_scale < target_scale
            ):
                old_scale = current_action_scale
                current_action_scale = min(
                    target_scale,
                    current_action_scale + float(action_scale_schedule["increment"]),
                )
                _set_env_action_scale(env, current_action_scale)
                event = {
                    "phase": phase,
                    "task": task,
                    "step": int(phase_steps_run),
                    "from_scale": float(old_scale),
                    "to_scale": float(current_action_scale),
                    "reason": _scale_gate_reason(
                        promotion_eval,
                        task_id=task,
                        min_success_rate=min_phase_success_rate,
                        allow_safe_locomotion_prior_scale=locomotion_action_prior
                        != "none",
                    ),
                    "gate_passed": True,
                    "success_rate": float(promotion_eval["success_rate"]),
                    "failure_rate": float(promotion_eval["failure_rate"]),
                    "physical_success": bool(promotion_eval["physical_success"]),
                    "partial_progress_gate": bool(
                        _stable_partial_progress_gate_passed(
                            promotion_eval,
                            task_id=task,
                        )
                    ),
                    "safe_locomotion_prior_scale_gate": bool(
                        _safe_locomotion_prior_scale_gate_passed(
                            promotion_eval,
                            task_id=task,
                        )
                    ),
                }
                phase_scale_events.append(event)
                action_scale_events.append(event)
            residual_target_scale = float(phase_residual_target_scale)
            if (
                residual_scale_schedule["enabled"]
                and residual_target_scale > 0.0
                and residual_gate_passed
                and current_locomotion_prior_residual_scale < residual_target_scale
            ):
                old_residual_scale = current_locomotion_prior_residual_scale
                current_locomotion_prior_residual_scale = min(
                    residual_target_scale,
                    current_locomotion_prior_residual_scale
                    + float(residual_scale_schedule["increment"]),
                )
                _set_env_locomotion_prior_residual_scale(
                    env,
                    current_locomotion_prior_residual_scale,
                )
                event = {
                    "phase": phase,
                    "task": task,
                    "step": int(phase_steps_run),
                    "from_scale": float(old_residual_scale),
                    "to_scale": float(current_locomotion_prior_residual_scale),
                    "reason": _scale_gate_reason(
                        promotion_eval,
                        task_id=task,
                        min_success_rate=min_phase_success_rate,
                    ),
                    "gate_passed": True,
                    "success_rate": float(promotion_eval["success_rate"]),
                    "failure_rate": float(promotion_eval["failure_rate"]),
                    "physical_success": bool(promotion_eval["physical_success"]),
                    "partial_progress_gate": bool(
                        residual_partial_gate_passed
                    ),
                }
                phase_residual_scale_events.append(event)
                residual_scale_events.append(event)
        phase_residual_scale_end = _effective_locomotion_prior_residual_scale(
            task_id=task,
            staged_biped_action_prior=staged_biped_action_prior,
            locomotion_action_prior=locomotion_action_prior,
            current_scale=current_locomotion_prior_residual_scale,
        )
        if _starts_final_bounded_walk_with_zero_residual(
            task_id=task,
            locomotion_action_prior=locomotion_action_prior,
        ):
            phase_residual_scale_end = float(env.config.locomotion_prior_residual_scale)
        if promotion_eval is None:
            promotion_eval = {
                "episodes": 0,
                "success_rate": 0.0,
                "failure_rate": 0.0,
                "physical_fall_rate": 0.0,
                "support_contract_failure_rate": 0.0,
                "termination_summary": {},
                "mean_return": 0.0,
                "mean_length": 0.0,
                "mean_final_delta_x_m": 0.0,
                "mean_final_delta_y_m": 0.0,
                "mean_final_delta_yaw_rad": 0.0,
                "mean_final_torso_z_m": 0.0,
                "tracked_body_name": "",
                "mean_final_tracked_delta_x_m": 0.0,
                "mean_final_tracked_delta_y_m": 0.0,
                "mean_final_tracked_delta_z_m": 0.0,
                "mean_final_tracked_z_m": 0.0,
                "movement_summary": {},
                "reward_term_summary": {},
                "support_collision_diagnostics": {},
                "action_summary": {},
                "physical_checks": {},
                "physical_success": False,
                "reasons": [],
            }
            ev = evaluate(
                controller,
                env,
                eval_episodes,
                max_episode_steps=episode_steps,
                seed=10_000 + phase,
            )
        promotion_blocker = _promotion_blocker(promotion_eval, min_phase_success_rate)
        history.append(
            {
                "phase": phase,
                "task": task,
                "action_scale_start": float(phase_scale_start),
                "action_scale_end": float(current_action_scale),
                "action_scale_target": float(action_scale_schedule["target_scale"]),
                "action_scale_events": phase_scale_events,
                "locomotion_prior_residual_scale_start": float(
                    phase_residual_scale_start
                ),
                "locomotion_prior_residual_scale_end": float(
                    phase_residual_scale_end
                ),
                "locomotion_prior_residual_scale_target": float(
                    phase_residual_target_scale
                ),
                "locomotion_prior_residual_scale_events": phase_residual_scale_events,
                "train_steps": int(phase_steps_run),
                "train_episodes": len(phase_train_returns),
                "train_mean_return": float(np.mean(phase_train_returns))
                if phase_train_returns
                else 0.0,
                "pre_eval_mean_return": pre_ev.mean_return,
                "pre_eval_success_rate": pre_success_eval["success_rate"],
                "eval_mean_return": ev.mean_return,
                "eval_success_rate": promotion_eval["success_rate"],
                "eval_failure_rate": promotion_eval["failure_rate"],
                "eval_physical_fall_rate": promotion_eval["physical_fall_rate"],
                "eval_support_contract_failure_rate": promotion_eval[
                    "support_contract_failure_rate"
                ],
                "termination_summary": promotion_eval["termination_summary"],
                "eval_mean_length": promotion_eval["mean_length"],
                "pre_mean_final_delta_x_m": pre_success_eval["mean_final_delta_x_m"],
                "eval_mean_final_delta_x_m": promotion_eval["mean_final_delta_x_m"],
                "pre_mean_final_delta_y_m": pre_success_eval["mean_final_delta_y_m"],
                "eval_mean_final_delta_y_m": promotion_eval["mean_final_delta_y_m"],
                "pre_mean_final_delta_yaw_rad": pre_success_eval[
                    "mean_final_delta_yaw_rad"
                ],
                "eval_mean_final_delta_yaw_rad": promotion_eval[
                    "mean_final_delta_yaw_rad"
                ],
                "pre_mean_final_torso_z_m": pre_success_eval["mean_final_torso_z_m"],
                "eval_mean_final_torso_z_m": promotion_eval["mean_final_torso_z_m"],
                "tracked_body_name": promotion_eval["tracked_body_name"],
                "eval_mean_final_tracked_delta_x_m": promotion_eval[
                    "mean_final_tracked_delta_x_m"
                ],
                "eval_mean_final_tracked_delta_y_m": promotion_eval[
                    "mean_final_tracked_delta_y_m"
                ],
                "eval_mean_final_tracked_delta_z_m": promotion_eval[
                    "mean_final_tracked_delta_z_m"
                ],
                "eval_mean_final_tracked_z_m": promotion_eval[
                    "mean_final_tracked_z_m"
                ],
                "physical_success": promotion_eval["physical_success"],
                "physical_checks": promotion_eval["physical_checks"],
                "movement_summary": promotion_eval["movement_summary"],
                "reward_term_summary": promotion_eval["reward_term_summary"],
                "support_collision_diagnostics": promotion_eval[
                    "support_collision_diagnostics"
                ],
                "action_summary": promotion_eval["action_summary"],
                "learning_return_delta": float(ev.mean_return - pre_ev.mean_return),
                "learning_success_rate_delta": float(
                    promotion_eval["success_rate"] - pre_success_eval["success_rate"]
                ),
                "learning_delta_x_m": float(
                    promotion_eval["mean_final_delta_x_m"]
                    - pre_success_eval["mean_final_delta_x_m"]
                ),
                "learning_delta_y_m": float(
                    promotion_eval["mean_final_delta_y_m"]
                    - pre_success_eval["mean_final_delta_y_m"]
                ),
                "learning_delta_yaw_rad": float(
                    promotion_eval["mean_final_delta_yaw_rad"]
                    - pre_success_eval["mean_final_delta_yaw_rad"]
                ),
                "promoted": promoted,
                "promotion_passed": promoted,
                "first_promotion_step": first_promotion_step,
                "trained_full_phase_budget": int(phase_steps_run)
                >= int(steps_per_task),
                "promotion_blocker": promotion_blocker,
                "promotion_reasons": promotion_eval["reasons"],
            }
        )
        promotion_rows.append(
            {
                "phase": phase,
                "task": task,
                "attempt": 1,
                "action_scale_start": float(phase_scale_start),
                "action_scale_end": float(current_action_scale),
                "action_scale_target": float(action_scale_schedule["target_scale"]),
                "action_scale_events": phase_scale_events,
                "locomotion_prior_residual_scale_start": float(
                    phase_residual_scale_start
                ),
                "locomotion_prior_residual_scale_end": float(
                    phase_residual_scale_end
                ),
                "locomotion_prior_residual_scale_target": float(
                    phase_residual_target_scale
                ),
                "locomotion_prior_residual_scale_events": phase_residual_scale_events,
                "steps_trained": int(phase_steps_run),
                "cumulative_steps": int(total_steps_run),
                "eval_episodes": int(eval_episodes),
                "pre_eval_mean_return": float(pre_ev.mean_return),
                "pre_eval_success_rate": pre_success_eval["success_rate"],
                "eval_mean_return": float(ev.mean_return),
                "success_rate": promotion_eval["success_rate"],
                "eval_success_rate": promotion_eval["success_rate"],
                "failure_rate": promotion_eval["failure_rate"],
                "physical_fall_rate": promotion_eval["physical_fall_rate"],
                "support_contract_failure_rate": promotion_eval[
                    "support_contract_failure_rate"
                ],
                "termination_summary": promotion_eval["termination_summary"],
                "mean_final_delta_x_m": promotion_eval["mean_final_delta_x_m"],
                "mean_final_delta_y_m": promotion_eval["mean_final_delta_y_m"],
                "mean_final_delta_yaw_rad": promotion_eval["mean_final_delta_yaw_rad"],
                "mean_final_torso_z_m": promotion_eval["mean_final_torso_z_m"],
                "tracked_body_name": promotion_eval["tracked_body_name"],
                "mean_final_tracked_delta_x_m": promotion_eval[
                    "mean_final_tracked_delta_x_m"
                ],
                "mean_final_tracked_delta_y_m": promotion_eval[
                    "mean_final_tracked_delta_y_m"
                ],
                "mean_final_tracked_delta_z_m": promotion_eval[
                    "mean_final_tracked_delta_z_m"
                ],
                "mean_final_tracked_z_m": promotion_eval["mean_final_tracked_z_m"],
                "physical_success": promotion_eval["physical_success"],
                "physical_checks": promotion_eval["physical_checks"],
                "movement_summary": promotion_eval["movement_summary"],
                "reward_term_summary": promotion_eval["reward_term_summary"],
                "support_collision_diagnostics": promotion_eval[
                    "support_collision_diagnostics"
                ],
                "action_summary": promotion_eval["action_summary"],
                "learning_return_delta": float(ev.mean_return - pre_ev.mean_return),
                "learning_success_rate_delta": float(
                    promotion_eval["success_rate"] - pre_success_eval["success_rate"]
                ),
                "learning_delta_x_m": float(
                    promotion_eval["mean_final_delta_x_m"]
                    - pre_success_eval["mean_final_delta_x_m"]
                ),
                "learning_delta_y_m": float(
                    promotion_eval["mean_final_delta_y_m"]
                    - pre_success_eval["mean_final_delta_y_m"]
                ),
                "learning_delta_yaw_rad": float(
                    promotion_eval["mean_final_delta_yaw_rad"]
                    - pre_success_eval["mean_final_delta_yaw_rad"]
                ),
                "eval_failures": int(
                    round(
                        float(promotion_eval["failure_rate"])
                        * int(promotion_eval["episodes"])
                    )
                ),
                "promoted": promoted,
                "promotion_passed": promoted,
                "first_promotion_step": first_promotion_step,
                "trained_full_phase_budget": int(phase_steps_run)
                >= int(steps_per_task),
                "promotion_reason": (
                    "success_rate_and_physical_success_gte_threshold"
                    if promoted
                    else promotion_blocker
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
    if controller_type == "cbp":
        from eliza_robot.rl.alberta.checkpoint import save_state_npz

        save_state_npz(out_dir / "alberta_policy.npz", snap)
    else:
        np.savez(out_dir / "alberta_policy.npz", **snap)
    all_promoted = all(row["promoted"] for row in promotion_rows)
    failed_phase = next(
        (row["phase"] for row in promotion_rows if not row["promoted"]),
        None,
    )
    manifest = {
        "regime": "alberta_streaming",
        "controller_type": controller_type,
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
        "action_scale": float(action_scale),
        "action_scale_schedule": {
            **action_scale_schedule,
            "final_scale": float(current_action_scale),
            "events": action_scale_events,
        },
        "eval_episodes": int(eval_episodes),
        "seed": int(seed),
        "domain_rand": bool(domain_rand),
        "locomotion_action_prior": locomotion_action_prior,
        "staged_biped_action_prior": staged_biped_action_prior,
        "locomotion_prior_residual_scale": float(locomotion_prior_residual_scale),
        "locomotion_prior_residual_mode": locomotion_prior_residual_mode,
        "locomotion_prior_residual_scale_schedule": {
            **residual_scale_schedule,
            "final_scale": float(current_locomotion_prior_residual_scale),
            "events": residual_scale_events,
        },
        "locomotion_prior_feedback": {
            "pitch": float(locomotion_prior_feedback_pitch),
            "roll": float(locomotion_prior_feedback_roll),
            "yaw": float(locomotion_prior_feedback_yaw),
        },
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
        "controller": _controller_manifest(
            controller_type=controller_type,
            linear_cfg=controller_cfg if controller_type == "linear" else None,
            feature_cfg=feature_cfg,
            cbp_cfg=cbp_controller_cfg,
        ),
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
    p.add_argument("--action-scale", type=float, default=0.3)
    p.add_argument("--action-scale-initial", type=float, default=None)
    p.add_argument(
        "--action-scale-increment",
        type=float,
        default=DEFAULT_ACTION_SCALE_INCREMENT,
    )
    p.add_argument("--gamma", type=float, default=0.97)
    p.add_argument("--actor-step-size", type=float, default=5e-3)
    p.add_argument("--critic-step-size", type=float, default=1e-2)
    p.add_argument("--log-sigma-init", type=float, default=-1.0)
    p.add_argument("--no-normalize", action="store_true")
    p.add_argument(
        "--locomotion-action-prior",
        choices=(
            "none",
            "gait",
            "hiwonder_sine",
            "hiwonder_contact_sine",
            "hiwonder_low_slip_contact_sine",
            "hiwonder_bounded_step_walk",
        ),
        default="none",
    )
    p.add_argument(
        "--staged-biped-action-prior",
        choices=("none", "hiwonder_staged_biped"),
        default="none",
    )
    p.add_argument("--locomotion-prior-residual-scale", type=float, default=1.0)
    p.add_argument("--locomotion-prior-residual-scale-initial", type=float, default=None)
    p.add_argument(
        "--locomotion-prior-residual-scale-increment",
        type=float,
        default=DEFAULT_LOCOMOTION_PRIOR_RESIDUAL_SCALE_INCREMENT,
    )
    p.add_argument(
        "--locomotion-prior-residual-mode",
        choices=("joint", "hiwonder_stride_mod"),
        default="joint",
    )
    p.add_argument("--locomotion-prior-feedback-pitch", type=float, default=None)
    p.add_argument("--locomotion-prior-feedback-roll", type=float, default=None)
    p.add_argument("--locomotion-prior-feedback-yaw", type=float, default=None)
    p.add_argument("--out-dir", default="checkpoints/alberta_text_conditioned")
    p.add_argument("--require-phase-success", action="store_true")
    p.add_argument("--min-phase-success-rate", type=float, default=1.0)
    p.add_argument("--phase-eval-interval-steps", type=int, default=None)
    p.add_argument(
        "--controller-type",
        choices=("linear", "cbp"),
        default="linear",
        help="Alberta controller implementation to train",
    )
    p.add_argument("--cbp-hidden-sizes", default="128,128")
    p.add_argument("--cbp-replacement-rate", type=float, default=1e-4)
    p.add_argument("--cbp-maturity-threshold", type=int, default=100)
    p.add_argument("--cbp-retention-mode", choices=("none", "multihead"), default="multihead")
    p.add_argument("--cbp-retention-slots", type=int, default=None)
    p.add_argument("--cbp-trunk-step-scale", type=float, default=0.5)
    p.add_argument("--cbp-trunk-freeze-after", type=int, default=0)
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
        controller_type=args.controller_type,
        pca_dim=args.pca_dim,
        episode_steps=args.episode_steps,
        eval_episodes=args.eval_episodes,
        seed=args.seed,
        action_scale=args.action_scale,
        action_scale_initial=args.action_scale_initial,
        action_scale_increment=args.action_scale_increment,
        gamma=args.gamma,
        actor_step_size=args.actor_step_size,
        critic_step_size=args.critic_step_size,
        log_sigma_init=args.log_sigma_init,
        normalize=not args.no_normalize,
        locomotion_action_prior=args.locomotion_action_prior,
        staged_biped_action_prior=args.staged_biped_action_prior,
        locomotion_prior_residual_scale=args.locomotion_prior_residual_scale,
        locomotion_prior_residual_scale_initial=(
            args.locomotion_prior_residual_scale_initial
        ),
        locomotion_prior_residual_scale_increment=(
            args.locomotion_prior_residual_scale_increment
        ),
        locomotion_prior_residual_mode=args.locomotion_prior_residual_mode,
        locomotion_prior_feedback_pitch=args.locomotion_prior_feedback_pitch,
        locomotion_prior_feedback_roll=args.locomotion_prior_feedback_roll,
        locomotion_prior_feedback_yaw=args.locomotion_prior_feedback_yaw,
        domain_rand=not args.no_domain_rand,
        require_phase_success=args.require_phase_success,
        min_phase_success_rate=args.min_phase_success_rate,
        phase_eval_interval_steps=args.phase_eval_interval_steps,
        cbp_hidden_sizes=args.cbp_hidden_sizes,
        cbp_replacement_rate=args.cbp_replacement_rate,
        cbp_maturity_threshold=args.cbp_maturity_threshold,
        cbp_retention_mode=args.cbp_retention_mode,
        cbp_retention_slots=args.cbp_retention_slots,
        cbp_trunk_step_scale=args.cbp_trunk_step_scale,
        cbp_trunk_freeze_after=args.cbp_trunk_freeze_after,
    )


if __name__ == "__main__":
    main()
