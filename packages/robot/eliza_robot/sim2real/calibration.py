"""Dual-sim sim2real calibration loop.

Architecture (per user's recommendation):

  clean MuJoCo  ←─ same commands ─→  noisy MuJoCo (NoiseInjector)
                                          ^
                                          │
                                  ground truth perturbations injected
                                  (per-servo lag, motor strength, etc.)

The calibration loop runs both backends side-by-side under an identical
command trajectory, observes the divergence between their telemetry
streams, and iteratively tunes a set of parameters on the **clean**
backend to make its trajectory match the **noisy** one as closely as
possible. Since we know the ground-truth perturbations injected into
the noisy sim, we can score how close calibration got us.

When the same loop runs against a real AiNex instead of the noisy sim,
we don't have ground truth, but the optimization objective (divergence
between commanded-state and observed-state) is identical.
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
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.backends.noise_injector import NoiseInjectorBackend, NoiseProfile
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.sim.mujoco.demo_env import DemoEnv


@dataclass
class CalibrationParameters:
    """The parameters the calibration loop tunes on the clean sim."""

    # Per-joint motor-strength multipliers (applied to commanded angles).
    motor_strengths: np.ndarray = field(
        default_factory=lambda: np.ones(24, dtype=np.float32)
    )
    # Per-joint zero-offsets (radians).
    joint_offsets: np.ndarray = field(
        default_factory=lambda: np.zeros(24, dtype=np.float32)
    )
    # Global response delay (seconds).
    response_delay_s: float = 0.0

    def apply_to(self, joint_positions: dict[str, float], joint_order: list[str]) -> dict[str, float]:
        """Apply the calibration to a commanded joint dict."""
        out: dict[str, float] = {}
        for i, name in enumerate(joint_order):
            val = float(joint_positions.get(name, 0.0))
            if i < self.motor_strengths.shape[0]:
                val *= float(self.motor_strengths[i])
                val += float(self.joint_offsets[i])
            out[name] = val
        return out

    def to_jsonable(self) -> dict:
        return {
            "motor_strengths": self.motor_strengths.tolist(),
            "joint_offsets": self.joint_offsets.tolist(),
            "response_delay_s": self.response_delay_s,
        }


@dataclass
class TrajectoryRecord:
    """One step of recorded state from one backend during the calibration run."""

    t_s: float
    imu_roll: float
    imu_pitch: float
    joint_positions: dict[str, float]


async def _record_trajectory(
    backend: BridgeBackend,
    commands: list[tuple[str, dict]],
    *,
    pause_s: float = 0.05,
) -> list[TrajectoryRecord]:
    """Run `commands` against `backend`, record telemetry at each step."""
    records: list[TrajectoryRecord] = []
    t0 = time.time()
    for i, (cmd, payload) in enumerate(commands):
        rid = f"cal-{i}-{time.time_ns()}"
        await backend.handle_command(CommandEnvelope(
            request_id=rid, timestamp=utc_now_iso(),
            command=cmd, payload=payload,
        ))
        await asyncio.sleep(pause_s)
        events = await backend.poll_events()
        for e in events:
            if e.event != "telemetry.basic":
                continue
            jp = e.data.get("joint_positions")
            if not isinstance(jp, dict):
                jp = {}
            records.append(TrajectoryRecord(
                t_s=time.time() - t0,
                imu_roll=float(e.data.get("imu_roll", 0.0)),
                imu_pitch=float(e.data.get("imu_pitch", 0.0)),
                joint_positions={k: float(v) for k, v in jp.items()},
            ))
            break
    return records


def _trajectory_distance(
    a: list[TrajectoryRecord], b: list[TrajectoryRecord]
) -> dict:
    """Compute per-feature RMS divergence between two trajectories."""
    n = min(len(a), len(b))
    if n == 0:
        return {"rms_imu": 0.0, "rms_joint": 0.0, "samples": 0}
    roll_sq = sum((a[i].imu_roll - b[i].imu_roll) ** 2 for i in range(n)) / n
    pitch_sq = sum((a[i].imu_pitch - b[i].imu_pitch) ** 2 for i in range(n)) / n
    rms_imu = math.sqrt(roll_sq + pitch_sq)

    joint_sum = 0.0
    joint_count = 0
    for i in range(n):
        keys = set(a[i].joint_positions) & set(b[i].joint_positions)
        for k in keys:
            joint_sum += (a[i].joint_positions[k] - b[i].joint_positions[k]) ** 2
            joint_count += 1
    rms_joint = math.sqrt(joint_sum / max(joint_count, 1))
    return {
        "rms_imu": float(rms_imu),
        "rms_joint": float(rms_joint),
        "rms_total": float(math.sqrt(rms_imu**2 + rms_joint**2)),
        "samples": n,
    }


def _build_command_program(profile_id: str = "hiwonder-ainex") -> list[tuple[str, dict]]:
    """A short, deterministic command sequence that exercises arms + head.

    Walks both sims through the same poses so divergence at each step is
    a direct measurement of perturbations.
    """
    cmds: list[tuple[str, dict]] = []
    # Sequence: stand, head pan +0.6, head pan -0.6, head 0, wave, stand
    cmds.append(("action.play", {"name": "stand"}))
    for tilt in (0.0, 0.4, -0.4, 0.0):
        cmds.append(("head.set", {"pan": 0.5 * (tilt + 0.2), "tilt": tilt, "duration": 0.4}))
    cmds.append(("action.play", {"name": "wave"}))
    cmds.append(("action.play", {"name": "stand"}))
    return cmds


async def calibrate(
    *,
    noise_profile: NoiseProfile | None = None,
    iterations: int = 20,
    learning_rate: float = 0.4,
    out_dir: Path | None = None,
) -> dict:
    """Run a calibration sweep.

    Algorithm: stochastic coordinate descent over (motor_strengths,
    joint_offsets) using the difference between the noisy and clean
    trajectories as the gradient signal.

    A more sophisticated alternative would call out to
    `lvjonok/mujoco-sysid` for a single MAP fit; this loop is good
    enough for the dual-sim regression and is < 200 lines.
    """
    profile = noise_profile or NoiseProfile()

    # Build two independent envs so they don't share MuJoCo state.
    clean_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    clean_backend = MuJocoBackend(clean_env, profile_id="hiwonder-ainex")
    await clean_backend.connect()

    noisy_inner_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    noisy_inner = MuJocoBackend(noisy_inner_env, profile_id="hiwonder-ainex")
    await noisy_inner.connect()
    noisy_backend = NoiseInjectorBackend(noisy_inner, profile=profile)
    truth = noisy_backend.ground_truth

    joint_order = [j.name for j in [
        # Match profile order — keep light, just first 24 joint names.
    ]] or [
        "r_hip_yaw", "r_hip_roll", "r_hip_pitch", "r_knee", "r_ank_pitch", "r_ank_roll",
        "l_hip_yaw", "l_hip_roll", "l_hip_pitch", "l_knee", "l_ank_pitch", "l_ank_roll",
        "head_pan", "head_tilt",
        "r_sho_pitch", "r_sho_roll", "r_el_pitch", "r_el_yaw", "r_gripper",
        "l_sho_pitch", "l_sho_roll", "l_el_pitch", "l_el_yaw", "l_gripper",
    ]

    program = _build_command_program()

    # Baseline divergence with no calibration applied.
    clean_traj = await _record_trajectory(clean_backend, program)
    noisy_traj = await _record_trajectory(noisy_backend, program)
    baseline_dist = _trajectory_distance(clean_traj, noisy_traj)
    print(
        f"[calibrate] baseline divergence: "
        f"rms_imu={baseline_dist['rms_imu']:.4f} rad, "
        f"rms_joint={baseline_dist['rms_joint']:.4f} rad"
    )

    params = CalibrationParameters()
    best_dist = baseline_dist["rms_total"]
    history: list[dict] = [{"iter": 0, **baseline_dist}]

    for it in range(1, iterations + 1):
        # Estimate per-joint correction from the mean residual at the last
        # step of the noisy run (assumes steady-state pose after final
        # `stand`). For each joint, observed_pos = true_pos * strength + offset.
        # We approximate by tracking the offset only and a small strength
        # scale toward the average noisy/clean ratio.
        if len(clean_traj) > 0 and len(noisy_traj) > 0:
            tail = -1
            clean_joint = clean_traj[tail].joint_positions
            noisy_joint = noisy_traj[tail].joint_positions
            for i, name in enumerate(joint_order):
                if name not in clean_joint or name not in noisy_joint:
                    continue
                residual = noisy_joint[name] - (
                    clean_joint[name] * params.motor_strengths[i] + params.joint_offsets[i]
                )
                # Update offset by a fraction of the residual.
                params.joint_offsets[i] += learning_rate * float(residual)
                # Update strength toward the ratio of noisy/clean (gentle).
                if abs(clean_joint[name]) > 0.05:
                    ratio = noisy_joint[name] / clean_joint[name]
                    if 0.5 <= ratio <= 1.5:
                        params.motor_strengths[i] += learning_rate * (
                            float(ratio) - float(params.motor_strengths[i])
                        ) * 0.3

        # Re-run the clean side with the calibration applied via a small
        # adapter (we just pre-multiply joint targets in our recorder).
        clean_traj2 = await _record_trajectory_calibrated(
            clean_backend, program, params, joint_order
        )
        noisy_traj2 = await _record_trajectory(noisy_backend, program)
        dist = _trajectory_distance(clean_traj2, noisy_traj2)
        history.append({"iter": it, **dist, "params_snapshot": params.to_jsonable()})
        if dist["rms_total"] < best_dist:
            best_dist = dist["rms_total"]
        print(
            f"[calibrate] iter {it:2d}/{iterations}: "
            f"rms_imu={dist['rms_imu']:.4f}  rms_joint={dist['rms_joint']:.4f}  "
            f"total={dist['rms_total']:.4f}"
        )

    await clean_backend.shutdown()
    await noisy_inner.shutdown()

    # Score recovered parameters vs ground truth.
    recovered_offsets = params.joint_offsets[: len(truth.joint_offsets_rad)]
    truth_offsets = np.array(truth.joint_offsets_rad, dtype=np.float32)
    offset_err = float(np.mean(np.abs(recovered_offsets - truth_offsets)))
    recovered_strengths = params.motor_strengths[: len(truth.motor_strengths)]
    truth_strengths = np.array(truth.motor_strengths, dtype=np.float32)
    strength_err = float(np.mean(np.abs(recovered_strengths - truth_strengths)))

    summary = {
        "baseline_rms_total": baseline_dist["rms_total"],
        "final_rms_total": best_dist,
        "reduction_pct": float(
            (baseline_dist["rms_total"] - best_dist) / max(baseline_dist["rms_total"], 1e-6) * 100
        ),
        "offset_recovery_err_rad": offset_err,
        "strength_recovery_err": strength_err,
        "ground_truth_offsets_rad_sample": truth.joint_offsets_rad[:6],
        "recovered_offsets_rad_sample": params.joint_offsets[:6].tolist(),
        "ground_truth_strengths_sample": truth.motor_strengths[:6],
        "recovered_strengths_sample": params.motor_strengths[:6].tolist(),
        "history": history,
        "final_params": params.to_jsonable(),
        "noise_profile": asdict(profile),
    }
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "calibration_report.json").write_text(
            json.dumps(summary, indent=2)
        )
        print(f"[calibrate] wrote {out_dir / 'calibration_report.json'}")
    return summary


async def _record_trajectory_calibrated(
    backend: BridgeBackend,
    commands: list[tuple[str, dict]],
    params: CalibrationParameters,
    joint_order: list[str],
    *,
    pause_s: float = 0.05,
) -> list[TrajectoryRecord]:
    """Apply `params` to every `servo.set`-style payload before sending."""
    records: list[TrajectoryRecord] = []
    t0 = time.time()
    for i, (cmd, payload) in enumerate(commands):
        send_payload = dict(payload)
        if cmd == "servo.set" and "joint_positions" in send_payload:
            send_payload["joint_positions"] = params.apply_to(
                send_payload["joint_positions"], joint_order
            )
        rid = f"cal-cln-{i}-{time.time_ns()}"
        await backend.handle_command(CommandEnvelope(
            request_id=rid, timestamp=utc_now_iso(),
            command=cmd, payload=send_payload,
        ))
        await asyncio.sleep(pause_s)
        events = await backend.poll_events()
        for e in events:
            if e.event != "telemetry.basic":
                continue
            jp = e.data.get("joint_positions") or {}
            records.append(TrajectoryRecord(
                t_s=time.time() - t0,
                imu_roll=float(e.data.get("imu_roll", 0.0)),
                imu_pitch=float(e.data.get("imu_pitch", 0.0)),
                joint_positions={k: float(v) for k, v in jp.items()},
            ))
            break
    return records
