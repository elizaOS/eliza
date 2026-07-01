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
from typing import Any

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
    "walk_forward_bridge",
    "walk_forward_mid_bridge",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)

_MOTION_CLIP_DIR = ROOT / "assets" / "profiles" / "hiwonder-ainex" / "motions"

_HIWONDER_FORWARD_SINE_PARAMS: tuple[dict[str, Any], ...] = (
    {
        "scale": 0.4,
        "hz": 1.9563907621711247,
        "phase0": 1.5402834507831917,
        "hip_bias": 0.2755584748442317,
        "hip_amp": 0.3212468621215588,
        "knee_bias": 0.09924759866261687,
        "knee_amp": 0.312690957982961,
        "knee_phase": 1.4589047174050291,
        "ank_bias": 0.2105912950140183,
        "ank_amp": 0.3654458496024856,
        "ank_phase": 0.15487493622422388,
        "roll_bias": -0.1729556790550616,
        "roll_amp": 0.5051988821589164,
        "ank_roll_amp": 0.25950980435178034,
        "roll_phase": 0.04278032216174843,
        "ank_roll_phase_delta": 0.5739662341358047,
        "yaw_amp": 0.0494646013783038,
        "yaw_phase": 1.397874927385332,
    },
    {
        "scale": 0.4034294095831785,
        "hz": 1.9855734322995764,
        "phase0": 1.6844958278078308,
        "hip_bias": 0.28770228475844883,
        "hip_amp": 0.2412191794545148,
        "knee_bias": 0.07058999827144093,
        "knee_amp": 0.28693207311954694,
        "knee_phase": 1.4589047174050291,
        "ank_bias": 0.2105912950140183,
        "ank_amp": 0.3849445885113766,
        "ank_phase": 0.38509251894537644,
        "roll_bias": -0.2142212852219753,
        "roll_amp": 0.5051988821589164,
        "ank_roll_amp": 0.22919304073908292,
        "roll_phase": 0.04278032216174843,
        "ank_roll_phase_delta": 0.5677232568921792,
        "yaw_amp": 0.0,
        "yaw_phase": 0.0,
    },
    {
        "scale": 0.4034294095831785,
        "hz": 1.9855734322995764,
        "phase0": 1.6844958278078308,
        "hip_bias": 0.28770228475844883,
        "hip_amp": 0.2412191794545148,
        "knee_bias": 0.07058999827144093,
        "knee_amp": 0.28693207311954694,
        "knee_phase": 1.4589047174050291,
        "ank_bias": 0.2105912950140183,
        "ank_amp": 0.3849445885113766,
        "ank_phase": 0.38509251894537644,
        "roll_bias": -0.2142212852219753,
        "roll_amp": 0.5051988821589164,
        "ank_roll_amp": 0.22919304073908292,
        "roll_phase": 0.04278032216174843,
        "ank_roll_phase_delta": 0.5677232568921792,
        "yaw_amp": 0.0,
        "yaw_phase": 0.0,
        "hold_switch_step": 220,
        "hold_mode": "freeze",
        "hold_blend_steps": 10,
    },
    {
        "scale": 0.4034294095831785,
        "hz": 1.9855734322995764,
        "phase0": 1.6844958278078308,
        "hip_bias": 0.28770228475844883,
        "hip_amp": 0.2412191794545148,
        "knee_bias": 0.07058999827144093,
        "knee_amp": 0.28693207311954694,
        "knee_phase": 1.4589047174050291,
        "ank_bias": 0.2105912950140183,
        "ank_amp": 0.3849445885113766,
        "ank_phase": 0.38509251894537644,
        "roll_bias": -0.2142212852219753,
        "roll_amp": 0.5051988821589164,
        "ank_roll_amp": 0.22919304073908292,
        "roll_phase": 0.04278032216174843,
        "ank_roll_phase_delta": 0.5677232568921792,
        "yaw_amp": 0.0,
        "yaw_phase": 0.0,
        "hold_switch_step": 224,
        "hold_mode": "freeze",
        "hold_blend_steps": 0,
    },
)

_UNITREE_R1_FORWARD_SINE_PARAMS: tuple[dict[str, Any], ...] = (
    {
        "scale": 0.11256610072362042,
        "hz": 0.45499920865500043,
        "phase0": -0.1714404938301346,
        "hip_bias": -0.2567093668405783,
        "hip_amp": 0.6261870442717705,
        "knee_bias": 0.35951148084382206,
        "knee_amp": 0.4234662888126237,
        "knee_phase": -1.8153392697675157,
        "ank_bias": -0.01790194910718612,
        "ank_amp": 0.07487754456664701,
        "ank_phase": -0.2833332532656203,
        "roll_bias": -0.14219957422307716,
        "roll_amp": 0.40058191582434266,
        "ank_roll_amp": 0.017935845767314353,
        "roll_phase": -2.5062774146551683,
        "ank_roll_phase_delta": 0.06917828308038487,
        "yaw_amp": 0.0,
        "yaw_phase": -0.13976425049595953,
    },
    {
        "scale": 0.05764458175381873,
        "hz": 2.485147895750645,
        "phase0": 1.9783615521809894,
        "hip_bias": -0.01458320979572475,
        "hip_amp": 0.4444611344930725,
        "knee_bias": 0.19130102338471983,
        "knee_amp": 0.42212358312538917,
        "knee_phase": -2.3888768288921907,
        "ank_bias": 0.20105623299864223,
        "ank_amp": 0.02726228175493999,
        "ank_phase": 0.13707383184259037,
        "roll_bias": -0.21815966910345874,
        "roll_amp": 0.49268140313934566,
        "ank_roll_amp": 0.12712755004357743,
        "roll_phase": 1.334127992509198,
        "ank_roll_phase_delta": 1.320555161347066,
        "yaw_amp": 0.0,
        "yaw_phase": -0.8250734577859391,
    },
)

_UNITREE_R1_STANCE_GAIT_PARAMS: tuple[dict[str, Any], ...] = (
    {
        "scale": 1.0,
        "hip_bias": -0.2475470492797372,
        "knee_bias": 0.520553000357292,
        "ank_bias": -0.33685481798207323,
        "hz": 1.9642740613643404,
        "phase0": 3.005265983416357,
        "hip_amp": 0.17128858153185186,
        "knee_amp": 0.038369195844245974,
        "knee_phase": 1.1941125238448276,
        "ank_amp": 0.12321146083232079,
        "ank_phase": 2.9230443051456527,
        "roll_bias": 0.11929154689788765,
        "roll_amp": 0.08899617903874857,
        "ank_roll_amp": 0.25603436201924384,
        "roll_phase": 1.6054348326319978,
        "ank_roll_phase_delta": -0.879347402604539,
        "yaw_amp": 0.025170662632861607,
        "yaw_phase": 2.2246878043029827,
    },
    {
        "scale": 0.80506,
        "hz": 1.34058,
        "phase0": 2.5247,
        "hip_bias": -0.20118,
        "hip_amp": 0.16202,
        "knee_bias": 0.65414,
        "knee_amp": 0.00679,
        "knee_phase": 0.66031,
        "ank_bias": -0.34165,
        "ank_amp": 0.04318,
        "ank_phase": 2.93132,
        "roll_bias": 0.1309,
        "roll_amp": 0.03928,
        "ank_roll_amp": 0.04773,
        "roll_phase": 2.1146,
        "ank_roll_phase_delta": -1.25268,
        "yaw_amp": 0.025170662632861607,
        "yaw_phase": 2.2246878043029827,
    },
)


@dataclass(frozen=True)
class _PrimitiveSpec:
    name: str
    action_scale: float
    factory: Callable[[TextConditionedProfileEnv, str], Callable[[int], np.ndarray | None]]
    params: dict[str, Any] | None = None


