#!/usr/bin/env python3
"""Render visual evidence for the strongest HiWonder near-walk candidate."""

from __future__ import annotations

import argparse
import json
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
from scripts.search_hiwonder_random_sine_gaits import (  # noqa: E402
    _apply_feedback as _apply_search_feedback,
)
from scripts.search_hiwonder_random_sine_gaits import (  # noqa: E402
    _hybrid_recovery_action,
)
from scripts.validate_task_feasibility import (  # noqa: E402
    _make_sinusoidal_action,
    _primitive_specs,
    _sample,
)


def _contact_sheet(frames: list[np.ndarray], *, n_cols: int = 4) -> np.ndarray:
    if not frames:
        raise ValueError("cannot create contact sheet without frames")
    chosen_indices = np.linspace(0, len(frames) - 1, min(len(frames), 8), dtype=int)
    chosen = [frames[int(index)] for index in chosen_indices]
    height, width = chosen[0].shape[:2]
    while len(chosen) % n_cols:
        chosen.append(np.zeros((height, width, 3), dtype=np.uint8))
    rows = [
        np.concatenate(chosen[index: index + n_cols], axis=1)
        for index in range(0, len(chosen), n_cols)
    ]
    return np.concatenate(rows, axis=0)


def _candidate_from_search_report(
    path: Path,
    *,
    section: str,
    selector: str,
) -> tuple[str, dict[str, Any]]:
    report = json.loads(path.read_text(encoding="utf-8"))
    section_report = report.get(section)
    if not isinstance(section_report, dict):
        raise ValueError(f"search report has no section {section!r}")
    candidate = section_report.get(selector)
    if not isinstance(candidate, dict):
        raise ValueError(f"search report section {section!r} has no candidate {selector!r}")
    params = candidate.get("controller_params")
    if not isinstance(params, dict):
        raise ValueError(f"candidate {candidate.get('controller')!r} has no controller_params")
    controller = str(candidate.get("controller") or f"{section}_{selector}")
    return controller, params


