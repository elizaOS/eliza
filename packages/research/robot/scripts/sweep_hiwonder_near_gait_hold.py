#!/usr/bin/env python3
"""Sweep hold/recovery variants for the strongest HiWonder near-gait candidate."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    TextConditionedProfileEnv,
)
from scripts.render_hiwonder_near_gait_evidence import (  # noqa: E402
    _candidate_from_search_report,
)
from scripts.search_hiwonder_random_sine_gaits import (  # noqa: E402
    HYBRID_BRACED_RECOVERY_PARAMS,
    _rollout_candidate,
)


def _rank_key(row: dict[str, Any]) -> tuple[float, float, float, float]:
    diagnostics = row.get("diagnostics", {})
    unmet = set(diagnostics.get("unmet_success_predicates") or [])
    dx = float(row.get("final_delta_x_m") or 0.0)
    success_window = float(row.get("max_success_window_s") or 0.0)
    yaw = abs(float(row.get("max_abs_delta_yaw_rad") or 0.0))
    fall_penalty = 1.0 if "no_fall" in unmet else 0.0
    return (
        1.0 if bool(row.get("success")) else 0.0,
        success_window,
        min(dx, 0.30),
        -yaw - fall_penalty,
    )


def _physical_side_gate_key(row: dict[str, Any]) -> tuple[float, float, float, float]:
    diagnostics = row.get("diagnostics", {})
    unmet = set(diagnostics.get("unmet_success_predicates") or [])
    dx = float(row.get("final_delta_x_m") or 0.0)
    success_window = float(row.get("max_success_window_s") or 0.0)
    side_gate_failures = sum(
        1
        for key in (
            "torso_z_min_ratio",
            "max_lateral_drift_m",
            "max_abs_delta_yaw_rad",
            "min_alternating_foot_contacts",
            "min_swing_foot_clearance_m",
            "max_foot_slip_m_s",
            "max_self_collision_count",
        )
        if key in unmet
    )
    hard_failures = sum(1 for key in ("no_fall", "hold_s") if key in unmet)
    return (
        -float(side_gate_failures),
        min(dx, 0.30),
        success_window,
        -float(hard_failures),
    )


def _raw_distance_key(row: dict[str, Any]) -> tuple[float, float, float, float]:
    dx = max(
        float(row.get("max_delta_x_m") or 0.0),
        float(row.get("final_delta_x_m") or 0.0),
        float(row.get("post_goal_failure_max_delta_x_m") or 0.0),
    )
    yaw = abs(float(row.get("max_abs_delta_yaw_rad") or 0.0))
    slip = float(row.get("max_foot_slip_m_s") or 0.0)
    collision = float(row.get("max_self_collision_count") or 0.0)
    return (dx, -yaw, -slip, -collision)


def _candidate_entries_from_search_report(
    path: Path,
    *,
    section: str,
    selector: str,
    top_k: int = 1,
    rank: str = "physical-gates",
) -> list[tuple[str, dict[str, Any]]]:
    if top_k <= 1:
        return [
            _candidate_from_search_report(
                path,
                section=section,
                selector=selector,
            )
        ]
    report = json.loads(path.read_text(encoding="utf-8"))
    section_report = report.get(section)
    if not isinstance(section_report, dict):
        raise ValueError(f"search report has no section {section!r}")
    candidates = section_report.get("candidates")
    if not isinstance(candidates, list):
        raise ValueError(
            f"search report section {section!r} has no candidates list for top-k sweep"
        )
    rows = [row for row in candidates if isinstance(row, dict)]
    if rank == "success-window":
        rows = sorted(rows, key=_rank_key, reverse=True)
    elif rank == "physical-gates":
        rows = sorted(rows, key=_physical_side_gate_key, reverse=True)
    else:
        raise ValueError("rank must be one of: physical-gates, success-window")
    entries = []
    for row in rows[:top_k]:
        params = row.get("controller_params")
        if not isinstance(params, dict):
            continue
        entries.append((str(row.get("controller") or f"{section}_candidate"), params))
    if not entries:
        raise ValueError(
            f"search report section {section!r} has no top-k candidates with controller_params"
        )
    return entries


def _variants(
    base: dict[str, Any],
    *,
    mode: str,
) -> list[tuple[str, dict[str, Any]]]:
    variants: list[tuple[str, dict[str, Any]]] = []
    if mode not in {"quick", "base", "late", "full"}:
        raise ValueError("mode must be one of: quick, base, late, full")
    scales = (0.74, 0.82) if mode == "quick" else (0.62, 0.68, 0.74, 0.78, 0.82)
    for scale in scales:
        params = dict(base)
        params["scale"] = scale
        variants.append((f"scale_{scale:.2f}", params))
        switch_steps = (28, 34) if mode == "quick" else (28, 30, 32, 34, 36)
        for switch_step in switch_steps:
            for hold_mode in ("freeze", "zero"):
                blend_options = (0, 4) if mode == "quick" else (0, 4, 8)
                for blend_steps in blend_options:
                    params = dict(base)
                    params.update(
                        {
                            "scale": scale,
                            "hold_switch_step": switch_step,
                            "hold_mode": hold_mode,
                            "hold_blend_steps": blend_steps,
                        }
                    )
                    variants.append(
                        (
                            f"scale_{scale:.2f}_{hold_mode}_s{switch_step}_b{blend_steps}",
                            params,
                        )
                    )
        switch_dx_options = (
            (0.20, 0.28)
            if mode == "quick"
            else (0.18, 0.20, 0.22, 0.24, 0.26, 0.28)
        )
        ramp_options = (2, 8) if mode == "quick" else (1, 2, 4, 8, 12)
        for switch_dx in switch_dx_options:
            for ramp_steps in ramp_options:
                params = dict(base)
                params.update(
                    {
                        "scale": scale,
                        "hybrid_recovery": {
                            "switch_dx": switch_dx,
                            "max_switch_step": 36,
                            "ramp_steps": ramp_steps,
                            "pitch_gain": 2.0,
                            "roll_gain": 2.0,
                            "yaw_gain": 0.5,
                            "pre_scale": 1.0,
                            "post_bias": 0.0,
                        },
                    }
                )
                variants.append(
                    (
                        f"scale_{scale:.2f}_hybrid_dx{switch_dx:.2f}_r{ramp_steps}",
                        params,
                    )
                )
                templates = (
                    HYBRID_BRACED_RECOVERY_PARAMS[:1]
                    if mode == "quick"
                    else HYBRID_BRACED_RECOVERY_PARAMS
                )
                for index, template in enumerate(templates):
                    recovery = dict(template.get("hybrid_recovery") or {})
                    if not recovery:
                        continue
                    recovery.update(
                        {
                            "switch_dx": switch_dx,
                            "max_switch_step": 40,
                            "ramp_steps": ramp_steps,
                        }
                    )
                    params = dict(base)
                    params["scale"] = scale
                    params["hybrid_recovery"] = recovery
                    feedback = template.get("feedback")
                    if isinstance(feedback, dict):
                        params["feedback"] = dict(feedback)
                    variants.append(
                        (
                            f"scale_{scale:.2f}_braced{index}_dx{switch_dx:.2f}_r{ramp_steps}",
                            params,
                    )
                )
    if mode == "base":
        return variants
    late_scales = (0.82, 0.90) if mode == "quick" else (0.78, 0.82, 0.86, 0.90)
    for scale in late_scales:
        late_switch_steps = (34, 40) if mode == "quick" else (30, 32, 34, 36, 38, 40)
        for switch_step in late_switch_steps:
            for hold_mode in ("zero", "freeze"):
                late_blend_options = (0, 4) if mode == "quick" else (0, 2, 4)
                for blend_steps in late_blend_options:
                    params = dict(base)
                    params.update(
                        {
                            "scale": scale,
                            "hold_switch_step": switch_step,
                            "hold_mode": hold_mode,
                            "hold_blend_steps": blend_steps,
                        }
                    )
                    variants.append(
                        (
                            f"late_scale_{scale:.2f}_{hold_mode}_s{switch_step}_b{blend_steps}",
                            params,
                        )
                    )
        recovery_templates = (
            {
                "pitch_gain": 1.5,
                "roll_gain": 0.5,
                "yaw_gain": 0.0,
                "post_bias": 0.0,
                "knee_bias": 0.10,
                "hip_pitch_bias": -0.10,
                "ank_pitch_bias": 0.10,
                "hip_roll_bias": 0.0,
                "ank_roll_bias": 0.0,
            },
            {
                "pitch_gain": 2.0,
                "roll_gain": 0.5,
                "yaw_gain": 0.0,
                "post_bias": 0.0,
                "knee_bias": 0.20,
                "hip_pitch_bias": -0.10,
                "ank_pitch_bias": 0.20,
                "hip_roll_bias": 0.0,
                "ank_roll_bias": 0.0,
            },
            {
                "pitch_gain": 2.5,
                "roll_gain": 0.5,
                "yaw_gain": 0.0,
                "post_bias": 0.0,
                "knee_bias": 0.30,
                "hip_pitch_bias": -0.20,
                "ank_pitch_bias": 0.30,
                "hip_roll_bias": 0.0,
                "ank_roll_bias": 0.0,
            },
            {
                "pitch_gain": 2.0,
                "roll_gain": 1.0,
                "yaw_gain": -0.5,
                "post_bias": -0.05,
                "knee_bias": 0.20,
                "hip_pitch_bias": -0.10,
                "ank_pitch_bias": 0.20,
                "hip_roll_bias": -0.10,
                "ank_roll_bias": -0.10,
            },
            {
                "pitch_gain": 3.0,
                "roll_gain": 1.0,
                "yaw_gain": 0.5,
                "post_bias": 0.05,
                "knee_bias": 0.30,
                "hip_pitch_bias": -0.20,
                "ank_pitch_bias": 0.30,
                "hip_roll_bias": 0.10,
                "ank_roll_bias": 0.10,
            },
            {
                "pitch_gain": 2.0,
                "roll_gain": 0.0,
                "yaw_gain": 0.0,
                "post_bias": 0.0,
                "knee_bias": 0.20,
                "hip_pitch_bias": 0.0,
                "ank_pitch_bias": 0.20,
                "hip_roll_bias": 0.0,
                "ank_roll_bias": 0.0,
            },
        )
        late_switch_dx = (
            (0.270, 0.295)
            if mode == "quick"
            else (0.270, 0.280, 0.285, 0.290, 0.295)
        )
        late_max_switch_steps = (36, 40) if mode == "quick" else (34, 36, 38, 40)
        late_ramp_steps = (2,) if mode == "quick" else (1, 2, 4)
        late_pre_scales = (0.95,) if mode == "quick" else (0.95, 1.0, 1.05)
        active_templates = recovery_templates[:3] if mode == "quick" else recovery_templates
        for switch_dx in late_switch_dx:
            for max_switch_step in late_max_switch_steps:
                for ramp_steps in late_ramp_steps:
                    for pre_scale in late_pre_scales:
                        for template_index, template in enumerate(active_templates):
                            recovery = {
                                "switch_dx": switch_dx,
                                "max_switch_step": max_switch_step,
                                "ramp_steps": ramp_steps,
                                "pre_scale": pre_scale,
                                **template,
                            }
                            params = dict(base)
                            params["scale"] = scale
                            params["hybrid_recovery"] = recovery
                            variants.append(
                                (
                                    "late_scale_"
                                    f"{scale:.2f}_stance{template_index}_"
                                    f"dx{switch_dx:.3f}_m{max_switch_step}_"
                                    f"r{ramp_steps}_pre{pre_scale:.2f}",
                                    params,
                                )
                            )
    return variants


def sweep(
    *,
    search_report: Path,
    search_section: str,
    search_selector: str,
    top_k: int,
    top_k_rank: str,
    max_steps: int,
    variant_mode: str,
    continue_after_goal_failure: bool,
    out_dir: Path,
) -> dict[str, Any]:
    candidate_entries = _candidate_entries_from_search_report(
        search_report,
        section=search_section,
        selector=search_selector,
        top_k=top_k,
        rank=top_k_rank,
    )
    env = TextConditionedProfileEnv(
        "hiwonder-ainex",
        ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=max_steps,
            domain_rand=False,
        ),
    )
    rows = []
    for controller, base_params in candidate_entries:
        for name, params in _variants(base_params, mode=variant_mode):
            rows.append(
                _rollout_candidate(
                    env,
                    name=f"{controller}__{name}",
                    params=params,
                    max_steps=max_steps,
                    continue_after_goal_failure=continue_after_goal_failure,
                )
            )
    ranked = sorted(rows, key=_rank_key, reverse=True)
    side_gate_ranked = sorted(rows, key=_physical_side_gate_key, reverse=True)
    raw_distance_ranked = sorted(rows, key=_raw_distance_key, reverse=True)
    best = ranked[0] if ranked else None
    report = {
        "schema": "hiwonder-near-gait-hold-sweep-v1",
        "source_report": str(search_report),
        "source_section": search_section,
        "source_selector": search_selector,
        "top_k": top_k,
        "top_k_rank": top_k_rank,
        "source_controllers": [controller for controller, _params in candidate_entries],
        "source_controller": candidate_entries[0][0],
        "max_steps": max_steps,
        "variant_mode": variant_mode,
        "continue_after_goal_failure": continue_after_goal_failure,
        "n_variants": len(rows),
        "any_success": any(bool(row.get("success")) for row in rows),
        "best": best,
        "best_by_physical_side_gates": side_gate_ranked[0] if side_gate_ranked else None,
        "best_by_raw_distance": raw_distance_ranked[0] if raw_distance_ranked else None,
        "top_20": ranked[:20],
        "top_20_by_physical_side_gates": side_gate_ranked[:20],
        "top_20_by_raw_distance": raw_distance_ranked[:20],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "hiwonder_near_gait_hold_sweep.json"
    md_path = out_dir / "hiwonder_near_gait_hold_sweep.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# HiWonder Near-gait Hold Sweep",
        "",
        f"Source controller: `{candidate_entries[0][0]}`",
        f"Source controllers: `{', '.join(controller for controller, _params in candidate_entries)}`",
        f"Top-k: `{top_k}`",
        f"Top-k rank: `{top_k_rank}`",
        f"Variants: `{len(rows)}`",
        f"Any success: `{report['any_success']}`",
    ]
    if best is not None:
        lines.extend(
            [
                f"Best controller: `{best.get('controller')}`",
                f"Best success: `{best.get('success')}`",
                f"Best final dx m: `{best.get('final_delta_x_m')}`",
                f"Best max yaw rad: `{best.get('max_abs_delta_yaw_rad')}`",
                f"Best success window s: `{best.get('max_success_window_s')}`",
                f"Best unmet predicates: `{', '.join(best.get('diagnostics', {}).get('unmet_success_predicates') or [])}`",
            ]
        )
    best_raw = report["best_by_raw_distance"]
    if best_raw is not None:
        lines.extend(
            [
                f"Best raw-distance controller: `{best_raw.get('controller')}`",
                f"Best raw-distance final dx m: `{best_raw.get('final_delta_x_m')}`",
                f"Best raw-distance max dx m: `{best_raw.get('max_delta_x_m')}`",
                f"Best raw-distance max yaw rad: `{best_raw.get('max_abs_delta_yaw_rad')}`",
                f"Best raw-distance unmet predicates: `{', '.join(best_raw.get('diagnostics', {}).get('unmet_success_predicates') or [])}`",
            ]
        )
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    report["json"] = str(json_path)
    report["markdown"] = str(md_path)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--search-report",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_random_sine_gait_search_current.json",
    )
    parser.add_argument("--search-section", default="feedback_refinement")
    parser.add_argument("--search-selector", default="best_by_success_window")
    parser.add_argument(
        "--top-k",
        type=int,
        default=1,
        help=(
            "when >1, ignore search-selector candidate contents and sweep the "
            "top candidates list from search-section"
        ),
    )
    parser.add_argument(
        "--top-k-rank",
        choices=("physical-gates", "success-window"),
        default="physical-gates",
    )
    parser.add_argument("--max-steps", type=int, default=160)
    parser.add_argument(
        "--variant-mode",
        choices=("quick", "base", "late", "full"),
        default="full",
    )
    parser.add_argument(
        "--continue-after-goal-failure",
        action="store_true",
        help=(
            "diagnostic only: keep rolling after GoalChecker failure while "
            "latching strict failure; env termination still stops the rollout"
        ),
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_near_gait_hold_sweep",
    )
    args = parser.parse_args(argv)
    report = sweep(
        search_report=args.search_report,
        search_section=args.search_section,
        search_selector=args.search_selector,
        top_k=args.top_k,
        top_k_rank=args.top_k_rank,
        max_steps=args.max_steps,
        variant_mode=args.variant_mode,
        continue_after_goal_failure=args.continue_after_goal_failure,
        out_dir=args.out_dir,
    )
    print(json.dumps({k: v for k, v in report.items() if k != "top_20"}, indent=2))
    return 0 if report["any_success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