def _sample(t_s: float, info: dict) -> TelemetrySample:
    return TelemetrySample(
        t_s=t_s,
        torso_x_m=_finite_or_none(info.get("root_x")),
        torso_y_m=_finite_or_none(info.get("root_y")),
        torso_z_m=_finite_or_none(info.get("torso_z")),
        yaw_rad=_finite_or_none(info.get("root_yaw")),
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


def _count_alternating_contacts(
    left_contacts: list[float],
    right_contacts: list[float],
) -> int:
    switches = 0
    last_stance: str | None = None
    for left, right in zip(left_contacts, right_contacts, strict=False):
        stance = None
        if left > 0.5 and right <= 0.5:
            stance = "left"
        elif right > 0.5 and left <= 0.5:
            stance = "right"
        if stance is None:
            continue
        if last_stance is not None and stance != last_stance:
            switches += 1
        last_stance = stance
    return switches


def _contact_state(left: float | None, right: float | None) -> str:
    if left is None or right is None:
        return "unknown"
    left_on = left > 0.5
    right_on = right > 0.5
    if left_on and right_on:
        return "double_support"
    if left_on:
        return "left"
    if right_on:
        return "right"
    return "no_support"


def _last_single_support(left_contacts: list[float], right_contacts: list[float]) -> str | None:
    for left, right in reversed(list(zip(left_contacts, right_contacts, strict=False))):
        state = _contact_state(left, right)
        if state in {"left", "right"}:
            return state
    return None


def _support_sequence(
    left_contacts: list[float],
    right_contacts: list[float],
    *,
    max_entries: int = 16,
) -> list[str]:
    sequence: list[str] = []
    last: str | None = None
    for left, right in zip(left_contacts, right_contacts, strict=False):
        state = _contact_state(left, right)
        if state == last:
            continue
        sequence.append(state)
        last = state
    return sequence[-max_entries:]


def _trace_series(traces: dict[str, list[float]], root_key: str, tracked_key: str) -> list[float]:
    tracked = traces.get(tracked_key, [])
    return tracked if tracked else traces.get(root_key, [])


def _preferred_value(info: dict, root_key: str, tracked_key: str) -> tuple[float | None, str]:
    tracked = _finite_or_none(info.get(tracked_key))
    if tracked is not None:
        return tracked, "tracked_body"
    return _finite_or_none(info.get(root_key)), "root"


def _uses_locomotion_displacement(success: dict) -> bool:
    return any(
        key in success
        for key in (
            "delta_x_m_min",
            "delta_x_m_max",
            "delta_y_m_min",
            "delta_y_m_max",
            "max_lateral_drift_m",
            "max_forward_drift_m",
            "max_abs_delta_x_m",
            "max_abs_delta_y_m",
            "max_translation_drift_m",
        )
    )


def _tracked_height_present(row: dict) -> bool:
    telemetry = row.get("diagnostics", {}).get("tracked_body", {})
    return bool(telemetry.get("height_present"))


def _fell_during_candidate(row: dict) -> bool:
    reason = str(row.get("termination_reason") or "").lower()
    if bool(row.get("failed")) and str(row.get("reason") or "").lower().startswith("fall"):
        return True
    return bool(row.get("terminated")) and (
        "fall" in reason
        or "torso_z_below_fall_threshold" in reason
        or "upright_projection_negative" in reason
    )


def _wrap_pi(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


def _distance_frontier(success: dict, traces: dict[str, list[float]]) -> list[dict]:
    frontier: list[dict] = []
    for name, root_key, tracked_key, direction in (
        ("delta_x_m_min", "delta_x", "tracked_delta_x", "min"),
        ("delta_x_m_max", "delta_x", "tracked_delta_x", "max"),
        ("delta_y_m_min", "delta_y", "tracked_delta_y", "min"),
        ("delta_y_m_max", "delta_y", "tracked_delta_y", "max"),
    ):
        if name not in success:
            continue
        target = float(success[name])
        series = _trace_series(traces, root_key, tracked_key)
        if not series:
            frontier.append(
                {
                    "predicate": name,
                    "target_m": target,
                    "source": "tracked_body" if traces.get(tracked_key) else "root",
                    "best_m": None,
                    "final_m": None,
                    "gap_m": None,
                    "progress_fraction": 0.0,
                    "sample_index": None,
                }
            )
            continue
        if direction == "min":
            best = max(series)
            sample_index = int(np.argmax(series))
            gap = max(0.0, target - best)
            progress = best / target if target > 0.0 else 0.0
        else:
            best = min(series)
            sample_index = int(np.argmin(series))
            gap = max(0.0, best - target)
            progress = abs(min(0.0, best)) / abs(target) if target < 0.0 else 0.0
        frontier.append(
            {
                "predicate": name,
                "target_m": target,
                "source": "tracked_body" if traces.get(tracked_key) else "root",
                "best_m": best,
                "final_m": series[-1],
                "gap_m": gap,
                "progress_fraction": float(max(0.0, min(progress, 1.5))),
                "sample_index": sample_index,
            }
        )
    return frontier


def _walk_eval_diagnostics(
    *,
    success: dict,
    final_info: dict,
    traces: dict[str, list[float]],
) -> dict:
    left_contacts = traces.get("left_foot_contact", [])
    right_contacts = traces.get("right_foot_contact", [])
    final_left = left_contacts[-1] if left_contacts else None
    final_right = right_contacts[-1] if right_contacts else None
    final_phase = _finite_or_none(final_info.get("gait_phase"))
    if final_phase is None and traces.get("gait_phase"):
        final_phase = traces["gait_phase"][-1]
    expected_support = None
    if final_phase is not None:
        phase_sin = math.sin(final_phase)
        if phase_sin > 0.0:
            expected_support = "left"
        elif phase_sin < 0.0:
            expected_support = "right"
        else:
            expected_support = "neutral"
    else:
        phase_sin = None

    states = [
        _contact_state(left, right)
        for left, right in zip(left_contacts, right_contacts, strict=False)
    ]
    alternating_switch_count = _count_alternating_contacts(left_contacts, right_contacts)
    required_switches = (
        int(success["min_alternating_foot_contacts"])
        if "min_alternating_foot_contacts" in success
        else None
    )
    observed_left_single = any(state == "left" for state in states)
    observed_right_single = any(state == "right" for state in states)
    max_left_slip = _safe_max(traces.get("left_foot_slip", []))
    max_right_slip = _safe_max(traces.get("right_foot_slip", []))
    slip_values = [value for value in (max_left_slip, max_right_slip) if value is not None]
    max_slip = max(slip_values) if slip_values else _safe_max(traces.get("foot_slip", []))

    return {
        "gait_phase_rad": {
            "final": final_phase,
            "sin": phase_sin,
            "cos": None if final_phase is None else math.cos(final_phase),
            "expected_support_foot": expected_support,
        },
        "contacts": {
            "final_left": None if final_left is None else bool(final_left),
            "final_right": None if final_right is None else bool(final_right),
            "final_state": _contact_state(final_left, final_right),
            "left_single_support_samples": sum(1 for state in states if state == "left"),
            "right_single_support_samples": sum(1 for state in states if state == "right"),
            "double_support_samples": sum(1 for state in states if state == "double_support"),
            "no_support_samples": sum(1 for state in states if state == "no_support"),
            "alternating_switch_count": alternating_switch_count,
            "required_alternating_switch_count": required_switches,
            "observed_both_single_support_feet": observed_left_single and observed_right_single,
            "declared_alternation_met": None
            if required_switches is None
            else alternating_switch_count >= required_switches,
            "support_sequence_tail": _support_sequence(left_contacts, right_contacts),
        },
        "support_foot": {
            "final": _contact_state(final_left, final_right),
            "last_single": _last_single_support(left_contacts, right_contacts),
        },
        "pitch_rad": {
            "final": _finite_or_none(final_info.get("imu_pitch")),
            "max_abs": _safe_max_abs(traces.get("imu_pitch", [])),
            "min": _safe_min(traces.get("imu_pitch", [])),
            "max": _safe_max(traces.get("imu_pitch", [])),
        },
        "slip_m_s": {
            "final_left": _finite_or_none(final_info.get("left_foot_slip_m_s")),
            "final_right": _finite_or_none(final_info.get("right_foot_slip_m_s")),
            "max_left": max_left_slip,
            "max_right": max_right_slip,
            "max": max_slip,
            "limit": _finite_or_none(success.get("max_foot_slip_m_s")),
        },
        "distance_frontier": _distance_frontier(success, traces),
    }


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
    success_window_s: float = 0.0,
    start_tracked_z_m: float | None = None,
) -> list[dict]:
    diagnostics: list[dict] = []
    torso_z = _finite_or_none(final_info.get("torso_z"))
    height_source = "torso"
    delta_x, delta_x_source = _preferred_value(final_info, "delta_x", "tracked_delta_x")
    delta_y, delta_y_source = _preferred_value(final_info, "delta_y", "tracked_delta_y")
    delta_yaw = _finite_or_none(final_info.get("delta_yaw"))
    torso_z_trace = traces.get("torso_z", [])
    delta_x_trace = _trace_series(traces, "delta_x", "tracked_delta_x")
    delta_y_trace = _trace_series(traces, "delta_y", "tracked_delta_y")
    start_z_m = start_torso_z_m
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
                    "source": height_source,
                    "min": _safe_min(torso_z_trace),
                    "max": _safe_max(torso_z_trace),
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
                    "source": height_source,
                    "min": _safe_min(torso_z_trace),
                    "max": _safe_max(torso_z_trace),
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
                    "source": height_source,
                    "min": _safe_min(torso_z_trace),
                    "max": _safe_max(torso_z_trace),
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
                    "source": height_source,
                    "min": _safe_min(torso_z_trace),
                    "max": _safe_max(torso_z_trace),
                },
            )
        )
    if "torso_z_delta_min_m" in success:
        threshold = float(success["torso_z_delta_min_m"])
        actual = None if torso_z is None or start_z_m is None else torso_z - start_z_m
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
        actual = None if torso_z is None or start_z_m is None else torso_z - start_z_m
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
                observed_extreme={"source": delta_x_source, "max": _safe_max(delta_x_trace)},
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
                observed_extreme={"source": delta_x_source, "min": _safe_min(delta_x_trace)},
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
                observed_extreme={"source": delta_y_source, "max": _safe_max(delta_y_trace)},
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
                observed_extreme={"source": delta_y_source, "min": _safe_min(delta_y_trace)},
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
                observed_extreme={
                    "source": delta_x_source,
                    "max_abs": _safe_max_abs(delta_x_trace),
                },
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
                observed_extreme={
                    "source": delta_y_source,
                    "max_abs": _safe_max_abs(delta_y_trace),
                },
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
                observed_extreme={
                    "source": delta_y_source,
                    "max_abs_delta_y_m": _safe_max_abs(delta_y_trace),
                },
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
                observed_extreme={
                    "source": delta_x_source,
                    "max_abs_delta_x_m": _safe_max_abs(delta_x_trace),
                },
            )
        )
    if "max_translation_drift_m" in success:
        limit = float(success["max_translation_drift_m"])
        actual = None if delta_x is None or delta_y is None else math.hypot(delta_x, delta_y)
        observed = [
            math.hypot(dx, dy)
            for dx, dy in zip(delta_x_trace, delta_y_trace, strict=False)
        ]
        diagnostics.append(
            _predicate_row(
                name="max_translation_drift_m",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
                observed_extreme={
                    "source_x": delta_x_source,
                    "source_y": delta_y_source,
                    "max": _safe_max(observed),
                },
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
    if "min_alternating_foot_contacts" in success:
        required = int(success["min_alternating_foot_contacts"])
        actual = _count_alternating_contacts(
            traces.get("left_foot_contact", []),
            traces.get("right_foot_contact", []),
        )
        diagnostics.append(
            _predicate_row(
                name="min_alternating_foot_contacts",
                expected={">=": required},
                actual=actual,
                unmet=actual < required,
            )
        )
    for side in ("left", "right"):
        key = f"{side}_foot_contact_required"
        if key not in success:
            continue
        required = bool(success[key])
        values = traces.get(f"{side}_foot_contact", [])
        actual = None if not values else bool(values[-1])
        diagnostics.append(
            _predicate_row(
                name=key,
                expected=required,
                actual=actual,
                unmet=actual is None or actual is not required,
            )
        )
    if "min_swing_foot_clearance_m" in success:
        required = float(success["min_swing_foot_clearance_m"])
        actual = _safe_max(traces.get("swing_foot_clearance", []))
        diagnostics.append(
            _predicate_row(
                name="min_swing_foot_clearance_m",
                expected={">=": required},
                actual=actual,
                unmet=actual is None or actual < required,
            )
        )
    if "max_foot_slip_m_s" in success:
        limit = float(success["max_foot_slip_m_s"])
        actual = _safe_max(traces.get("foot_slip", []))
        diagnostics.append(
            _predicate_row(
                name="max_foot_slip_m_s",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
            )
        )
    if "max_self_collision_count" in success:
        limit = int(success["max_self_collision_count"])
        actual = _safe_max(traces.get("self_collision_count", []))
        diagnostics.append(
            _predicate_row(
                name="max_self_collision_count",
                expected={"<=": limit},
                actual=actual,
                unmet=actual is None or actual > limit,
            )
        )
    if "hold_s" in success:
        hold_s = float(success["hold_s"])
        diagnostics.append(
            _predicate_row(
                name="hold_s",
                expected={">=": hold_s},
                actual=float(success_window_s),
                unmet=float(success_window_s) < hold_s,
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
        if task_id in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge", "walk_backward"}:
            direction = -1.0 if task_id == "walk_backward" else 1.0
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
                action[idx] = 1.0 * direction
            elif "hip_pitch" in name:
                action[idx] = 0.2 * phase * side
        elif task_id == "sit_down":
            if "hip_pitch" in name:
                action[idx] = -1.0
            elif "knee" in name or "ank_pitch" in name:
                action[idx] = 1.0
    return action


def _controller_command(task_id: str) -> tuple[float, float, float] | None:
    if task_id in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge"}:
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


def _locomotion_progress_fraction(
    task_id: str,
    success: dict,
    *,
    tracked_delta_x: float | None,
    tracked_delta_y: float | None,
) -> float:
    if task_id in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge", "walk_backward"}:
        delta = tracked_delta_x
        min_key = "delta_x_m_min"
        max_key = "delta_x_m_max"
    elif task_id in {"sidestep_left", "sidestep_right"}:
        delta = tracked_delta_y
        min_key = "delta_y_m_min"
        max_key = "delta_y_m_max"
    else:
        return 0.0
    if delta is None:
        return 0.0
    if min_key in success:
        target = float(success[min_key])
        return float(delta / target) if target > 0.0 else 0.0
    if max_key in success:
        target = abs(float(success[max_key]))
        return float(abs(min(0.0, delta)) / target) if target > 0.0 else 0.0
    return 0.0


def _joint_pose_action(env: TextConditionedProfileEnv) -> np.ndarray:
    joint_pose = np.array(
        [env._data.qpos[qpos_idx] for qpos_idx in env._joint_qpos_idx],  # noqa: SLF001
        dtype=np.float32,
    )
    action_scale = max(float(env.config.action_scale), 1e-6)
    return np.clip(
        (joint_pose - env._home_pose.astype(np.float32)) / action_scale,  # noqa: SLF001
        -1.0,
        1.0,
    ).astype(np.float32)


def _balance_correction_action(
    env: TextConditionedProfileEnv,
    *,
    roll: float,
    pitch: float,
    yaw: float,
    pitch_gain: float,
    roll_gain: float,
    yaw_gain: float,
) -> np.ndarray:
    correction = np.zeros(env.action_space.shape, dtype=np.float32)
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        side = 1.0 if name.startswith(("l_", "left_")) else -1.0
        if "hip_pitch" in name:
            correction[idx] += side * pitch_gain * pitch
        elif "ank_pitch" in name or "ankle_pitch" in name:
            correction[idx] -= side * pitch_gain * pitch
        elif "hip_roll" in name:
            correction[idx] += side * roll_gain * roll
        elif "ank_roll" in name or "ankle_roll" in name:
            correction[idx] -= side * roll_gain * roll
        elif "hip_yaw" in name:
            correction[idx] -= side * yaw_gain * yaw
    return np.clip(correction, -1.0, 1.0).astype(np.float32)


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


def _make_zero_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
) -> Callable[[int], np.ndarray | None]:
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    return lambda _step: action


def _make_hold_initial_pose_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
) -> Callable[[int], np.ndarray | None]:
    start_pose = np.array(
        [env._data.qpos[qpos_idx] for qpos_idx in env._joint_qpos_idx],  # noqa: SLF001
        dtype=np.float32,
    )
    home_pose = env._home_pose.astype(np.float32)  # noqa: SLF001
    action_scale = max(float(env.config.action_scale), 1e-6)
    action = np.clip((start_pose - home_pose) / action_scale, -1.0, 1.0).astype(
        np.float32
    )
    return lambda _step: action


def _make_stand_up_ramp_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
) -> Callable[[int], np.ndarray | None]:
    start_pose = np.array(
        [env._data.qpos[qpos_idx] for qpos_idx in env._joint_qpos_idx],  # noqa: SLF001
        dtype=np.float32,
    )
    home_pose = env._home_pose.astype(np.float32)  # noqa: SLF001
    action_scale = max(float(env.config.action_scale), 1e-6)
    ramp_steps = max(1, int(round(1.0 / env.config.control_dt_s)))

    def _action(step: int) -> np.ndarray:
        alpha = min(1.0, float(step + 1) / float(ramp_steps))
        target = (1.0 - alpha) * start_pose + alpha * home_pose
        return np.clip((target - home_pose) / action_scale, -1.0, 1.0).astype(
            np.float32
        )

    return _action


def _make_stand_up_pitch_feedback_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
) -> Callable[[int], np.ndarray | None]:
    start_pose = np.array(
        [env._data.qpos[qpos_idx] for qpos_idx in env._joint_qpos_idx],  # noqa: SLF001
        dtype=np.float32,
    )
    home_pose = env._home_pose.astype(np.float32)  # noqa: SLF001
    action_scale = max(float(env.config.action_scale), 1e-6)
    ramp_steps = max(1, int(round(0.5 / env.config.control_dt_s)))
    pitch_gain = 1.0

    def _action(step: int) -> np.ndarray:
        alpha = min(1.0, float(step + 1) / float(ramp_steps))
        alpha = alpha * alpha * (3.0 - 2.0 * alpha)
        target = (1.0 - alpha) * start_pose + alpha * home_pose
        pitch = float(env._root_pose_summary().get("pitch", 0.0))  # noqa: SLF001
        correction = pitch_gain * pitch
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side = 1.0 if name.startswith(("l_", "left_")) else -1.0
            if "hip_pitch" in name:
                target[idx] += side * correction
            elif "ank_pitch" in name or "ankle_pitch" in name:
                target[idx] -= side * correction
        target = np.clip(target, env._lower, env._upper)  # noqa: SLF001
        return np.clip((target - home_pose) / action_scale, -1.0, 1.0).astype(
            np.float32
        )

    return _action


