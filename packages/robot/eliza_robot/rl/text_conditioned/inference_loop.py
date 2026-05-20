"""Server-side text-conditioned inference loop.

Closes the loop between the trained policy and a `BridgeBackend`:

    text task ─→ TextConditionedPolicy.act(text, proprio) ─→
        24-D joint targets ─→ bridge.servo.set ─→
        backend (real AiNex and/or MuJoCo) ─→
        new proprio ─→ next tick

Designed to be invoked either:
  - directly from a script (`run_inference(backend, ckpt, text)`),
  - or by the bridge server itself on `policy.start{task=…}` when the
    `--policy-checkpoint` flag is set (server-side autonomous policy).

The loop honours `max_steps` and `hz`, and always issues an explicit
`walk.command:stop` + `action.play{name=stand}` on exit so the robot
parks safely.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.profiles.schema import load_profile
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy


logger = logging.getLogger(__name__)


@dataclass
class InferenceLoopConfig:
    hz: float = 10.0
    max_steps: int = 500
    action_scale: float = 0.3        # rad per step around home pose
    safety_clip_rad: float = 1.0     # never command farther than this from home
    profile_id: str = "hiwonder-ainex"


async def _send(backend: BridgeBackend, command: str, payload: dict, preempt: bool = False):
    rid = f"infer-{command}-{time.time_ns()}"
    env = CommandEnvelope(
        request_id=rid, timestamp=utc_now_iso(),
        command=command, payload=payload, preempt=preempt,
    )
    return await backend.handle_command(env)


async def _read_proprio(backend: BridgeBackend) -> np.ndarray:
    """Pull the latest telemetry.basic and convert to a proprio vector
    that's roughly compatible with TextConditionedJoystickEnv. We zero-pad
    when the real backend doesn't supply all fields.
    """
    events = await backend.poll_events()
    latest = None
    for e in events:
        if e.event == "telemetry.basic":
            latest = e.data
    proprio = np.zeros(45, dtype=np.float32)
    if latest is None:
        return proprio
    # rough mapping — keep shape compatible with the smoke env
    proprio[0] = float(latest.get("imu_roll", 0.0))
    proprio[1] = float(latest.get("imu_pitch", 0.0))
    proprio[2] = 0.0  # gyro z unused
    proprio[3] = 0.0
    proprio[4] = 0.0
    proprio[5] = 1.0  # gravity z assumed upright
    jp = latest.get("joint_positions") or {}
    if isinstance(jp, dict):
        # Place known joints at canonical indices (best-effort).
        names = [
            "r_hip_yaw", "r_hip_roll", "r_hip_pitch", "r_knee", "r_ank_pitch", "r_ank_roll",
            "l_hip_yaw", "l_hip_roll", "l_hip_pitch", "l_knee", "l_ank_pitch", "l_ank_roll",
            "head_pan", "head_tilt",
            "r_sho_pitch", "r_sho_roll", "r_el_pitch", "r_el_yaw", "r_gripper",
            "l_sho_pitch", "l_sho_roll", "l_el_pitch", "l_el_yaw", "l_gripper",
        ]
        for i, n in enumerate(names):
            if i + 6 < proprio.shape[0]:
                proprio[i + 6] = float(jp.get(n, 0.0))
    return proprio


async def run_inference(
    backend: BridgeBackend,
    checkpoint_dir: str | Path,
    text: str,
    *,
    config: InferenceLoopConfig | None = None,
) -> dict:
    """Run a single text-conditioned inference episode.

    Returns a summary dict with steps_completed, matched_task_id, etc.
    The caller must have already connected the backend.
    """
    config = config or InferenceLoopConfig()
    profile = load_profile(config.profile_id)
    joint_names = [j.name for j in profile.kinematics.joints]
    home_rad = np.array([j.home_rad for j in profile.kinematics.joints], dtype=np.float32)

    policy = TextConditionedPolicy(Path(checkpoint_dir))
    matched_task, _, similarity = policy.resolve_task(text)
    logger.info(
        "inference loop start: text=%r → task=%s (sim=%.2f), %d steps @ %.1f Hz",
        text, matched_task, similarity, config.max_steps, config.hz,
    )

    period = 1.0 / config.hz
    steps = 0
    try:
        while steps < config.max_steps:
            t_start = time.time()
            proprio = await _read_proprio(backend)
            action, _ = policy.act(text, proprio, deterministic=True)
            # Joint-target = home + scaled action, clipped to safety window.
            targets = home_rad + np.clip(action, -1.0, 1.0) * config.action_scale
            targets = np.clip(
                targets, home_rad - config.safety_clip_rad,
                home_rad + config.safety_clip_rad,
            )
            joint_positions = {joint_names[i]: float(targets[i]) for i in range(len(joint_names))}
            # Dispatch as servo.set. Use a SHORT physics duration on
            # the sim leg so the dual-target broadcast doesn't get
            # bottlenecked by long step_n calls — at the policy rate
            # we only want ~one outer-loop step per tick of physics,
            # not the full settle window.
            servo_duration = max(0.02, min(period, 0.06))
            response = await _send(backend, "servo.set", {
                "duration": float(servo_duration),
                "joint_positions": joint_positions,
                "positions": _to_pulse_positions(joint_positions),
            })
            if not response.ok:
                logger.warning("servo.set returned not-ok: %s", response.message)
            steps += 1
            elapsed = time.time() - t_start
            await asyncio.sleep(max(0.0, period - elapsed))
    finally:
        await _send(backend, "walk.command", {"action": "stop"}, preempt=True)
        await _send(backend, "action.play", {"name": "stand"})

    return {
        "text": text,
        "matched_task_id": matched_task,
        "similarity": similarity,
        "steps_completed": steps,
        "checkpoint": str(checkpoint_dir),
    }


def _to_pulse_positions(joint_positions: dict[str, float]) -> list[dict]:
    """Convert {name: radians} → [{id, position}] in 0..1000 pulse units so
    the real-robot path (which expects the bus_servo SetBusServosPosition
    shape) accepts the message. The MuJoCoBackend ignores this and uses
    `joint_positions` directly.
    """
    try:
        from eliza_robot.bridge.isaaclab.joint_map import (
            joint_name_to_servo_id,
            radians_to_pulse,
        )
    except Exception:
        return []
    out: list[dict] = []
    for name, rad in joint_positions.items():
        try:
            sid = joint_name_to_servo_id(name)
            out.append({"id": int(sid), "position": int(radians_to_pulse(float(rad), sid))})
        except Exception:
            continue
    return out
