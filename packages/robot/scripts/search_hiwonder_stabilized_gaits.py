#!/usr/bin/env python3
"""Probe whether the best HiWonder near-gait can be stabilized after moving.

The current best open-loop gait reaches the walk-forward displacement predicate
briefly and then falls. This evidence tool tries small, reproducible transition
strategies around that near-gait: freeze the command, ramp to zero command, or
snapshot the current joint pose. A passing result would be real walking evidence;
a failing result documents the remaining hold/no-fall gap.
"""

from __future__ import annotations

import argparse
import json
import sys
from copy import deepcopy
from functools import partial
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_task_feasibility import (  # noqa: E402
    _HIWONDER_FORWARD_SINE_PARAMS,
    _make_sinusoidal_action,
    _PrimitiveSpec,
    _rollout_candidate,
)


def _make_snapshot_hold_action(env, task_id: str, *, params: dict[str, Any]):
    sine_params = {
        key: value
        for key, value in params.items()
        if not key.startswith("snapshot_")
        and key not in {"hold_switch_step", "hold_mode", "hold_blend_steps"}
    }
    sine_action = _make_sinusoidal_action(env, task_id, params=sine_params)
    switch_step = int(params["snapshot_switch_step"])
    blend_steps = int(params.get("snapshot_blend_steps", 0))
    held_action: np.ndarray | None = None
    action_scale = max(float(env.config.action_scale), 1e-6)

    def _action(step: int) -> np.ndarray:
        nonlocal held_action
        live_action = sine_action(step)
        if step < switch_step:
            return live_action
        if held_action is None:
            joint_pose = np.array(
                [env._data.qpos[qpos_idx] for qpos_idx in env._joint_qpos_idx],  # noqa: SLF001
                dtype=np.float32,
            )
            held_action = np.clip(
                (joint_pose - env._home_pose.astype(np.float32)) / action_scale,  # noqa: SLF001
                -1.0,
                1.0,
            ).astype(np.float32)
        if blend_steps > 0 and step < switch_step + blend_steps:
            alpha = float(step - switch_step + 1) / float(blend_steps)
            return ((1.0 - alpha) * live_action + alpha * held_action).astype(
                np.float32
            )
        return held_action

    return _action


def _candidate_specs() -> list[_PrimitiveSpec]:
    base = deepcopy(_HIWONDER_FORWARD_SINE_PARAMS[1])
    specs: list[_PrimitiveSpec] = []
    for switch_step in (216, 224, 232):
        for hold_mode, blend_steps in (
            ("freeze", 0),
            ("freeze", 8),
            ("zero", 8),
        ):
            params = deepcopy(base)
            params["hold_switch_step"] = switch_step
            params["hold_mode"] = hold_mode
            params["hold_blend_steps"] = blend_steps
            specs.append(
                _PrimitiveSpec(
                    f"sine_{hold_mode}_s{switch_step}_b{blend_steps}",
                    float(params["scale"]),
                    partial(_make_sinusoidal_action, params=params),
                    dict(params),
                )
            )
    for switch_step in (214, 230, 238):
        for blend_steps in (0, 8, 20):
            params = deepcopy(base)
            params["snapshot_switch_step"] = switch_step
            params["snapshot_blend_steps"] = blend_steps
            specs.append(
                _PrimitiveSpec(
                    f"snapshot_hold_s{switch_step}_b{blend_steps}",
                    float(params["scale"]),
                    partial(_make_snapshot_hold_action, params=params),
                    dict(params),
                )
            )
    return specs


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
    by_window = sorted(
        rows,
        key=lambda row: (
            bool(row.get("success")),
            float(row.get("max_success_window_s") or 0.0),
            not bool(row.get("failed")),
            float(row.get("final_delta_x_m") or 0.0),
        ),
        reverse=True,
    )
    by_forward = sorted(
        rows,
        key=lambda row: float(row.get("final_delta_x_m") or 0.0),
        reverse=True,
    )
    return {
        "schema": "hiwonder-stabilized-gait-search-v1",
        "profile_id": "hiwonder-ainex",
        "task_id": "walk_forward",
        "max_steps": max_steps,
        "n_candidates": len(rows),
        "n_success": sum(1 for row in rows if row.get("success") is True),
        "any_success": any(row.get("success") is True for row in rows),
        "best_by_success_window": by_window[0] if by_window else None,
        "best_by_forward_progress": by_forward[0] if by_forward else None,
        "candidates": rows,
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    best_window = (
        report.get("best_by_success_window")
        if isinstance(report.get("best_by_success_window"), dict)
        else {}
    )
    best_forward = (
        report.get("best_by_forward_progress")
        if isinstance(report.get("best_by_forward_progress"), dict)
        else {}
    )
    lines = [
        "# HiWonder Stabilized Gait Search",
        "",
        f"Any success: `{report.get('any_success')}`",
        f"Candidates: `{report.get('n_candidates')}`",
        f"Best success window s: `{best_window.get('max_success_window_s')}`",
        f"Best success-window controller: `{best_window.get('controller')}`",
        f"Best success-window final dx m: `{best_window.get('final_delta_x_m')}`",
        f"Best success-window termination: `{best_window.get('termination_reason')}`",
        f"Best success-window unmet predicates: `{', '.join(best_window.get('diagnostics', {}).get('unmet_success_predicates') or []) or 'none'}`",
        "",
        f"Best forward controller: `{best_forward.get('controller')}`",
        f"Best forward final dx m: `{best_forward.get('final_delta_x_m')}`",
        f"Best forward success window s: `{best_forward.get('max_success_window_s')}`",
        f"Best forward termination: `{best_forward.get('termination_reason')}`",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-steps", type=int, default=360)
    parser.add_argument(
        "--out-json",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_stabilized_gait_search.json",
    )
    parser.add_argument(
        "--out-md",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_stabilized_gait_search.md",
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