def _make_sit_down_smooth_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
) -> Callable[[int], np.ndarray | None]:
    home_pose = env._home_pose.astype(np.float32)  # noqa: SLF001
    target_pose = home_pose.copy()
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        if "hip_pitch" in name:
            target_pose[idx] = -0.8
        elif "knee" in name:
            target_pose[idx] = 1.6
        elif "ank_pitch" in name:
            target_pose[idx] = 0.8
    target_pose = np.clip(target_pose, env._lower, env._upper)  # noqa: SLF001
    action_scale = max(float(env.config.action_scale), 1e-6)
    ramp_steps = max(1, int(round(2.0 / env.config.control_dt_s)))

    def _action(step: int) -> np.ndarray:
        alpha = min(1.0, float(step + 1) / float(ramp_steps))
        # Smoothstep avoids the early impulse that made the generic primitive
        # pitch forward and fail before reaching the crouched height bracket.
        alpha = alpha * alpha * (3.0 - 2.0 * alpha)
        target = (1.0 - alpha) * home_pose + alpha * target_pose
        return np.clip((target - home_pose) / action_scale, -1.0, 1.0).astype(
            np.float32
        )

    return _action


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
    if task_id in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge"}:
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


def _make_sinusoidal_action(
    env: TextConditionedProfileEnv,
    task_id: str,
    *,
    params: dict[str, Any],
) -> Callable[[int], np.ndarray | None]:
    last_action = np.zeros(env.action_space.shape, dtype=np.float32)

    def _sine_action(step: int) -> np.ndarray:
        t_s = step * env.config.control_dt_s
        phase = 2.0 * np.pi * float(params["hz"]) * t_s + float(
            params.get("phase0", 0.0)
        )
        backward = task_id == "walk_backward"
        direction = -1.0 if backward else 1.0
        phase_offset = float(params.get("backward_phase_offset", np.pi if backward else 0.0))
        gait_phase = phase + phase_offset
        knee_phase_sign = -1.0 if backward else 1.0
        roll_phase_sign = -1.0 if backward else 1.0
        hip_bias = float(params.get("hip_bias", params.get("hip", 0.0)))
        knee_bias = float(params.get("knee_bias", params.get("knee", 0.0)))
        ank_bias = float(params.get("ank_bias", params.get("ank", 0.0)))
        action = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side = 1.0 if name.startswith(("l_", "left_")) else -1.0
            value = 0.0
            if "hip_pitch" in name:
                value = direction * (
                    hip_bias + side * float(params["hip_amp"]) * np.sin(gait_phase)
                )
            elif "knee" in name:
                value = (
                    knee_bias
                    + side
                    * float(params["knee_amp"])
                    * np.sin(gait_phase + knee_phase_sign * float(params["knee_phase"]))
                )
            elif "ank_pitch" in name or "ankle_pitch" in name:
                value = direction * (
                    ank_bias
                    + side
                    * float(params["ank_amp"])
                    * np.sin(gait_phase + knee_phase_sign * float(params["ank_phase"]))
                )
            elif "hip_roll" in name:
                value = (
                    side * float(params["roll_bias"])
                    + side
                    * float(params["roll_amp"])
                    * np.sin(gait_phase + roll_phase_sign * float(params["roll_phase"]))
                )
            elif "ank_roll" in name or "ankle_roll" in name:
                value = (
                    -side * float(params["roll_bias"])
                    + side
                    * float(params["ank_roll_amp"])
                    * np.sin(
                        gait_phase
                        + roll_phase_sign * float(params["roll_phase"])
                        + float(params.get("ank_roll_phase_delta", 0.0))
                    )
                )
            elif "hip_yaw" in name:
                value = side * float(params.get("yaw_amp", 0.0)) * np.sin(
                    gait_phase + float(params.get("yaw_phase", 0.0))
                )
            action[idx] = float(np.clip(value, -1.0, 1.0))
        return action

    def _action(step: int) -> np.ndarray | None:
        nonlocal last_action
        if task_id not in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge", "walk_backward"}:
            return None
        action = _sine_action(step)
        switch_step = params.get("hold_switch_step")
        if switch_step is not None and step >= int(switch_step):
            hold = (
                last_action.copy()
                if params.get("hold_mode") == "freeze"
                else np.zeros(env.action_space.shape, dtype=np.float32)
            )
            blend_steps = int(params.get("hold_blend_steps", 0))
            if blend_steps > 0 and step < int(switch_step) + blend_steps:
                alpha = float(step - int(switch_step) + 1) / float(blend_steps)
                action = (1.0 - alpha) * action + alpha * hold
            else:
                action = hold
        last_action = action.copy()
        return action.astype(np.float32)

    return _action


