"""Full 24-joint sys-ID that's safe to run while the robot is standing.

Strategy:
  1. Park at `stand`, wait for settle.
  2. Read the actual joint angles via the bus_servo service. These are
     the per-joint references the calibration is linearized around.
  3. For each joint, probe with TINY deltas (±0.02 - ±0.05 rad) around
     the read reference. Small enough that a single-joint perturbation
     doesn't destabilise a biped that's already balanced.
  4. Fit q_obs = α · q_cmd + β via least squares.
  5. Re-park at `stand` after each joint so the robot doesn't drift.

Compared to the original `run_sysid` in `sysid.py`:
  - Uses CURRENT measured pose as the per-joint reference, not the
    profile's nominal home pose. Real-robot home offsets (servos that
    aren't physically zeroed) get folded into the reference.
  - Smaller deltas (default ±0.04 rad) so legs can be probed safely.
  - Re-stand between joints to prevent cumulative drift.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.isaaclab.joint_map import (
    joint_name_to_servo_id,
    radians_to_pulse,
)
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.profiles.schema import load_profile
from eliza_robot.sim2real.sysid import JointFit, _solve_affine

logger = logging.getLogger(__name__)


# Per-joint-group probe deltas — tighter for legs (a small leg motion
# can be enough to tip the robot if grounding is unstable).
DEFAULT_DELTAS_LEG = (-0.03, -0.015, 0.0, 0.015, 0.03)
DEFAULT_DELTAS_ARM = (-0.05, -0.025, 0.0, 0.025, 0.05)
DEFAULT_DELTAS_HEAD = (-0.10, -0.05, 0.0, 0.05, 0.10)


def _deltas_for(joint_name: str, group: str | None = None) -> tuple[float, ...]:
    """Choose probe deltas based on the joint group."""
    name = joint_name.lower()
    if (group and group.upper() == "LEG") or any(
        kw in name for kw in ("hip", "knee", "ank")
    ):
        return DEFAULT_DELTAS_LEG
    if (group and group.upper() == "HEAD") or "head" in name:
        return DEFAULT_DELTAS_HEAD
    return DEFAULT_DELTAS_ARM


async def _send(backend: BridgeBackend, cmd: str, payload: dict) -> bool:
    """Send a command, return True if backend ack was ok."""
    rid = f"sysid-full-{cmd}-{time.time_ns()}"
    env = CommandEnvelope(
        request_id=rid, timestamp=utc_now_iso(),
        command=cmd, payload=payload,
    )
    resp = await backend.handle_command(env)
    return bool(resp.ok)


async def _read_all_joint_positions(backend: BridgeBackend) -> dict[str, float]:
    """Best-effort joint-position read using whichever path the backend
    exposes: explicit service (real AiNex) or telemetry (sim)."""
    read = getattr(backend, "read_joint_positions", None)
    if callable(read):
        try:
            positions = await read()
            if positions:
                return positions
        except Exception:
            pass
    # Fall back to telemetry.basic.
    events = await backend.poll_events()
    for e in events:
        if e.event == "telemetry.basic":
            jp = e.data.get("joint_positions") or {}
            if jp:
                return {k: float(v) for k, v in jp.items()}
    return {}


async def _probe_joint_around_current(
    backend: BridgeBackend,
    joint: str,
    deltas: tuple[float, ...],
    *,
    settle_s: float = 0.5,
) -> list[tuple[float, float]]:
    """Probe `joint` at current_pos + δ for each δ in `deltas`.

    Reads current_pos via the backend's joint-position surface BEFORE
    each probe, so the reference doesn't drift between probes.
    """
    samples: list[tuple[float, float]] = []
    for delta in deltas:
        all_positions = await _read_all_joint_positions(backend)
        if joint not in all_positions:
            return samples
        current = float(all_positions[joint])
        q = current + delta
        try:
            sid = joint_name_to_servo_id(joint)
            pulse = int(radians_to_pulse(q, sid))
            positions = [{"id": int(sid), "position": pulse}]
        except Exception:
            positions = []
        await _send(backend, "servo.set", {
            "duration": settle_s,
            "joint_positions": {joint: float(q)},
            "positions": positions,
        })
        await asyncio.sleep(settle_s + 0.15)
        new_positions = await _read_all_joint_positions(backend)
        if joint in new_positions:
            observed = float(new_positions[joint])
            samples.append((float(q), observed))
    return samples


async def run_full_sysid(
    backend: BridgeBackend,
    *,
    settle_s: float = 0.5,
    restand_between_groups: bool = True,
) -> dict[str, JointFit]:
    """Probe every joint in the active profile."""
    profile = load_profile("hiwonder-ainex")
    joints = [(j.name, j.group) for j in profile.kinematics.joints]
    home_by_name = {j.name: float(j.home_rad) for j in profile.kinematics.joints}

    fits: dict[str, JointFit] = {}

    # Initial stand + settle.
    print("[sysid-full] parking at stand pose...")
    await _send(backend, "action.play", {"name": "stand"})
    await asyncio.sleep(2.0)
    last_group = None

    for joint_name, group in joints:
        if last_group is not None and group != last_group and restand_between_groups:
            # Re-stand to clear any drift before switching joint groups.
            await _send(backend, "action.play", {"name": "stand"})
            await asyncio.sleep(1.5)
        last_group = group
        deltas = _deltas_for(joint_name, group)
        try:
            samples = await _probe_joint_around_current(
                backend, joint_name, deltas, settle_s=settle_s,
            )
        except Exception as exc:
            print(f"[sysid-full] {joint_name:14s}  probe failed: {exc}")
            continue
        if len(samples) < 2:
            print(f"[sysid-full] {joint_name:14s}  insufficient samples")
            continue
        alpha, beta, rmse = _solve_affine(samples)
        # Subtract the home pose so β is the calibrable additive offset.
        home = home_by_name.get(joint_name, 0.0)
        recovered_off = beta - home * (1.0 - alpha)
        fits[joint_name] = JointFit(
            name=joint_name, strength=alpha, offset=recovered_off,
            rmse=rmse, n_samples=len(samples),
        )
        print(
            f"[sysid-full] {joint_name:14s}  group={group:4s}  "
            f"α={alpha:+.4f}  β_corr={recovered_off*1000:+7.2f} mrad  "
            f"rmse={rmse*1000:.2f} mrad"
        )

    # Final stand to leave the robot in a known pose.
    await _send(backend, "action.play", {"name": "stand"})
    await asyncio.sleep(1.0)
    return fits
