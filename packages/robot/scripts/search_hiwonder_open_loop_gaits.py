#!/usr/bin/env python3
"""Search a small set of HiWonder open-loop gait candidates.

This is an evidence tool, not a trainer. It probes whether the current
profile environment has any simple, hand-coded forward-walk primitive that
can satisfy the curriculum walk-forward predicate before we spend more
training cycles.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.rl.text_conditioned.profile_env import TextConditionedProfileEnv  # noqa: E402
from scripts.validate_task_feasibility import (  # noqa: E402
    _make_bezier_action,
    _make_deterministic_action,
    _make_motion_clip_action,
    _PrimitiveSpec,
    _rollout_candidate,
)

_SEEDED_SINE_GAIT_PARAMS: tuple[dict[str, Any], ...] = (
    {
        "scale": 0.2,
        "hz": 1.6612673855144404,
        "hip_bias": -0.016157797776556238,
        "hip_amp": 0.06461216352438377,
        "knee_bias": 0.5528039388786287,
        "knee_amp": 0.10673188007965163,
        "knee_phase": -0.8389131443955216,
        "ank_bias": 0.1523157595605913,
        "ank_amp": 0.7459578715099496,
        "ank_phase": -1.2046467496404647,
        "roll_bias": 0.18717350321006276,
        "roll_amp": 0.2061271484984527,
        "ank_roll_amp": 0.052508258469113556,
        "roll_phase": -1.8950630106364779,
    },
    {
        "scale": 0.45,
        "hz": 0.8377427284390384,
        "hip_bias": 0.017972481914261373,
        "hip_amp": 0.6741062444878694,
        "knee_bias": 0.04402700711049856,
        "knee_amp": 0.6885067056272304,
        "knee_phase": -2.0148085853543636,
        "ank_bias": 0.2892783960840767,
        "ank_amp": 0.1205780477813267,
        "ank_phase": -1.0488361259091499,
        "roll_bias": 0.04648867278856639,
        "roll_amp": 0.4587415499926934,
        "ank_roll_amp": 0.059930859908079503,
        "roll_phase": -1.3854088670016809,
    },
    {
        "scale": 0.45,
        "hz": 2.072267972331382,
        "hip_bias": -0.12881803483050575,
        "hip_amp": 0.13328874414751374,
        "knee_bias": 0.21049030176274275,
        "knee_amp": 0.26927983881956463,
        "knee_phase": 2.7639377372947243,
        "ank_bias": 0.25816391792814997,
        "ank_amp": 0.20504246510786342,
        "ank_phase": -0.061655442585465625,
        "roll_bias": 0.02518954820944852,
        "roll_amp": 0.386456335100602,
        "ank_roll_amp": 0.1319629598185999,
        "roll_phase": 0.41568034622446515,
    },
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
        "hold_switch_step": 224,
        "hold_mode": "freeze",
        "hold_blend_steps": 0,
    },
)


def _make_sinusoidal_action(
    env: TextConditionedProfileEnv,
    _task_id: str,
    *,
    params: dict[str, Any],
) -> Callable[[int], np.ndarray]:
    last_action = np.zeros(env.action_space.shape, dtype=np.float32)

    def _sine_action(step: int) -> np.ndarray:
        t_s = step * env.config.control_dt_s
        phase = 2.0 * np.pi * params["hz"] * t_s + params.get("phase0", 0.0)
        action = np.zeros(env.action_space.shape, dtype=np.float32)
        for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
            name = joint.name.lower()
            side = 1.0 if name.startswith("l_") else -1.0
            value = 0.0
            if "hip_pitch" in name:
                value = params["hip_bias"] + side * params["hip_amp"] * np.sin(phase)
            elif "knee" in name:
                value = (
                    params["knee_bias"]
                    + side * params["knee_amp"] * np.sin(phase + params["knee_phase"])
                )
            elif "ank_pitch" in name:
                value = (
                    params["ank_bias"]
                    + side * params["ank_amp"] * np.sin(phase + params["ank_phase"])
                )
            elif "hip_roll" in name:
                value = (
                    side * params["roll_bias"]
                    + side * params["roll_amp"] * np.sin(phase + params["roll_phase"])
                )
            elif "ank_roll" in name:
                value = (
                    -side * params["roll_bias"]
                    + side
                    * params["ank_roll_amp"]
                    * np.sin(
                        phase
                        + params["roll_phase"]
                        + params.get("ank_roll_phase_delta", 0.0)
                    )
                )
            elif "hip_yaw" in name:
                value = side * params.get("yaw_amp", 0.0) * np.sin(
                    phase + params.get("yaw_phase", 0.0)
                )
            action[idx] = float(np.clip(value, -1.0, 1.0))
        return action

    def _hold_action() -> np.ndarray:
        if params.get("hold_mode") == "freeze":
            return last_action.copy()
        return np.zeros(env.action_space.shape, dtype=np.float32)

    def _action(step: int) -> np.ndarray:
        nonlocal last_action
        action = _sine_action(step)
        switch_step = params.get("hold_switch_step")
        if switch_step is not None and step >= int(switch_step):
            hold = _hold_action()
            blend_steps = int(params.get("hold_blend_steps", 0))
            if blend_steps > 0 and step < int(switch_step) + blend_steps:
                alpha = float(step - int(switch_step) + 1) / float(blend_steps)
                action = (1.0 - alpha) * action + alpha * hold
            else:
                action = hold
        last_action = action.copy()
        return action

    return _action


def _candidate_specs() -> list[_PrimitiveSpec]:
    specs = [
        _PrimitiveSpec("deterministic_smoke", 0.3, _make_deterministic_action),
        _PrimitiveSpec("deterministic_wide", 1.0, _make_deterministic_action),
        _PrimitiveSpec("motion_clip", 1.0, _make_motion_clip_action),
    ]
    for swing_height, cycle_hz, action_scale in (
        (0.02, 0.8, 0.3),
        (0.02, 1.5, 0.5),
        (0.04, 1.0, 0.3),
        (0.06, 1.25, 0.3),
        (0.08, 1.0, 1.0),
        (0.10, 1.5, 1.0),
    ):
        specs.append(
            _PrimitiveSpec(
                f"bezier_trim_s{float(swing_height):.2f}_h{float(cycle_hz):.2f}_a{float(action_scale):.2f}",
                action_scale,
                partial(
                    _make_bezier_action,
                    profile_controller=False,
                    swing_height=swing_height,
                    cycle_hz=cycle_hz,
                    stance_width=0.10,
                    foot_offset=0.0,
                ),
            )
        )
    for idx, params in enumerate(_SEEDED_SINE_GAIT_PARAMS):
        specs.append(
            _PrimitiveSpec(
                f"sinusoidal_seeded_{idx}",
                params["scale"],
                partial(_make_sinusoidal_action, params=params),
                dict(params),
            )
        )
    return specs


_WALK_FORWARD_THRESHOLDS = {
    "delta_x_m_min": 0.30,
    "max_lateral_drift_m": 0.20,
    "max_abs_delta_yaw_rad": 0.40,
    "hold_s": 1.0,
}


def _row_brief(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "controller": row.get("controller"),
        "success": row.get("success"),
        "failed": row.get("failed"),
        "terminated": row.get("terminated"),
        "termination_reason": row.get("termination_reason"),
        "final_delta_x_m": row.get("final_delta_x_m"),
        "max_delta_x_m": row.get("max_delta_x_m"),
        "max_abs_delta_y_m": row.get("max_abs_delta_y_m"),
        "max_abs_delta_yaw_rad": row.get("max_abs_delta_yaw_rad"),
        "max_success_window_s": row.get("max_success_window_s"),
        "unmet_success_predicates": row.get("diagnostics", {}).get(
            "unmet_success_predicates"
        ),
        "controller_params": row.get("controller_params"),
    }


def _forward_metric(row: dict[str, Any]) -> float:
    return float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0)


def _straight_enough(row: dict[str, Any]) -> bool:
    lateral = float(row.get("max_abs_delta_y_m") or 0.0)
    yaw = float(row.get("max_abs_delta_yaw_rad") or 0.0)
    return (
        lateral <= _WALK_FORWARD_THRESHOLDS["max_lateral_drift_m"]
        and yaw <= _WALK_FORWARD_THRESHOLDS["max_abs_delta_yaw_rad"]
    )


def _no_fall(row: dict[str, Any]) -> bool:
    return not bool(row.get("failed")) and not bool(row.get("terminated"))


def _failure_frontier(rows: list[dict[str, Any]]) -> dict[str, Any]:
    dx_min = _WALK_FORWARD_THRESHOLDS["delta_x_m_min"]
    forward_rows = [row for row in rows if _forward_metric(row) >= dx_min]
    straight_rows = [row for row in rows if _straight_enough(row)]
    no_fall_rows = [row for row in rows if _no_fall(row)]
    no_fall_straight_rows = [
        row for row in rows if _no_fall(row) and _straight_enough(row)
    ]
    forward_no_fall_rows = [
        row for row in forward_rows if _no_fall(row)
    ]
    forward_straight_rows = [
        row for row in forward_rows if _straight_enough(row)
    ]
    forward_no_fall_straight_rows = [
        row for row in forward_rows if _no_fall(row) and _straight_enough(row)
    ]
    if not forward_rows:
        primary_gap = "forward_displacement"
    elif not forward_straight_rows:
        primary_gap = "straightness"
    elif not forward_no_fall_straight_rows:
        primary_gap = "stability"
    else:
        primary_gap = "hold_window_or_other_predicates"
    by_forward = sorted(rows, key=_forward_metric, reverse=True)
    return {
        "thresholds": dict(_WALK_FORWARD_THRESHOLDS),
        "primary_gap": primary_gap,
        "n_forward_displacement_candidates": len(forward_rows),
        "n_straight_candidates": len(straight_rows),
        "n_no_fall_candidates": len(no_fall_rows),
        "n_no_fall_straight_candidates": len(no_fall_straight_rows),
        "n_forward_no_fall_candidates": len(forward_no_fall_rows),
        "n_forward_straight_candidates": len(forward_straight_rows),
        "n_forward_no_fall_straight_candidates": len(
            forward_no_fall_straight_rows
        ),
        "best_forward_any": _row_brief(by_forward[0] if by_forward else None),
        "best_forward_without_fall": _row_brief(
            max(no_fall_rows, key=_forward_metric) if no_fall_rows else None
        ),
        "best_forward_straight": _row_brief(
            max(straight_rows, key=_forward_metric) if straight_rows else None
        ),
        "best_forward_no_fall_straight": _row_brief(
            max(no_fall_straight_rows, key=_forward_metric)
            if no_fall_straight_rows
            else None
        ),
    }


def search(*, max_steps: int) -> dict[str, Any]:
    rows = [
        _rollout_candidate(
            "hiwonder-ainex",
            "walk_forward",
            max_steps=max_steps,
            primitive=spec,
        )
        for spec in _candidate_specs()
    ]
    by_score = sorted(rows, key=lambda row: float(row["candidate_score"]), reverse=True)
    by_forward = sorted(
        rows,
        key=lambda row: float(row.get("final_delta_x_m") or 0.0),
        reverse=True,
    )
    by_peak_forward = sorted(
        rows,
        key=lambda row: float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        reverse=True,
    )
    stable_rows = [row for row in rows if not row.get("terminated")]
    stable_by_peak_forward = sorted(
        stable_rows,
        key=lambda row: float(row.get("max_delta_x_m") or row.get("final_delta_x_m") or 0.0),
        reverse=True,
    )
    return {
        "schema": "hiwonder-open-loop-gait-search-v1",
        "profile_id": "hiwonder-ainex",
        "task_id": "walk_forward",
        "max_steps": max_steps,
        "n_candidates": len(rows),
        "n_success": sum(1 for row in rows if row["success"]),
        "any_success": any(row["success"] for row in rows),
        "best_by_score": by_score[0] if by_score else None,
        "best_by_forward_progress": by_forward[0] if by_forward else None,
        "best_by_peak_forward_progress": by_peak_forward[0] if by_peak_forward else None,
        "best_stable_by_peak_forward_progress": (
            stable_by_peak_forward[0] if stable_by_peak_forward else None
        ),
        "failure_frontier": _failure_frontier(rows),
        "candidates": rows,
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    best = report.get("best_by_score") if isinstance(report.get("best_by_score"), dict) else {}
    forward = (
        report.get("best_by_forward_progress")
        if isinstance(report.get("best_by_forward_progress"), dict)
        else {}
    )
    peak = (
        report.get("best_by_peak_forward_progress")
        if isinstance(report.get("best_by_peak_forward_progress"), dict)
        else {}
    )
    stable_peak = (
        report.get("best_stable_by_peak_forward_progress")
        if isinstance(report.get("best_stable_by_peak_forward_progress"), dict)
        else {}
    )
    frontier = (
        report.get("failure_frontier")
        if isinstance(report.get("failure_frontier"), dict)
        else {}
    )
    lines = [
        "# HiWonder Open-loop Gait Search",
        "",
        f"Any success: `{report.get('any_success')}`",
        f"Candidates: `{report.get('n_candidates')}`",
        "",
        "## Best By Score",
        "",
        f"- controller: `{best.get('controller')}`",
        f"- success: `{best.get('success')}`",
        f"- termination: `{best.get('termination_reason')}`",
        f"- final dx m: `{best.get('final_delta_x_m')}`",
        f"- final dy m: `{best.get('final_delta_y_m')}`",
        f"- final yaw rad: `{best.get('final_delta_yaw_rad')}`",
        f"- progress ratio: `{best.get('progress_ratio')}`",
        f"- reason: `{best.get('reason')}`",
        "",
        "## Best By Forward Progress",
        "",
        f"- controller: `{forward.get('controller')}`",
        f"- success: `{forward.get('success')}`",
        f"- termination: `{forward.get('termination_reason')}`",
        f"- final dx m: `{forward.get('final_delta_x_m')}`",
        f"- final dy m: `{forward.get('final_delta_y_m')}`",
        f"- final yaw rad: `{forward.get('final_delta_yaw_rad')}`",
        f"- progress ratio: `{forward.get('progress_ratio')}`",
        f"- reason: `{forward.get('reason')}`",
        "",
        "## Best By Peak Forward Progress",
        "",
        f"- controller: `{peak.get('controller')}`",
        f"- success: `{peak.get('success')}`",
        f"- termination: `{peak.get('termination_reason')}`",
        f"- final dx m: `{peak.get('final_delta_x_m')}`",
        f"- peak dx m: `{peak.get('max_delta_x_m')}`",
        f"- progress ratio: `{peak.get('progress_ratio')}`",
        f"- reason: `{peak.get('reason')}`",
        "",
        "## Best Stable By Peak Forward Progress",
        "",
        f"- controller: `{stable_peak.get('controller')}`",
        f"- success: `{stable_peak.get('success')}`",
        f"- termination: `{stable_peak.get('termination_reason')}`",
        f"- final dx m: `{stable_peak.get('final_delta_x_m')}`",
        f"- peak dx m: `{stable_peak.get('max_delta_x_m')}`",
        f"- progress ratio: `{stable_peak.get('progress_ratio')}`",
        f"- reason: `{stable_peak.get('reason')}`",
        "",
        "## Failure Frontier",
        "",
        f"- primary gap: `{frontier.get('primary_gap')}`",
        f"- forward-displacement candidates: `{frontier.get('n_forward_displacement_candidates')}`",
        f"- forward + no-fall candidates: `{frontier.get('n_forward_no_fall_candidates')}`",
        f"- forward + straight candidates: `{frontier.get('n_forward_straight_candidates')}`",
        f"- forward + no-fall + straight candidates: `{frontier.get('n_forward_no_fall_straight_candidates')}`",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-steps", type=int, default=250)
    parser.add_argument(
        "--out-json",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_open_loop_gait_search.json",
    )
    parser.add_argument(
        "--out-md",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_open_loop_gait_search.md",
    )
    args = parser.parse_args(argv)

    report = search(max_steps=args.max_steps)
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(args.out_md, report)
    print(json.dumps(report, indent=2))
    return 0 if report["any_success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