def _make_env_locomotion_prior_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
    *,
    prior_name: str,
    feedback_pitch: float = 0.0,
    feedback_roll: float = 0.0,
    feedback_yaw: float = 0.0,
) -> Callable[[int], np.ndarray | None]:
    del feedback_pitch, feedback_roll, feedback_yaw
    method_by_prior = {
        "hiwonder_sine": env._locomotion_hiwonder_sine_prior_action,  # noqa: SLF001
        "hiwonder_contact_sine": env._locomotion_hiwonder_contact_sine_prior_action,  # noqa: SLF001
        "hiwonder_low_slip_contact_sine": env._locomotion_hiwonder_low_slip_contact_sine_prior_action,  # noqa: SLF001
        "hiwonder_bounded_step_walk": env._locomotion_hiwonder_bounded_step_walk_prior_action,  # noqa: SLF001
    }
    method = method_by_prior[prior_name]

    def _action(_step: int) -> np.ndarray:
        return method().astype(np.float32)

    return _action


def _make_configured_locomotion_prior_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
) -> Callable[[int], np.ndarray | None]:
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    return lambda _step: action


def _make_switched_deterministic_action(
    env: TextConditionedProfileEnv,
    task_id: str,
    *,
    switch_step: int,
    hold_mode: str,
    post_scale: float = 0.0,
) -> Callable[[int], np.ndarray | None]:
    last_action = np.zeros(env.action_space.shape, dtype=np.float32)

    def _action(step: int) -> np.ndarray | None:
        nonlocal last_action
        action = _deterministic_action(env, task_id, step)
        if step >= switch_step:
            if hold_mode == "freeze":
                action = last_action.copy()
            elif hold_mode == "reverse":
                action = -float(post_scale) * action
            else:
                action = float(post_scale) * last_action
        last_action = action.copy()
        return np.clip(action, -1.0, 1.0).astype(np.float32)

    return _action


def _make_hiwonder_staged_biped_action(
    env: TextConditionedProfileEnv,
    task_id: str,
) -> Callable[[int], np.ndarray | None]:
    """Open-loop smoke primitive for staged single-support prerequisites."""
    if task_id not in {
        "weight_shift_left",
        "weight_shift_right",
        "lift_left_foot",
        "lift_right_foot",
        "step_in_place",
        "step_forward",
    }:
        return lambda _step: None

    def _lift_action(lift_side: str, roll: float) -> np.ndarray:
        action = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side = "left" if name.startswith(("l_", "left_")) else "right"
            if "hip_roll" in name:
                action[idx] = roll
            elif "ank_roll" in name or "ankle_roll" in name:
                action[idx] = -roll
            if side != lift_side:
                continue
            if "hip_pitch" in name:
                action[idx] = -0.25
            elif "knee" in name:
                action[idx] = 0.75
            elif "ank_pitch" in name or "ankle_pitch" in name:
                action[idx] = 0.20
        return np.clip(action, -1.0, 1.0).astype(np.float32)

    def _weight_shift_action(stance_side: str) -> np.ndarray:
        # A conservative roll preload. It should not claim a solved one-foot
        # stance; it only exposes whether the robot can bias support without
        # violating height/drift/yaw/slip gates.
        roll = 0.20 if stance_side == "left" else -0.20
        action = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            if "hip_roll" in name:
                action[idx] = roll
            elif "ank_roll" in name or "ankle_roll" in name:
                action[idx] = -roll
        return np.clip(action, -1.0, 1.0).astype(np.float32)

    def _forward_lift_action(lift_side: str) -> np.ndarray:
        roll = 0.40 if lift_side == "left" else -0.40
        action = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side = "left" if name.startswith(("l_", "left_")) else "right"
            if "hip_roll" in name:
                action[idx] = roll
            elif "ank_roll" in name or "ankle_roll" in name:
                action[idx] = -roll
            if side != lift_side:
                continue
            if "hip_pitch" in name:
                action[idx] = 0.10
            elif "knee" in name:
                action[idx] = 0.75
            elif "ank_pitch" in name or "ankle_pitch" in name:
                action[idx] = 0.20
        return np.clip(action, -1.0, 1.0).astype(np.float32)

    def _action(step: int) -> np.ndarray | None:
        if task_id == "weight_shift_left":
            return _weight_shift_action("left")
        if task_id == "weight_shift_right":
            return _weight_shift_action("right")
        if task_id == "lift_left_foot":
            if step < 30:
                return _lift_action("left", roll=0.45)
            return np.zeros(env.action_space.shape, dtype=np.float32)
        if task_id == "lift_right_foot":
            if step < 30:
                return _lift_action("right", roll=-0.45)
            return np.zeros(env.action_space.shape, dtype=np.float32)
        if task_id == "step_forward":
            if step >= 60:
                return np.zeros(env.action_space.shape, dtype=np.float32)
            cycle = step % 36
            if cycle < 8:
                return _forward_lift_action("left")
            if cycle < 14:
                return np.zeros(env.action_space.shape, dtype=np.float32)
            if cycle < 22:
                return _forward_lift_action("right")
            return np.zeros(env.action_space.shape, dtype=np.float32)
        # Alternate brief single-foot lift attempts with a neutral recovery.
        # Longer first lifts prove a foot can clear, but tip over before the
        # second stance; this timing reaches two single-support switches and
        # then settles upright.
        cycle = step % 36
        if cycle < 8:
            return _lift_action("left", roll=0.45)
        if cycle < 14:
            return np.zeros(env.action_space.shape, dtype=np.float32)
        if cycle < 30:
            return _lift_action("right", roll=-0.45)
        return np.zeros(env.action_space.shape, dtype=np.float32)

    return _action


def _make_hiwonder_bounded_walk_progress_action(
    env: TextConditionedProfileEnv,
    task_id: str,
    *,
    params: dict[str, Any],
) -> Callable[[int], np.ndarray | None]:
    """Bounded HiWonder walk candidate built from the staged forward step.

    This intentionally remains a smoke/search primitive: it repeats the
    validated step-forward lift shape, stops once bounded progress is reached,
    then holds the current joint pose with light yaw/lateral correction.
    """
    if task_id not in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge"}:
        return lambda _step: None

    cycle_steps = int(params.get("cycle_steps", 42))
    left_lift_steps = int(params.get("left_lift_steps", 8))
    neutral_steps = int(params.get("neutral_steps", 6))
    right_lift_steps = int(params.get("right_lift_steps", 8))
    drive_steps = int(params.get("drive_steps", 240))
    stop_delta_x_m = float(params.get("stop_delta_x_m", 0.305))
    roll_amplitude = float(params.get("roll_amplitude", 0.35))
    hip_pitch = float(params.get("hip_pitch", 0.25))
    knee = float(params.get("knee", 0.85))
    ankle_pitch = float(params.get("ankle_pitch", 0.20))
    yaw_gain = float(params.get("yaw_gain", 0.0))
    lateral_gain = float(params.get("lateral_gain", 0.0))
    hold_yaw_gain = float(params.get("hold_yaw_gain", 0.2))
    hold_lateral_gain = float(params.get("hold_lateral_gain", 0.4))
    hold_correction_mix = float(params.get("hold_correction_mix", 0.25))
    settle_blend_steps = max(1, int(params.get("settle_blend_steps", 20)))
    hold_action: np.ndarray | None = None
    settle_started_step: int | None = None

    def _tracked_delta() -> tuple[float, float, float, float]:
        pose = env._root_pose_summary()  # noqa: SLF001
        tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
        delta_x = float(tracked["x"] - env._episode_start_tracked_x)  # noqa: SLF001
        delta_y = float(tracked["y"] - env._episode_start_tracked_y)  # noqa: SLF001
        yaw = _wrap_pi(float(pose.get("yaw", 0.0)) - env._episode_start_yaw)  # noqa: SLF001
        return delta_x, delta_y, yaw, float(pose.get("roll", 0.0))

    def _forward_lift_action(lift_side: str) -> np.ndarray:
        _, delta_y, yaw, roll_now = _tracked_delta()
        roll = (
            (roll_amplitude if lift_side == "left" else -roll_amplitude)
            + lateral_gain * delta_y
            + 0.15 * roll_now
        )
        action = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side = "left" if name.startswith(("l_", "left_")) else "right"
            side_sign = 1.0 if side == "left" else -1.0
            if "hip_yaw" in name:
                action[idx] = yaw_gain * side_sign * yaw
            elif "hip_roll" in name:
                action[idx] = roll
            elif "ank_roll" in name or "ankle_roll" in name:
                action[idx] = -roll
            if side != lift_side:
                continue
            if "hip_pitch" in name:
                action[idx] = hip_pitch
            elif "knee" in name:
                action[idx] = knee
            elif "ank_pitch" in name or "ankle_pitch" in name:
                action[idx] = ankle_pitch
        return np.clip(action, -1.0, 1.0).astype(np.float32)

    def _hold_action() -> np.ndarray:
        nonlocal hold_action
        if hold_action is None:
            hold_action = _joint_pose_action(env)
        _, delta_y, yaw, _ = _tracked_delta()
        correction = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side_sign = 1.0 if name.startswith(("l_", "left_")) else -1.0
            if "hip_yaw" in name:
                correction[idx] = hold_yaw_gain * side_sign * yaw
            elif "hip_roll" in name:
                correction[idx] = hold_lateral_gain * delta_y
            elif "ank_roll" in name or "ankle_roll" in name:
                correction[idx] = -hold_lateral_gain * delta_y
        return np.clip(
            (1.0 - hold_correction_mix) * hold_action + correction,
            -1.0,
            1.0,
        ).astype(np.float32)

    neutral = np.zeros(env.action_space.shape, dtype=np.float32)

    def _drive_action(step: int) -> np.ndarray:
        cycle = step % cycle_steps
        if cycle < left_lift_steps:
            return _forward_lift_action("left")
        if cycle < left_lift_steps + neutral_steps:
            return neutral
        if cycle < left_lift_steps + neutral_steps + right_lift_steps:
            return _forward_lift_action("right")
        return neutral

    def _action(step: int) -> np.ndarray | None:
        nonlocal settle_started_step
        delta_x, _, _, _ = _tracked_delta()
        should_settle = step >= drive_steps or delta_x >= stop_delta_x_m
        if should_settle and settle_started_step is None:
            settle_started_step = step
        if settle_started_step is None:
            return _drive_action(step)
        alpha = min(
            1.0,
            float(step - settle_started_step + 1) / float(settle_blend_steps),
        )
        alpha = alpha * alpha * (3.0 - 2.0 * alpha)
        return np.clip(
            (1.0 - alpha) * _drive_action(step) + alpha * _hold_action(),
            -1.0,
            1.0,
        ).astype(np.float32)

    return _action


