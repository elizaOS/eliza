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
    """A long, deterministic command sequence that exercises legs +
    arms + head with varied joint targets. Each pose is held briefly
    so perturbations have measurable effect across every joint, not
    just the ones touched by a couple of poses.
    """
    cmds: list[tuple[str, dict]] = []
    cmds.append(("action.play", {"name": "stand"}))
    # Head sweeps — exercise head_pan + head_tilt.
    for pan, tilt in (
        (0.6, 0.0), (-0.6, 0.0), (0.0, 0.5), (0.0, -0.4),
        (0.4, 0.3), (-0.4, -0.3), (0.0, 0.0),
    ):
        cmds.append(("head.set", {"pan": pan, "tilt": tilt, "duration": 0.4}))
    # Scripted actions — exercise legs + arms via the action library.
    cmds.append(("action.play", {"name": "wave"}))
    cmds.append(("action.play", {"name": "stand"}))
    cmds.append(("action.play", {"name": "bow"}))
    cmds.append(("action.play", {"name": "stand"}))
    cmds.append(("action.play", {"name": "sit"}))
    cmds.append(("action.play", {"name": "stand"}))
    # Direct servo.set — exercises specific joints at known angles.
    for amplitude in (0.1, -0.1, 0.2, -0.2, 0.0):
        cmds.append(("servo.set", {
            "duration": 0.3,
            "joint_positions": {
                "r_sho_pitch": amplitude,
                "l_sho_pitch": -amplitude,
                "r_el_pitch": -0.2 + amplitude,
                "l_el_pitch": -0.2 - amplitude,
                "head_pan": amplitude * 2,
                "head_tilt": amplitude,
            },
            "positions": [],
        }))
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

    # Residual estimation: only use samples where the robot is "at rest"
    # (the final `stand` pose and similar steady-state moments). PD
    # dynamics make mid-motion samples poor gradient signals because
    # commanded ≠ observed during transients.
    #
    # We average the LAST K stable samples and update offset/strength
    # gently. With Adam normalization, learning_rate ≈ step size per
    # iteration, so 0.003 is appropriate when truth offsets are ~0.015 rad.

    # Adam state per parameter group.
    m_off = np.zeros_like(params.joint_offsets)
    v_off = np.zeros_like(params.joint_offsets)
    m_str = np.zeros_like(params.motor_strengths)
    v_str = np.zeros_like(params.motor_strengths)
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    best_params_snapshot = params.to_jsonable()

    for it in range(1, iterations + 1):
        offset_grad = np.zeros_like(params.joint_offsets)
        strength_grad = np.zeros_like(params.motor_strengths)
        offset_count = np.zeros_like(params.joint_offsets)
        strength_count = np.zeros_like(params.motor_strengths)

        # Use the LAST k stable steps (steady-state pose, less PD transient).
        k = min(5, min(len(clean_traj), len(noisy_traj)))
        if k > 0:
            for t in range(-k, 0):
                cj = clean_traj[t].joint_positions
                nj = noisy_traj[t].joint_positions
                for i, name in enumerate(joint_order):
                    if name not in cj or name not in nj:
                        continue
                    pred = float(cj[name]) * float(params.motor_strengths[i]) + float(
                        params.joint_offsets[i]
                    )
                    err = float(nj[name]) - pred
                    offset_grad[i] += err
                    offset_count[i] += 1
                    if abs(cj[name]) > 0.02:
                        # strength gradient: ∂loss/∂strength = -clean_pos * err
                        strength_grad[i] += float(cj[name]) * err
                        strength_count[i] += 1

        offset_grad /= np.maximum(offset_count, 1)
        strength_grad /= np.maximum(strength_count, 1)

        # Adam update with conservative step size — at most ~`learning_rate`
        # rad of offset change per iteration regardless of gradient norm.
        m_off = beta1 * m_off + (1 - beta1) * offset_grad
        v_off = beta2 * v_off + (1 - beta2) * (offset_grad**2)
        params.joint_offsets += (
            learning_rate * m_off / (np.sqrt(v_off) + eps)
        )
        np.clip(params.joint_offsets, -0.15, 0.15, out=params.joint_offsets)

        m_str = beta1 * m_str + (1 - beta1) * strength_grad
        v_str = beta2 * v_str + (1 - beta2) * (strength_grad**2)
        # Smaller step on strength (less identifiable than offset).
        params.motor_strengths += (
            0.3 * learning_rate * m_str / (np.sqrt(v_str) + eps)
        )
        np.clip(params.motor_strengths, 0.7, 1.3, out=params.motor_strengths)

        # Re-record both sides with the new calibration applied to clean.
        clean_traj = await _record_trajectory_calibrated(
            clean_backend, program, params, joint_order
        )
        noisy_traj = await _record_trajectory(noisy_backend, program)
        dist = _trajectory_distance(clean_traj, noisy_traj)
        history.append({"iter": it, **dist, "params_snapshot": params.to_jsonable()})
        if dist["rms_total"] < best_dist:
            best_dist = dist["rms_total"]
            best_params_snapshot = params.to_jsonable()
        print(
            f"[calibrate] iter {it:2d}/{iterations}: "
            f"rms_imu={dist['rms_imu']:.4f}  rms_joint={dist['rms_joint']:.4f}  "
            f"total={dist['rms_total']:.4f}  "
            f"({100*(baseline_dist['rms_total']-dist['rms_total'])/baseline_dist['rms_total']:+.1f}%)"
        )

    # Roll back to the best parameters seen during the run (don't return
    # the last-iteration params if they overshot).
    params.joint_offsets = np.array(best_params_snapshot["joint_offsets"], dtype=np.float32)
    params.motor_strengths = np.array(best_params_snapshot["motor_strengths"], dtype=np.float32)

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
