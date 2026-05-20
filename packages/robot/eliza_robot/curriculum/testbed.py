"""Per-task testbed: run a single curriculum task, capture telemetry,
evaluate with GoalChecker, record video + report.

Used both:
  - during training (env-side eval rollouts)
  - during deployment (deployment regression: did the on-policy run still
    pass on sim and on real?)

Backend-agnostic: pass any `BridgeBackend`-conforming object. Real-robot
runs pull frames from the AiNex onboard camera via `snapshot_camera`;
sim runs pull from `DemoEnv.render_external()` if available, falling
back to `render_ego()`.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.curriculum.goal_checker import (
    GoalChecker,
    GoalResult,
    TelemetrySample,
)
from eliza_robot.curriculum.loader import Curriculum, TaskSpec, load_curriculum


@dataclass
class RunReport:
    task_id: str
    success: bool
    failed: bool
    reason: str
    elapsed_s: float
    samples: int
    started_at: float
    finished_at: float
    backend: str
    notes: dict[str, Any] = field(default_factory=dict)


async def _send(backend: BridgeBackend, cmd: str, payload: dict, preempt: bool = False) -> Any:
    rid = f"tb-{cmd}-{time.time_ns()}"
    envelope = CommandEnvelope(
        request_id=rid,
        timestamp=utc_now_iso(),
        command=cmd,
        payload=payload,
        preempt=preempt,
    )
    return await backend.handle_command(envelope)


def _sample_from_telemetry(t_s: float, data: dict, env: Any | None = None) -> TelemetrySample:
    """Build a TelemetrySample from a `telemetry.basic` event payload + optional env."""
    s = TelemetrySample(
        t_s=t_s,
        imu_roll_rad=float(data.get("imu_roll", 0.0)),
        imu_pitch_rad=float(data.get("imu_pitch", 0.0)),
        head_pan_rad=float(data.get("head_pan", 0.0)),
        head_tilt_rad=float(data.get("head_tilt", 0.0)),
        walk_speed=int(data.get("walk_speed", 0)),
        is_walking=bool(data.get("is_walking", False)),
    )
    jp = data.get("joint_positions")
    if isinstance(jp, dict):
        s.joint_positions = {k: float(v) for k, v in jp.items()}
    # Pull ground-truth pose from MuJoCo env when available.
    if env is not None:
        try:
            pos = env.get_robot_position()
            s.torso_x_m = float(pos[0])
            s.torso_y_m = float(pos[1])
            s.torso_z_m = float(pos[2])
            s.yaw_rad = float(env.get_robot_yaw())
            s.target_distance_m = float(env.distance_to_target())
        except Exception:
            pass
    return s


def _build_drive_command(task: TaskSpec, t_s: float) -> tuple[str, dict] | None:
    """Map a curriculum task to a programmatic bridge command that
    approximates the desired motion. This is what the testbed uses *until*
    a trained text-conditioned policy is loaded; once a checkpoint exists,
    we drive via `policy.start` instead and let the policy issue
    `policy.tick`s.

    Returns None when the task can't be approximated programmatically
    (those need the trained policy to evaluate).
    """
    r = task.reward
    if task.id == "stand_up" or task.id == "stand":
        return ("action.play", {"name": "stand"})
    if task.id == "sit_down":
        return ("action.play", {"name": "sit"})
    if task.id == "walk_forward":
        return ("walk.set", {
            "speed": 2, "height": 0.036,
            "x": float(r.get("target_velocity_x_m_s", 0.04) * 0.5),
            "y": 0.0, "yaw": 0.0,
        })
    if task.id == "walk_backward":
        return ("walk.set", {
            "speed": 2, "height": 0.036,
            "x": float(r.get("target_velocity_x_m_s", -0.03)),
            "y": 0.0, "yaw": 0.0,
        })
    if task.id == "sidestep_left":
        return ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.03, "yaw": 0.0})
    if task.id == "sidestep_right":
        return ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": -0.03, "yaw": 0.0})
    if task.id == "turn_left":
        return ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": 4.0})
    if task.id == "turn_right":
        return ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": -4.0})
    if task.id == "turn_around":
        return ("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": -8.0})
    if task.id == "look_up":
        return ("head.set", {"pan": 0.0, "tilt": float(r.get("head_tilt_target_rad", 0.6)), "duration": 0.5})
    if task.id == "look_down":
        return ("head.set", {"pan": 0.0, "tilt": float(r.get("head_tilt_target_rad", -0.5)), "duration": 0.5})
    if task.id == "wave_left" or task.id == "wave_right":
        return ("action.play", {"name": "wave"})
    return None


async def run_task(
    backend: BridgeBackend,
    task: TaskSpec,
    *,
    env: Any | None = None,
    use_policy_start: bool = False,
    video_writer: Any | None = None,
    render_fn: Any | None = None,
    fps: float = 30.0,
    verbose: bool = True,
) -> RunReport:
    """Run a single curriculum task and return its outcome.

    Args:
        backend: connected BridgeBackend.
        task: TaskSpec from the curriculum.
        env: optional DemoEnv for ground-truth pose readout (sim only).
        use_policy_start: if True, dispatch `policy.start{task=task.id}`
            (text-conditioned mode). Otherwise approximate the task with
            a programmatic command.
        video_writer: optional cv2.VideoWriter; if given, render_fn() is
            invoked every tick and written to it.
        render_fn: callable returning an RGB frame; defaults to None.
    """
    started_at = time.time()
    checker = GoalChecker(task, episode_start_t_s=started_at)
    # Pre-action: try to be in a reasonable starting state.
    if task.init_state == "prone":
        await _send(backend, "action.play", {"name": "sit"})
        await asyncio.sleep(2.0)
    else:
        await _send(backend, "action.play", {"name": "stand"})
        await asyncio.sleep(1.0)

    # Drive the task.
    if use_policy_start:
        await _send(backend, "policy.start", {
            "task": task.id, "canonical_action": task.id,
            "hz": 10, "max_steps": int(task.max_episode_s * 50),
        })
    else:
        drive = _build_drive_command(task, started_at)
        if drive is not None:
            await _send(backend, *drive)
            if drive[0] == "walk.set":
                await _send(backend, "walk.command", {"action": "start"})

    last_event_t = time.time()
    sample_period = 0.05  # 20 Hz sampling
    frame_interval = 1.0 / fps
    next_frame_t = time.time()
    final: GoalResult = GoalResult()
    while time.time() - started_at < task.max_episode_s + 1.0:
        # Pull whatever telemetry is fresh.
        events = await backend.poll_events()
        for ev in events:
            if ev.event == "telemetry.basic":
                s = _sample_from_telemetry(time.time(), ev.data, env=env)
                final = checker.update(s)
                if final.success or final.failed:
                    break
        if final.success or final.failed:
            break

        # Write a video frame if rendering is configured.
        if video_writer is not None and render_fn is not None and time.time() >= next_frame_t:
            try:
                frame = render_fn()
                video_writer.write(frame)
            except Exception:
                pass
            next_frame_t += frame_interval

        await asyncio.sleep(sample_period)

    # Always stop walking + return to stand.
    await _send(backend, "walk.command", {"action": "stop"}, preempt=True)
    if use_policy_start:
        await _send(backend, "policy.stop", {"reason": "task_done"})
    await _send(backend, "action.play", {"name": "stand"})

    finished_at = time.time()
    if verbose:
        verdict = "PASS" if final.success else ("FAIL" if final.failed else "TIMEOUT")
        print(
            f"[testbed] {task.id:24s} {verdict:7s} "
            f"{final.elapsed_s:0.2f}s  reason={final.reason!r}"
        )
    return RunReport(
        task_id=task.id,
        success=final.success,
        failed=final.failed,
        reason=final.reason,
        elapsed_s=final.elapsed_s,
        samples=len(checker.samples),
        started_at=started_at,
        finished_at=finished_at,
        backend=backend.backend_name,
        notes={"hold_window_s": final.success_window_s},
    )


async def run_curriculum(
    backend: BridgeBackend,
    curriculum: Curriculum | None = None,
    *,
    tier: int | None = None,
    only: list[str] | None = None,
    env: Any | None = None,
    use_policy_start: bool = False,
    out_dir: Path | None = None,
) -> list[RunReport]:
    """Run a subset of the curriculum and write a JSON summary."""
    curriculum = curriculum or load_curriculum()
    tasks = curriculum.tasks
    if tier is not None:
        tasks = [t for t in tasks if t.tier == tier]
    if only:
        tasks = [t for t in tasks if t.id in set(only)]

    reports: list[RunReport] = []
    for task in tasks:
        report = await run_task(
            backend, task, env=env, use_policy_start=use_policy_start,
        )
        reports.append(report)

    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        summary = {
            "backend": backend.backend_name,
            "use_policy_start": use_policy_start,
            "started_at": min((r.started_at for r in reports), default=time.time()),
            "finished_at": max((r.finished_at for r in reports), default=time.time()),
            "pass_count": sum(1 for r in reports if r.success),
            "fail_count": sum(1 for r in reports if r.failed),
            "timeout_count": sum(
                1 for r in reports if not r.success and not r.failed
            ),
            "total": len(reports),
            "reports": [asdict(r) for r in reports],
        }
        (out_dir / "curriculum_report.json").write_text(
            json.dumps(summary, indent=2)
        )
        print(
            f"[testbed] wrote {out_dir / 'curriculum_report.json'} — "
            f"{summary['pass_count']} pass / {summary['fail_count']} fail / "
            f"{summary['timeout_count']} timeout out of {summary['total']}"
        )
    return reports