def _make_hiwonder_walk_forward_phase_machine_action(
    env: TextConditionedProfileEnv,
    task_id: str,
    *,
    params: dict[str, Any],
) -> Callable[[int], np.ndarray | None]:
    """Bounded drive -> settle -> balance-hold candidate for full walk_forward.

    The drive defaults are intentionally centered on the current
    hiwonder_bounded_step_walk env prior that proves walk_forward_mid_bridge.
    This variant only changes when and how the controller settles/holds; it
    does not alter curriculum success predicates.
    """
    if task_id != "walk_forward":
        return lambda _step: None

    cycle_steps = int(params.get("cycle_steps", 52))
    left_lift_steps = int(params.get("left_lift_steps", 8))
    neutral_steps = int(params.get("neutral_steps", 16))
    right_lift_steps = int(params.get("right_lift_steps", 8))
    drive_steps = int(params.get("drive_steps", 220))
    stop_delta_x_m = float(params.get("stop_delta_x_m", 0.305))
    settle_delta_x_m = float(params.get("settle_delta_x_m", stop_delta_x_m))
    tilt_settle_rad = float(params.get("tilt_settle_rad", 0.48))
    roll_amplitude = float(params.get("roll_amplitude", 0.30))
    hip_pitch = float(params.get("hip_pitch", 0.40))
    knee = float(params.get("knee", 0.85))
    ankle_pitch = float(params.get("ankle_pitch", 0.20))
    yaw_gain = float(params.get("yaw_gain", 0.40))
    lateral_gain = float(params.get("lateral_gain", -0.40))
    roll_feedback = float(params.get("roll_feedback", 0.15))
    settle_blend_steps = max(1, int(params.get("settle_blend_steps", 24)))
    hold_mode = str(params.get("hold_mode", "neutral"))
    hold_pose_mix = float(params.get("hold_pose_mix", 0.0))
    pitch_gain = float(params.get("pitch_gain", 0.0))
    knee_pitch_gain = float(params.get("knee_pitch_gain", 0.0))
    ankle_pitch_gain = float(params.get("ankle_pitch_gain", 0.0))
    plant_knee = float(params.get("plant_knee", 0.0))
    plant_ankle_pitch = float(params.get("plant_ankle_pitch", 0.0))
    roll_gain = float(params.get("roll_gain", 0.0))
    yaw_hold_gain = float(params.get("yaw_hold_gain", 0.0))
    lateral_hold_gain = float(params.get("lateral_hold_gain", 0.0))
    drive_after_tilt_scale = float(params.get("drive_after_tilt_scale", 0.0))
    settle_started_step: int | None = None
    captured_action: np.ndarray | None = None
    neutral_action = np.zeros(env.action_space.shape, dtype=np.float32)

    def _tracked_delta() -> tuple[float, float, float, float, float]:
        pose = env._root_pose_summary()  # noqa: SLF001
        tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
        delta_x = float(tracked["x"] - env._episode_start_tracked_x)  # noqa: SLF001
        delta_y = float(tracked["y"] - env._episode_start_tracked_y)  # noqa: SLF001
        yaw = _wrap_pi(float(pose.get("yaw", 0.0)) - env._episode_start_yaw)  # noqa: SLF001
        return (
            delta_x,
            delta_y,
            yaw,
            float(pose.get("roll", 0.0)),
            float(pose.get("pitch", 0.0)),
        )

    def _drive_action(step: int) -> np.ndarray:
        _, delta_y, yaw, roll_now, pitch_now = _tracked_delta()
        cycle = step % cycle_steps
        if cycle < left_lift_steps:
            lift_side = "left"
        elif cycle < left_lift_steps + neutral_steps:
            return neutral_action
        elif cycle < left_lift_steps + neutral_steps + right_lift_steps:
            lift_side = "right"
        else:
            return neutral_action

        pitch_scale = 1.0
        if abs(pitch_now) >= tilt_settle_rad:
            pitch_scale = drive_after_tilt_scale
        roll = (
            (roll_amplitude if lift_side == "left" else -roll_amplitude)
            + lateral_gain * delta_y
            + roll_feedback * roll_now
        )
        action = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side = "left" if name.startswith(("l_", "left_")) else "right"
            side_sign = 1.0 if side == "left" else -1.0
            if "hip_yaw" in name:
                action[idx] = yaw_gain * side_sign * yaw
            elif "hip_roll" in name:
                action[idx] = roll
            elif "ank_roll" in name or "ankle_roll" in name:
                action[idx] = -roll
            if side != lift_side:
                continue
            if "hip_pitch" in name:
                action[idx] = pitch_scale * hip_pitch
            elif "knee" in name:
                action[idx] = knee
            elif "ank_pitch" in name or "ankle_pitch" in name:
                action[idx] = ankle_pitch
        return np.clip(action, -1.0, 1.0).astype(np.float32)

    def _hold_action() -> np.ndarray:
        nonlocal captured_action
        if captured_action is None:
            captured_action = _joint_pose_action(env)
        _, delta_y, yaw, roll_now, pitch_now = _tracked_delta()
        base = neutral_action if hold_mode == "neutral" else captured_action
        if hold_pose_mix > 0.0:
            base = (1.0 - hold_pose_mix) * base + hold_pose_mix * captured_action
        if hold_mode == "pitch_brake":
            correction = np.zeros(env.action_space.shape, dtype=np.float32)
            pitch_sign = 1.0 if pitch_now >= 0.0 else -1.0
            for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
                name = joint.name.lower()
                side_sign = 1.0 if name.startswith(("l_", "left_")) else -1.0
                if "hip_pitch" in name:
                    correction[idx] = -pitch_gain * pitch_now
                elif "knee" in name:
                    correction[idx] = plant_knee + knee_pitch_gain * abs(pitch_now)
                elif "ank_pitch" in name or "ankle_pitch" in name:
                    correction[idx] = plant_ankle_pitch + ankle_pitch_gain * pitch_sign * abs(
                        pitch_now
                    )
                elif "hip_yaw" in name:
                    correction[idx] = yaw_hold_gain * side_sign * yaw
                elif "hip_roll" in name:
                    correction[idx] = roll_gain * roll_now
                elif "ank_roll" in name or "ankle_roll" in name:
                    correction[idx] = -roll_gain * roll_now
        else:
            correction = _balance_correction_action(
                env,
                roll=roll_now,
                pitch=pitch_now,
                yaw=yaw,
                pitch_gain=pitch_gain,
                roll_gain=roll_gain,
                yaw_gain=yaw_hold_gain,
            )
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            if "hip_roll" in name:
                correction[idx] += lateral_hold_gain * delta_y
            elif "ank_roll" in name or "ankle_roll" in name:
                correction[idx] -= lateral_hold_gain * delta_y
        return np.clip(base + correction, -1.0, 1.0).astype(np.float32)

    def _action(step: int) -> np.ndarray | None:
        nonlocal settle_started_step, captured_action
        delta_x, _, _, _, pitch_now = _tracked_delta()
        should_settle = (
            step >= drive_steps
            or delta_x >= settle_delta_x_m
            or (abs(pitch_now) >= tilt_settle_rad and delta_x >= stop_delta_x_m)
        )
        if should_settle and settle_started_step is None:
            settle_started_step = step
            captured_action = _joint_pose_action(env)
        if settle_started_step is None:
            return _drive_action(step)
        alpha = min(
            1.0,
            float(step - settle_started_step + 1) / float(settle_blend_steps),
        )
        alpha = alpha * alpha * (3.0 - 2.0 * alpha)
        drive = _drive_action(step)
        hold = _hold_action()
        return np.clip((1.0 - alpha) * drive + alpha * hold, -1.0, 1.0).astype(
            np.float32
        )

    return _action


def _make_hiwonder_short_lunge_hold_action(
    env: TextConditionedProfileEnv,
    task_id: str,
    *,
    params: dict[str, Any],
) -> Callable[[int], np.ndarray | None]:
    if task_id not in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge"}:
        return lambda _step: None
    drive_scale = float(params.get("drive_scale", 0.4))
    drive_steps = int(params.get("drive_steps", 34))
    settle_blend_steps = max(1, int(params.get("settle_blend_steps", 20)))
    pitch_gain = float(params.get("pitch_gain", 1.0))
    roll_gain = float(params.get("roll_gain", 0.3))
    yaw_gain = float(params.get("yaw_gain", 0.2))
    hold_mix = float(params.get("hold_mix", 0.7))
    hold_action: np.ndarray | None = None

    def _action(step: int) -> np.ndarray | None:
        nonlocal hold_action
        drive = drive_scale * _deterministic_action(env, task_id, step)
        if step < drive_steps:
            return np.clip(drive, -1.0, 1.0).astype(np.float32)
        if hold_action is None:
            hold_action = _joint_pose_action(env)
        pose = env._root_pose_summary()  # noqa: SLF001
        yaw = _wrap_pi(float(pose.get("yaw", 0.0)) - env._episode_start_yaw)  # noqa: SLF001
        correction = _balance_correction_action(
            env,
            roll=float(pose.get("roll", 0.0)),
            pitch=float(pose.get("pitch", 0.0)),
            yaw=yaw,
            pitch_gain=pitch_gain,
            roll_gain=roll_gain,
            yaw_gain=yaw_gain,
        )
        alpha = min(1.0, float(step - drive_steps + 1) / float(settle_blend_steps))
        alpha = alpha * alpha * (3.0 - 2.0 * alpha)
        hold = (1.0 - hold_mix) * hold_action + correction
        return np.clip((1.0 - alpha) * drive + alpha * hold, -1.0, 1.0).astype(
            np.float32
        )

    return _action