def render_candidate(
    *,
    controller: str,
    max_steps: int,
    out_dir: Path,
    width: int,
    height: int,
    fps: int,
    action_scale: float | None = None,
    feedback_pitch: float = 0.0,
    feedback_roll: float = 0.0,
    feedback_yaw: float = 0.0,
    candidate_params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        import imageio.v2 as imageio
        import mujoco
    except ImportError as exc:  # pragma: no cover - dependency gate
        raise RuntimeError("rendering requires mujoco and imageio[ffmpeg]") from exc

    specs = {spec.name: spec for spec in _primitive_specs("hiwonder-ainex", "walk_forward")}
    use_env_prior = controller == "env_hiwonder_sine_prior"
    use_search_candidate = candidate_params is not None
    if not use_env_prior and not use_search_candidate and controller not in specs:
        raise ValueError(
            f"unknown controller {controller!r}; available={sorted(specs) + ['env_hiwonder_sine_prior']}"
        )
    primitive = specs.get(controller)
    selected_action_scale = (
        1.0
        if use_search_candidate
        else
        float(action_scale)
        if action_scale is not None
        else 0.6991004812004398
        if use_env_prior
        else primitive.action_scale
    )
    env = TextConditionedProfileEnv(
        "hiwonder-ainex",
        ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=max_steps,
            domain_rand=False,
            action_scale=selected_action_scale,
            locomotion_action_prior="hiwonder_sine" if use_env_prior else "none",
            locomotion_prior_residual_scale=0.0 if use_env_prior else 1.0,
            locomotion_prior_feedback_pitch=feedback_pitch,
            locomotion_prior_feedback_roll=feedback_roll,
            locomotion_prior_feedback_yaw=feedback_yaw,
        ),
    )
    _, start_info = env.reset(seed=0)
    task = load_curriculum().by_id("walk_forward")
    checker = GoalChecker(task, episode_start_t_s=0.0)
    checker.update(
        _sample(
            0.0,
            {
                "root_x": env._episode_start_x,  # noqa: SLF001
                "root_y": env._episode_start_y,  # noqa: SLF001
                "torso_z": env._episode_start_torso_z,  # noqa: SLF001
                "root_yaw": env._episode_start_yaw,  # noqa: SLF001
                "tracked_x": env._episode_start_tracked_x,  # noqa: SLF001
                "tracked_y": env._episode_start_tracked_y,  # noqa: SLF001
                "tracked_z": env._episode_start_tracked_z,  # noqa: SLF001
                "tracked_body_name": env._tracked_body_name,  # noqa: SLF001
                "stand_height_m": env._stand_height_m,  # noqa: SLF001
            },
        )
    )
    if use_search_candidate:
        if action_scale is not None:
            candidate_params = dict(candidate_params)
            candidate_params["scale"] = float(action_scale)
        action_for_step = _make_sinusoidal_action(
            env,
            "walk_forward",
            params=candidate_params,
        )
    elif use_env_prior:
        def action_for_step(_step: int) -> np.ndarray:
            return np.zeros(env.action_space.shape, dtype=np.float32)
    else:
        action_for_step = primitive.factory(env, "walk_forward")
    renderer = mujoco.Renderer(env._model, height=height, width=width)  # noqa: SLF001
    frames: list[np.ndarray] = []
    telemetry: list[dict[str, Any]] = []
    last_info: dict[str, Any] = dict(start_info)
    result = None
    max_success_window_s = 0.0
    max_abs_pitch = 0.0
    max_abs_roll = 0.0
    max_abs_yaw = 0.0
    last_stance: str | None = None
    foot_switches = 0
    terminated = False
    truncated = False
    hybrid_start_pose: np.ndarray | None = None
    out_dir.mkdir(parents=True, exist_ok=True)
    video_path = out_dir / f"{controller}.mp4"
    contact_sheet_path = out_dir / f"{controller}_contact.jpg"
    report_path = out_dir / f"{controller}.json"
    markdown_path = out_dir / f"{controller}.md"
    writer = imageio.get_writer(
        video_path,
        fps=fps,
        codec="libx264",
        quality=8,
        macro_block_size=None,
    )
    try:
        for step in range(max_steps):
            hybrid_recovery = (
                candidate_params.get("hybrid_recovery")
                if isinstance(candidate_params, dict)
                else None
            )
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
                action = action_for_step(step)
                if use_search_candidate:
                    action = np.clip(
                        action * float(candidate_params.get("scale", 1.0)),
                        -1.0,
                        1.0,
                    )
                    if isinstance(hybrid_recovery, dict):
                        action *= float(hybrid_recovery.get("pre_scale", 1.0))
                    feedback = candidate_params.get("feedback")
                    if isinstance(feedback, dict):
                        action = _apply_search_feedback(
                            env,
                            action,
                            feedback,
                            step=step,
                        )
            if action is None:
                action = np.zeros(env.action_space.shape, dtype=np.float32)
            _, _, terminated, truncated, info = env.step(action)
            last_info = dict(info)
            last_info["terminated"] = terminated
            last_info["truncated"] = truncated
            result = checker.update(
                _sample((step + 1) * env.config.control_dt_s, last_info)
            )
            max_success_window_s = max(
                max_success_window_s,
                float(result.success_window_s),
            )
            max_abs_pitch = max(max_abs_pitch, abs(float(info.get("imu_pitch") or 0.0)))
            max_abs_roll = max(max_abs_roll, abs(float(info.get("imu_roll") or 0.0)))
            max_abs_yaw = max(max_abs_yaw, abs(float(info.get("delta_yaw") or 0.0)))
            stance = (
                "left"
                if info.get("left_foot_contact") and not info.get("right_foot_contact")
                else "right"
                if info.get("right_foot_contact") and not info.get("left_foot_contact")
                else None
            )
            if stance is not None:
                if last_stance is not None and stance != last_stance:
                    foot_switches += 1
                last_stance = stance
            renderer.update_scene(env._data)  # noqa: SLF001
            frame = renderer.render()
            frames.append(frame)
            writer.append_data(frame)
            telemetry.append(
                {
                    "step": step + 1,
                    "t_s": (step + 1) * env.config.control_dt_s,
                    "tracked_delta_x_m": info.get("tracked_delta_x"),
                    "tracked_delta_y_m": info.get("tracked_delta_y"),
                    "delta_yaw_rad": info.get("delta_yaw"),
                    "torso_z_m": info.get("torso_z"),
                    "tracked_z_m": info.get("tracked_z"),
                    "imu_pitch_rad": info.get("imu_pitch"),
                    "imu_roll_rad": info.get("imu_roll"),
                    "left_foot_contact": info.get("left_foot_contact"),
                    "right_foot_contact": info.get("right_foot_contact"),
                    "foot_contact_switch_count": info.get("foot_contact_switch_count"),
                    "raw_action_max_abs": info.get("raw_action_max_abs"),
                    "effective_action_max_abs": info.get("effective_action_max_abs"),
                    "success_predicate_now": info.get("success_predicate_now"),
                    "terminated": terminated,
                    "truncated": truncated,
                    "done_reason": info.get("done_reason"),
                }
            )
            if result.success or result.failed or terminated or truncated:
                break
    finally:
        writer.close()
        renderer.close()
    imageio.imwrite(contact_sheet_path, _contact_sheet(frames))
    final_dx = float(last_info.get("tracked_delta_x") or 0.0)
    final_dy = float(last_info.get("tracked_delta_y") or 0.0)
    final_yaw = float(last_info.get("delta_yaw") or 0.0)
    motion_evidence = final_dx >= 0.30 and abs(final_dy) <= 0.20 and abs(final_yaw) <= 0.40
    walking_success = bool(result.success) if result is not None else False
    report = {
        "schema": "hiwonder-near-gait-visual-evidence-v1",
        "profile_id": "hiwonder-ainex",
        "task_id": "walk_forward",
        "controller": controller,
        "action_scale": selected_action_scale,
        "candidate_params": candidate_params,
        "locomotion_action_prior": env.config.locomotion_action_prior,
        "locomotion_prior_feedback": {
            "pitch": feedback_pitch,
            "roll": feedback_roll,
            "yaw": feedback_yaw,
        },
        "video": str(video_path),
        "contact_sheet": str(contact_sheet_path),
        "max_steps": max_steps,
        "steps": len(telemetry),
        "motion_evidence": motion_evidence,
        "walking_success": walking_success,
        "terminated": bool(terminated),
        "truncated": bool(truncated),
        "done_reason": last_info.get("done_reason"),
        "final_tracked_delta_x_m": final_dx,
        "final_tracked_delta_y_m": final_dy,
        "final_delta_yaw_rad": final_yaw,
        "final_torso_z_m": last_info.get("torso_z"),
        "final_tracked_z_m": last_info.get("tracked_z"),
        "max_success_window_s": max_success_window_s,
        "max_abs_pitch_rad": max_abs_pitch,
        "max_abs_roll_rad": max_abs_roll,
        "max_abs_delta_yaw_rad": max_abs_yaw,
        "foot_contact_switches": foot_switches,
        "telemetry": telemetry,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(
        "\n".join(
            [
                "# HiWonder Near-gait Visual Evidence",
                "",
                f"Controller: `{controller}`",
                f"Motion evidence: `{motion_evidence}`",
                f"Walking success: `{walking_success}`",
                f"Termination: `{last_info.get('done_reason')}`",
                f"Action scale: `{selected_action_scale}`",
                f"Locomotion action prior: `{env.config.locomotion_action_prior}`",
                f"Locomotion prior feedback: `pitch={feedback_pitch}, roll={feedback_roll}, yaw={feedback_yaw}`",
                f"Final tracked dx m: `{final_dx}`",
                f"Final tracked dy m: `{final_dy}`",
                f"Final yaw rad: `{final_yaw}`",
                f"Max success window s: `{max_success_window_s}`",
                f"Max abs pitch rad: `{max_abs_pitch}`",
                f"Max abs roll rad: `{max_abs_roll}`",
                f"Max abs yaw rad: `{max_abs_yaw}`",
                f"Foot contact switches: `{foot_switches}`",
                f"Video: `{video_path}`",
                f"Contact sheet: `{contact_sheet_path}`",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controller", default="sinusoidal_seeded_3")
    parser.add_argument(
        "--search-report",
        type=Path,
        default=None,
        help="Replay a candidate from a random-sine search JSON report.",
    )
    parser.add_argument(
        "--search-section",
        default="hybrid_recovery_refinement",
        help="Section to read from --search-report.",
    )
    parser.add_argument(
        "--search-selector",
        default="best_by_success_window",
        help="Candidate key to read from --search-section.",
    )
    parser.add_argument("--max-steps", type=int, default=320)
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=240)
    parser.add_argument("--fps", type=int, default=50)
    parser.add_argument("--action-scale", type=float, default=None)
    parser.add_argument("--feedback-pitch", type=float, default=0.0)
    parser.add_argument("--feedback-roll", type=float, default=0.0)
    parser.add_argument("--feedback-yaw", type=float, default=0.0)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=ROOT / "evidence" / "hiwonder_near_gait_visual",
    )
    args = parser.parse_args(argv)
    candidate_params = None
    controller = args.controller
    if args.search_report is not None:
        controller, candidate_params = _candidate_from_search_report(
            args.search_report,
            section=args.search_section,
            selector=args.search_selector,
        )
    report = render_candidate(
        controller=controller,
        max_steps=args.max_steps,
        out_dir=args.out_dir,
        width=args.width,
        height=args.height,
        fps=args.fps,
        action_scale=args.action_scale,
        feedback_pitch=args.feedback_pitch,
        feedback_roll=args.feedback_roll,
        feedback_yaw=args.feedback_yaw,
        candidate_params=candidate_params,
    )
    print(json.dumps({k: v for k, v in report.items() if k != "telemetry"}, indent=2))
    return 0 if report["walking_success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