def _make_hiwonder_locomotion_progress_settle_action(
    env: TextConditionedProfileEnv,
    task_id: str,
    *,
    params: dict[str, Any],
) -> Callable[[int], np.ndarray | None]:
    if task_id in {"walk_forward", "walk_backward"}:
        drive_action = _make_sinusoidal_action(env, task_id, params=params["drive"])
    elif task_id in {"sidestep_left", "sidestep_right"}:
        drive_action = _make_deterministic_action(env, task_id)
    else:
        return lambda _step: None

    task = load_curriculum().by_id(task_id)
    settle_started_step: int | None = None
    snapshot_action: np.ndarray | None = None
    blend_steps = max(1, int(params.get("settle_blend_steps", 45)))
    min_drive_steps = int(params.get("min_drive_steps", 80))
    progress_start_fraction = float(params.get("progress_start_fraction", 0.88))
    pitch_gain = float(params.get("pitch_gain", 0.55))
    roll_gain = float(params.get("roll_gain", 0.45))
    yaw_gain = float(params.get("yaw_gain", 0.25))
    tilt_damping_start_rad = float(params.get("tilt_damping_start_rad", 0.22))
    tilt_damping_full_rad = float(params.get("tilt_damping_full_rad", 0.45))

    def _action(step: int) -> np.ndarray | None:
        nonlocal settle_started_step, snapshot_action
        drive = drive_action(step)
        if drive is None:
            return None
        pose = env._root_pose_summary()  # noqa: SLF001
        tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
        tracked_delta_x = float(tracked["x"] - env._episode_start_tracked_x)  # noqa: SLF001
        tracked_delta_y = float(tracked["y"] - env._episode_start_tracked_y)  # noqa: SLF001
        progress_fraction = _locomotion_progress_fraction(
            task_id,
            task.success,
            tracked_delta_x=tracked_delta_x,
            tracked_delta_y=tracked_delta_y,
        )
        if (
            settle_started_step is None
            and step >= min_drive_steps
            and progress_fraction >= progress_start_fraction
        ):
            settle_started_step = step
            snapshot_action = _joint_pose_action(env)

        if settle_started_step is None:
            return np.clip(drive, -1.0, 1.0).astype(np.float32)

        settle_steps = max(0, step - settle_started_step + 1)
        alpha = min(1.0, float(settle_steps) / float(blend_steps))
        alpha = alpha * alpha * (3.0 - 2.0 * alpha)
        roll = float(pose.get("roll", 0.0))
        pitch = float(pose.get("pitch", 0.0))
        yaw = _wrap_pi(float(pose.get("yaw", 0.0)) - env._episode_start_yaw)  # noqa: SLF001
        tilt = max(abs(roll), abs(pitch))
        if tilt > tilt_damping_start_rad:
            denom = max(tilt_damping_full_rad - tilt_damping_start_rad, 1e-6)
            alpha = max(alpha, min(1.0, (tilt - tilt_damping_start_rad) / denom))
        foot_telemetry = np.asarray(env._last_foot_telemetry, dtype=np.float32)  # noqa: SLF001
        left_contact = bool(foot_telemetry.size > 0 and foot_telemetry[0] > 0.5)
        right_contact = bool(foot_telemetry.size > 1 and foot_telemetry[1] > 0.5)
        if left_contact and right_contact:
            neutral_fraction = alpha
        elif left_contact or right_contact:
            neutral_fraction = 0.35 * alpha
        else:
            neutral_fraction = 0.10 * alpha
        hold = (
            snapshot_action
            if snapshot_action is not None
            else np.zeros(env.action_space.shape, dtype=np.float32)
        )
        correction = _balance_correction_action(
            env,
            roll=roll,
            pitch=pitch,
            yaw=yaw,
            pitch_gain=pitch_gain,
            roll_gain=roll_gain,
            yaw_gain=yaw_gain,
        )
        settle = (1.0 - neutral_fraction) * hold + correction
        action = (1.0 - alpha) * drive + alpha * settle
        return np.clip(action, -1.0, 1.0).astype(np.float32)

    return _action


def _primitive_specs(profile_id: str, task_id: str) -> list[_PrimitiveSpec]:
    specs = [
        _PrimitiveSpec("deterministic_smoke", 0.3, _make_deterministic_action),
    ]
    if profile_id == "hiwonder-ainex" and task_id in {
        "weight_shift_left",
        "weight_shift_right",
        "lift_left_foot",
        "lift_right_foot",
        "step_in_place",
        "step_forward",
    }:
        specs.insert(
            0,
            _PrimitiveSpec(
                "hiwonder_staged_biped",
                1.0,
                _make_hiwonder_staged_biped_action,
            ),
        )
    if task_id == "stand_up":
        specs.insert(
            0,
            _PrimitiveSpec("stand_up_smooth_ramp", 2.0, _make_stand_up_ramp_action),
        )
        if profile_id == "hiwonder-ainex":
            specs.insert(
                0,
                _PrimitiveSpec(
                    "stand_up_pitch_feedback",
                    2.0,
                    _make_stand_up_pitch_feedback_action,
                    {
                        "ramp_s": 0.5,
                        "pitch_gain": 1.0,
                        "mode": "mirrored_hip_ank",
                    },
                ),
            )
    if task_id == "sit_down":
        specs.insert(
            0,
            _PrimitiveSpec(
                "sit_down_smooth_target",
                2.0,
                _make_sit_down_smooth_action,
            ),
        )
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
        if task_id in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge", "walk_backward"}:
            if task_id in {"walk_forward", "walk_forward_bridge", "walk_forward_mid_bridge"}:
                bounded_walk_params = (
                    {
                        "cycle_steps": 36,
                        "left_lift_steps": 8,
                        "neutral_steps": 6,
                        "right_lift_steps": 8,
                        "drive_steps": 180,
                        "stop_delta_x_m": 0.305,
                        "roll_amplitude": 0.40,
                        "hip_pitch": 0.10,
                        "knee": 0.75,
                        "ankle_pitch": 0.20,
                        "yaw_gain": 0.0,
                        "lateral_gain": 0.0,
                        "hold_yaw_gain": 0.2,
                        "hold_lateral_gain": 0.4,
                        "hold_correction_mix": 0.25,
                        "settle_blend_steps": 20,
                    },
                    {
                        "cycle_steps": 42,
                        "left_lift_steps": 8,
                        "neutral_steps": 6,
                        "right_lift_steps": 8,
                        "drive_steps": 240,
                        "stop_delta_x_m": 0.305,
                        "roll_amplitude": 0.32,
                        "hip_pitch": 0.25,
                        "knee": 0.85,
                        "ankle_pitch": 0.20,
                        "yaw_gain": 0.8,
                        "lateral_gain": -0.4,
                        "hold_yaw_gain": 0.2,
                        "hold_lateral_gain": 0.4,
                        "hold_correction_mix": 0.25,
                        "settle_blend_steps": 20,
                    },
                    {
                        "cycle_steps": 42,
                        "left_lift_steps": 8,
                        "neutral_steps": 6,
                        "right_lift_steps": 8,
                        "drive_steps": 240,
                        "stop_delta_x_m": 0.305,
                        "roll_amplitude": 0.35,
                        "hip_pitch": 0.25,
                        "knee": 1.0,
                        "ankle_pitch": 0.20,
                        "yaw_gain": 0.0,
                        "lateral_gain": 0.0,
                        "hold_yaw_gain": 0.2,
                        "hold_lateral_gain": 0.4,
                        "hold_correction_mix": 0.25,
                        "settle_blend_steps": 20,
                    },
                    {
                        "cycle_steps": 40,
                        "left_lift_steps": 8,
                        "neutral_steps": 4,
                        "right_lift_steps": 8,
                        "drive_steps": 240,
                        "stop_delta_x_m": 0.305,
                        "roll_amplitude": 0.24,
                        "hip_pitch": 0.32,
                        "knee": 0.95,
                        "ankle_pitch": 0.20,
                        "yaw_gain": 0.8,
                        "lateral_gain": -0.4,
                        "hold_yaw_gain": 0.2,
                        "hold_lateral_gain": 0.4,
                        "hold_correction_mix": 0.25,
                        "settle_blend_steps": 20,
                    },
                )
                for idx, params in enumerate(bounded_walk_params):
                    specs.append(
                        _PrimitiveSpec(
                            f"hiwonder_bounded_step_forward_walk_{idx}",
                            1.0,
                            partial(
                                _make_hiwonder_bounded_walk_progress_action,
                                params=params,
                            ),
                            dict(params),
                        )
                    )
                if task_id == "walk_forward":
                    phase_machine_params = (
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 220,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.305,
                            "tilt_settle_rad": 0.50,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.48,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 18,
                            "hold_mode": "neutral",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": -0.45,
                            "roll_gain": 0.20,
                            "yaw_hold_gain": 0.12,
                            "lateral_hold_gain": -0.25,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 48,
                            "left_lift_steps": 8,
                            "neutral_steps": 12,
                            "right_lift_steps": 8,
                            "drive_steps": 210,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.305,
                            "tilt_settle_rad": 0.50,
                            "roll_amplitude": 0.28,
                            "hip_pitch": 0.44,
                            "knee": 0.82,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.35,
                            "lateral_gain": -0.35,
                            "roll_feedback": 0.12,
                            "settle_blend_steps": 16,
                            "hold_mode": "neutral",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": -0.35,
                            "roll_gain": 0.15,
                            "yaw_hold_gain": 0.10,
                            "lateral_hold_gain": -0.20,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 44,
                            "left_lift_steps": 8,
                            "neutral_steps": 10,
                            "right_lift_steps": 8,
                            "drive_steps": 200,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.305,
                            "tilt_settle_rad": 0.52,
                            "roll_amplitude": 0.26,
                            "hip_pitch": 0.40,
                            "knee": 0.82,
                            "ankle_pitch": 0.18,
                            "yaw_gain": 0.30,
                            "lateral_gain": -0.30,
                            "roll_feedback": 0.10,
                            "settle_blend_steps": 14,
                            "hold_mode": "neutral",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": -0.30,
                            "roll_gain": 0.10,
                            "yaw_hold_gain": 0.08,
                            "lateral_hold_gain": -0.15,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 220,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.305,
                            "tilt_settle_rad": 0.50,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.48,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 22,
                            "hold_mode": "captured",
                            "hold_pose_mix": 0.25,
                            "pitch_gain": -0.35,
                            "roll_gain": 0.15,
                            "yaw_hold_gain": 0.10,
                            "lateral_hold_gain": -0.20,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 132,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.245,
                            "tilt_settle_rad": 0.44,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.40,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 12,
                            "hold_mode": "neutral",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": -0.20,
                            "roll_gain": 0.10,
                            "yaw_hold_gain": 0.05,
                            "lateral_hold_gain": -0.10,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 146,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.260,
                            "tilt_settle_rad": 0.48,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.40,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 12,
                            "hold_mode": "neutral",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": -0.15,
                            "roll_gain": 0.08,
                            "yaw_hold_gain": 0.05,
                            "lateral_hold_gain": -0.08,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 156,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.275,
                            "tilt_settle_rad": 0.52,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.40,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 10,
                            "hold_mode": "neutral",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": -0.10,
                            "roll_gain": 0.06,
                            "yaw_hold_gain": 0.04,
                            "lateral_hold_gain": -0.06,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 240,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.230,
                            "tilt_settle_rad": 0.60,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.40,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 2,
                            "hold_mode": "pitch_brake",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": 1.50,
                            "roll_gain": 0.10,
                            "yaw_hold_gain": 0.20,
                            "lateral_hold_gain": -0.40,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 240,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.225,
                            "tilt_settle_rad": 0.60,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.40,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 4,
                            "hold_mode": "pitch_brake",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": 1.00,
                            "roll_gain": 0.10,
                            "yaw_hold_gain": 0.20,
                            "lateral_hold_gain": -0.40,
                            "drive_after_tilt_scale": 0.0,
                        },
                        {
                            "cycle_steps": 52,
                            "left_lift_steps": 8,
                            "neutral_steps": 16,
                            "right_lift_steps": 8,
                            "drive_steps": 240,
                            "stop_delta_x_m": 0.305,
                            "settle_delta_x_m": 0.200,
                            "tilt_settle_rad": 0.60,
                            "roll_amplitude": 0.30,
                            "hip_pitch": 0.40,
                            "knee": 0.85,
                            "ankle_pitch": 0.20,
                            "yaw_gain": 0.40,
                            "lateral_gain": -0.40,
                            "roll_feedback": 0.15,
                            "settle_blend_steps": 12,
                            "hold_mode": "pitch_brake",
                            "hold_pose_mix": 0.0,
                            "pitch_gain": 1.00,
                            "roll_gain": 0.10,
                            "yaw_hold_gain": 0.20,
                            "lateral_hold_gain": -0.40,
                            "drive_after_tilt_scale": 0.0,
                        },
                    )
                    for idx, params in enumerate(phase_machine_params):
                        specs.append(
                            _PrimitiveSpec(
                                f"hiwonder_walk_forward_phase_machine_{idx}",
                                1.0,
                                partial(
                                    _make_hiwonder_walk_forward_phase_machine_action,
                                    params=params,
                                ),
                                dict(params),
                            )
                        )
                short_lunge_params = {
                    "drive_scale": 0.4,
                    "drive_steps": 34,
                    "settle_blend_steps": 20,
                    "pitch_gain": 1.0,
                    "roll_gain": 0.3,
                    "yaw_gain": 0.2,
                    "hold_mix": 0.7,
                }
                specs.append(
                    _PrimitiveSpec(
                        "hiwonder_short_lunge_hold",
                        1.0,
                        partial(
                            _make_hiwonder_short_lunge_hold_action,
                            params=short_lunge_params,
                        ),
                        dict(short_lunge_params),
                    )
                )
            for prior_name in (
                "hiwonder_sine",
                "hiwonder_contact_sine",
                "hiwonder_low_slip_contact_sine",
                "hiwonder_bounded_step_walk",
            ):
                specs.append(
                    _PrimitiveSpec(
                        f"configured_prior_{prior_name}",
                        1.0,
                        _make_configured_locomotion_prior_action,
                        {
                            "prior_name": prior_name,
                            "env_config": {
                                "locomotion_action_prior": prior_name,
                                "locomotion_prior_residual_scale": 0.0,
                            },
                        },
                    )
                )
                specs.append(
                    _PrimitiveSpec(
                        f"env_prior_{prior_name}",
                        1.0,
                        partial(
                            _make_env_locomotion_prior_action,
                            prior_name=prior_name,
                        ),
                        {"prior_name": prior_name},
                    )
                )
            for idx, params in enumerate(_HIWONDER_FORWARD_SINE_PARAMS):
                specs.append(
                    _PrimitiveSpec(
                        f"sinusoidal_seeded_{idx}",
                        float(params["scale"]),
                        partial(_make_sinusoidal_action, params=params),
                        dict(params),
                    )
                )
            settle_params = {
                "drive": dict(_HIWONDER_FORWARD_SINE_PARAMS[1]),
                "min_drive_steps": 80,
                "progress_start_fraction": 0.88,
                "settle_blend_steps": 45,
                "pitch_gain": 0.55,
                "roll_gain": 0.45,
                "yaw_gain": 0.25,
                "tilt_damping_start_rad": 0.22,
                "tilt_damping_full_rad": 0.45,
            }
            specs.append(
                _PrimitiveSpec(
                    "hiwonder_closed_loop_progress_settle",
                    float(settle_params["drive"]["scale"]),
                    partial(
                        _make_hiwonder_locomotion_progress_settle_action,
                        params=settle_params,
                    ),
                    dict(settle_params),
                )
            )
        if task_id in {"sidestep_left", "sidestep_right"}:
            specs.extend(
                [
                    _PrimitiveSpec(
                        "switched_deterministic_freeze",
                        0.3,
                        partial(
                            _make_switched_deterministic_action,
                            switch_step=220,
                            hold_mode="freeze",
                        ),
                    ),
                    _PrimitiveSpec(
                        "switched_deterministic_damped",
                        0.3,
                        partial(
                            _make_switched_deterministic_action,
                            switch_step=200,
                            hold_mode="damp",
                            post_scale=0.5,
                        ),
                    ),
                ]
            )
            settle_params = {
                "drive": {},
                "min_drive_steps": 12,
                "progress_start_fraction": 0.75,
                "settle_blend_steps": 12,
                "pitch_gain": 0.55,
                "roll_gain": 0.45,
                "yaw_gain": 0.25,
                "tilt_damping_start_rad": 0.22,
                "tilt_damping_full_rad": 0.45,
            }
            specs.append(
                _PrimitiveSpec(
                    "hiwonder_closed_loop_progress_settle",
                    1.0,
                    partial(
                        _make_hiwonder_locomotion_progress_settle_action,
                        params=settle_params,
                    ),
                    dict(settle_params),
                )
            )
    if profile_id == "unitree-r1" and task_id in {"walk_forward", "walk_backward"}:
        for idx, params in enumerate(_UNITREE_R1_FORWARD_SINE_PARAMS):
            specs.append(
                _PrimitiveSpec(
                    f"unitree_r1_sinusoidal_seeded_{idx}",
                    float(params["scale"]),
                    partial(_make_sinusoidal_action, params=params),
                    dict(params),
                )
            )
        for idx, params in enumerate(_UNITREE_R1_STANCE_GAIT_PARAMS):
            specs.append(
                _PrimitiveSpec(
                    f"unitree_r1_stance_gait_seeded_{idx}",
                    float(params["scale"]),
                    partial(_make_sinusoidal_action, params=params),
                    dict(params),
                )
            )
    return specs


def _progress_ratio(success: dict, traces: dict[str, list[float]]) -> float:
    ratios: list[float] = []
    delta_x = _trace_series(traces, "delta_x", "tracked_delta_x")
    delta_y = _trace_series(traces, "delta_y", "tracked_delta_y")
    if "delta_x_m_min" in success:
        target = float(success["delta_x_m_min"])
        observed = _safe_max(delta_x)
        if observed is not None and target > 0.0:
            ratios.append(observed / target)
    if "delta_x_m_max" in success:
        target = abs(float(success["delta_x_m_max"]))
        observed = _safe_min(delta_x)
        if observed is not None and target > 0.0:
            ratios.append(abs(min(0.0, observed)) / target)
    if "delta_y_m_min" in success:
        target = float(success["delta_y_m_min"])
        observed = _safe_max(delta_y)
        if observed is not None and target > 0.0:
            ratios.append(observed / target)
    if "delta_y_m_max" in success:
        target = abs(float(success["delta_y_m_max"]))
        observed = _safe_min(delta_y)
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
    env_config_overrides = dict(primitive.params.get("env_config", {})) if primitive.params else {}
    env = TextConditionedProfileEnv(
        profile,
        ProfileEnvConfig(
            include_tasks=(task_id,),
            exclude_tasks=(),
            episode_steps=max_steps,
            domain_rand=False,
            action_scale=primitive.action_scale,
            **env_config_overrides,
        ),
    )
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
    task = load_curriculum().by_id(task_id)
    checker = GoalChecker(task, episode_start_t_s=0.0)
    checker.update(_sample(0.0, start_info))
    traces = {
        "torso_z": [],
        "tracked_z": [],
        "delta_x": [],
        "delta_y": [],
        "delta_yaw": [],
        "tracked_delta_x": [],
        "tracked_delta_y": [],
        "tracked_delta_z": [],
        "imu_roll": [],
        "imu_pitch": [],
        "gait_phase": [],
        "left_foot_contact": [],
        "right_foot_contact": [],
        "swing_foot_clearance": [],
        "foot_slip": [],
        "left_foot_slip": [],
        "right_foot_slip": [],
        "self_collision_count": [],
    }
    result = None
    max_success_window_s = 0.0
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
        for key in (
            "torso_z",
            "tracked_z",
            "delta_x",
            "delta_y",
            "delta_yaw",
            "tracked_delta_x",
            "tracked_delta_y",
            "tracked_delta_z",
            "imu_roll",
            "imu_pitch",
            "gait_phase",
        ):
            value = _finite_or_none(last_info.get(key))
            if value is not None:
                traces[key].append(value)
        for key in ("left_foot_contact", "right_foot_contact"):
            value = last_info.get(key)
            if value is not None:
                traces[key].append(1.0 if bool(value) else 0.0)
        left_contact = bool(last_info.get("left_foot_contact", False))
        right_contact = bool(last_info.get("right_foot_contact", False))
        swing_clearances = []
        if not left_contact:
            value = _finite_or_none(last_info.get("left_foot_z"))
            if value is not None:
                swing_clearances.append(value)
        if not right_contact:
            value = _finite_or_none(last_info.get("right_foot_z"))
            if value is not None:
                swing_clearances.append(value)
        if swing_clearances:
            traces["swing_foot_clearance"].append(max(swing_clearances))
        for key in ("left_foot_slip_m_s", "right_foot_slip_m_s"):
            value = _finite_or_none(last_info.get(key))
            if value is not None:
                traces["foot_slip"].append(value)
                trace_key = "left_foot_slip" if key.startswith("left_") else "right_foot_slip"
                traces[trace_key].append(value)
        value = _finite_or_none(last_info.get("self_collision_count"))
        if value is not None:
            traces["self_collision_count"].append(value)
        result = checker.update(_sample((step + 1) * env.config.control_dt_s, last_info))
        max_success_window_s = max(max_success_window_s, float(result.success_window_s))
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
        success_window_s=max_success_window_s,
        start_tracked_z_m=float(env._episode_start_tracked_z),  # noqa: SLF001
    )
    delta_x, delta_x_source = _preferred_value(last_info, "delta_x", "tracked_delta_x")
    delta_y, delta_y_source = _preferred_value(last_info, "delta_y", "tracked_delta_y")
    tracked_z = _finite_or_none(last_info.get("tracked_z"))
    delta_x_trace = _trace_series(traces, "delta_x", "tracked_delta_x")
    delta_y_trace = _trace_series(traces, "delta_y", "tracked_delta_y")
    tracked_body_summary = {
        "name": last_info.get("tracked_body_name"),
        "height_present": bool(traces["tracked_z"] or tracked_z is not None),
        "delta_x_present": bool(traces["tracked_delta_x"]),
        "delta_y_present": bool(traces["tracked_delta_y"]),
        "delta_z_present": bool(traces["tracked_delta_z"]),
        "delta_x_source": delta_x_source,
        "delta_y_source": delta_y_source,
        "height_source": "tracked_body" if tracked_z is not None else "root",
    }
    diagnostics = {
        "controller": primitive.name,
        "action_scale": primitive.action_scale,
        "termination_reason": termination_reason,
        "torso_z_m": {
            "min": _safe_min(traces["torso_z"]),
            "max": _safe_max(traces["torso_z"]),
            "final": _finite_or_none(last_info.get("torso_z")),
        },
        "tracked_body": tracked_body_summary,
        "tracked_z_m": {
            "min": _safe_min(traces["tracked_z"]),
            "max": _safe_max(traces["tracked_z"]),
            "final": tracked_z,
        },
        "delta_x_m": {
            "source": delta_x_source,
            "final": delta_x,
            "max_abs": _safe_max_abs(delta_x_trace),
            "min": _safe_min(delta_x_trace),
            "max": _safe_max(delta_x_trace),
        },
        "delta_y_m": {
            "source": delta_y_source,
            "final": delta_y,
            "max_abs": _safe_max_abs(delta_y_trace),
            "min": _safe_min(delta_y_trace),
            "max": _safe_max(delta_y_trace),
        },
        "delta_yaw_rad": {
            "final": _finite_or_none(last_info.get("delta_yaw")),
            "max_abs": _safe_max_abs(traces["delta_yaw"]),
            "min": _safe_min(traces["delta_yaw"]),
            "max": _safe_max(traces["delta_yaw"]),
        },
        "imu_roll_rad": {
            "final": _finite_or_none(last_info.get("imu_roll")),
            "max_abs": _safe_max_abs(traces["imu_roll"]),
            "min": _safe_min(traces["imu_roll"]),
            "max": _safe_max(traces["imu_roll"]),
        },
        "imu_pitch_rad": {
            "final": _finite_or_none(last_info.get("imu_pitch")),
            "max_abs": _safe_max_abs(traces["imu_pitch"]),
            "min": _safe_min(traces["imu_pitch"]),
            "max": _safe_max(traces["imu_pitch"]),
        },
        "walk_eval": _walk_eval_diagnostics(
            success=task.success,
            final_info=last_info,
            traces=traces,
        ),
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
        "controller_params": primitive.params,
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
        "final_tracked_z_m": tracked_z,
        "min_torso_z_m": _safe_min(traces["torso_z"]),
        "max_torso_z_m": max(traces["torso_z"]) if traces["torso_z"] else None,
        "final_delta_x_m": delta_x,
        "min_delta_x_m": _safe_min(delta_x_trace),
        "max_delta_x_m": _safe_max(delta_x_trace),
        "final_delta_y_m": delta_y,
        "min_delta_y_m": _safe_min(delta_y_trace),
        "max_delta_y_m": _safe_max(delta_y_trace),
        "final_delta_yaw_rad": _finite_or_none(last_info.get("delta_yaw")),
        "min_delta_yaw_rad": _safe_min(traces["delta_yaw"]),
        "max_delta_yaw_rad": _safe_max(traces["delta_yaw"]),
        "max_abs_delta_x_m": _safe_max_abs(delta_x_trace),
        "max_abs_delta_y_m": _safe_max_abs(delta_y_trace),
        "max_abs_delta_yaw_rad": _safe_max_abs(traces["delta_yaw"]),
        "max_abs_imu_roll_rad": _safe_max_abs(traces["imu_roll"]),
        "max_abs_imu_pitch_rad": _safe_max_abs(traces["imu_pitch"]),
        "max_success_window_s": max_success_window_s,
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
        "controller_params": row.get("controller_params"),
        "success": row["success"],
        "failed": row["failed"],
        "terminated": row["terminated"],
        "termination_reason": row["termination_reason"],
        "steps": row["steps"],
        "final_torso_z_m": row["final_torso_z_m"],
        "final_tracked_z_m": row.get("final_tracked_z_m"),
        "final_delta_x_m": row["final_delta_x_m"],
        "max_delta_x_m": row.get("max_delta_x_m"),
        "final_delta_y_m": row["final_delta_y_m"],
        "max_delta_y_m": row.get("max_delta_y_m"),
        "final_delta_yaw_rad": row["final_delta_yaw_rad"],
        "max_delta_yaw_rad": row.get("max_delta_yaw_rad"),
        "max_abs_imu_roll_rad": row.get("max_abs_imu_roll_rad"),
        "max_abs_imu_pitch_rad": row.get("max_abs_imu_pitch_rad"),
        "max_success_window_s": row.get("max_success_window_s"),
        "tracked_body": row.get("diagnostics", {}).get("tracked_body"),
        "walk_eval": row.get("diagnostics", {}).get("walk_eval"),
        "progress_ratio": row["progress_ratio"],
        "unmet_success_predicates": row["diagnostics"]["unmet_success_predicates"],
        "candidate_score": row["candidate_score"],
    }


def _rollout(profile: str, task_id: str, *, max_steps: int) -> dict:
    task = load_curriculum().by_id(task_id)
    candidates = [
        _rollout_candidate(profile, task_id, max_steps=max_steps, primitive=primitive)
        for primitive in _primitive_specs(profile, task_id)
    ]
    passive = _rollout_candidate(
        profile,
        task_id,
        max_steps=max_steps,
        primitive=(
            _PrimitiveSpec("hold_initial_pose_baseline", 2.0, _make_hold_initial_pose_action)
            if task_id == "stand_up"
            else _PrimitiveSpec("zero_action_baseline", 0.3, _make_zero_action)
        ),
    )
    best = max(candidates, key=lambda row: row["candidate_score"])
    best = dict(best)
    active_success = bool(best["success"])
    passive_success = bool(passive["success"])
    invalid_reasons = []
    if passive_success:
        invalid_reasons.append("passive_baseline_also_succeeds")
    if active_success and _fell_during_candidate(best):
        invalid_reasons.append("active_candidate_fell")
    if (
        active_success
        and _uses_locomotion_displacement(task.success)
        and not _tracked_height_present(best)
    ):
        invalid_reasons.append("tracked_height_missing_for_locomotion")
    valid_success = active_success and not invalid_reasons
    best["candidate_results"] = [_candidate_summary(row) for row in candidates]
    best["passive_baseline"] = _candidate_summary(passive)
    best["active_success"] = active_success
    best["passive_success"] = passive_success
    best["valid_success"] = valid_success
    best["invalid_reasons"] = invalid_reasons
    best["success"] = valid_success
    best["diagnostics"] = dict(best["diagnostics"])
    best["diagnostics"]["candidate_results"] = best["candidate_results"]
    best["diagnostics"]["passive_baseline"] = best["passive_baseline"]
    best["diagnostics"]["active_success"] = active_success
    best["diagnostics"]["passive_success"] = passive_success
    best["diagnostics"]["valid_success"] = valid_success
    best["diagnostics"]["invalid_reasons"] = invalid_reasons
    return best


def validate(profile: str, tasks: tuple[str, ...], *, max_steps: int) -> dict:
    rows = [_rollout(profile, task, max_steps=max_steps) for task in tasks]
    return {
        "schema": "robot-task-feasibility-v1",
        "profile_id": profile,
        "controller": "hiwonder_bounded_walk_progress_plus_existing_primitives",
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
