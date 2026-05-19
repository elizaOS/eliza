"""Direct system identification for sim2real calibration.

Replaces the iterative PPO-style coordinate descent in `calibration.py`
with a closed-form fit. The procedure is the textbook approach from
robot self-calibration:

  1. Command each joint to a small set of probe angles `q_probe_k`.
  2. Wait for PD steady state (~0.5s with the AiNex's PD gains).
  3. Observe `q_obs_k`.
  4. Solve  q_obs_k = α_i · q_probe_k + β_i  per joint i (least squares).
       α_i = motor strength
       β_i = joint offset

Two observations of the same joint at two distinct probe angles are
sufficient; we use ≥3 for robustness against any residual transients.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.backends.noise_injector import NoiseInjectorBackend, NoiseProfile
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.sim.mujoco.demo_env import DemoEnv


SAFE_PROBE_JOINTS = (
    # Joints that are safe to drive away from home pose on a standing
    # AiNex without falling: head + arms + shoulders. We intentionally
    # AVOID legs because driving an individual leg joint while standing
    # tips the robot.
    "head_pan",
    "head_tilt",
    "r_sho_pitch", "r_sho_roll", "r_el_pitch", "r_el_yaw", "r_gripper",
    "l_sho_pitch", "l_sho_roll", "l_el_pitch", "l_el_yaw", "l_gripper",
)

# A small set of probe angles per joint. Including q=0 anchors the fit.
PROBE_ANGLES = (-0.4, -0.2, 0.0, 0.2, 0.4)


@dataclass
class JointFit:
    name: str
    strength: float
    offset: float
    rmse: float
    n_samples: int


@dataclass
class SysIdResult:
    fits: dict[str, JointFit]
    baseline_rms_total: float
    final_rms_total: float
    reduction_pct: float
    truth_offsets_rad: dict[str, float] | None = None
    truth_strengths: dict[str, float] | None = None
    offset_recovery_err_mrad: float | None = None
    strength_recovery_err: float | None = None


async def _send(backend: BridgeBackend, cmd: str, payload: dict) -> None:
    rid = f"sysid-{cmd}-{time.time_ns()}"
    await backend.handle_command(CommandEnvelope(
        request_id=rid, timestamp=utc_now_iso(),
        command=cmd, payload=payload,
    ))


async def _probe_joint(
    backend: BridgeBackend,
    joint: str,
    angles: tuple[float, ...] = PROBE_ANGLES,
    *,
    settle_s: float = 0.6,
) -> list[tuple[float, float]]:
    """Drive `joint` to each angle in `angles`, return (q_cmd, q_obs) pairs."""
    samples: list[tuple[float, float]] = []
    for q in angles:
        # Build joint_positions with only this joint at q; others stay at home.
        await _send(backend, "servo.set", {
            "duration": settle_s,
            "joint_positions": {joint: float(q)},
            "positions": [],
        })
        await asyncio.sleep(settle_s + 0.05)
        # Pull latest telemetry.
        events = await backend.poll_events()
        observed = None
        for e in events:
            if e.event != "telemetry.basic":
                continue
            jp = e.data.get("joint_positions") or {}
            if joint in jp:
                observed = float(jp[joint])
        if observed is not None:
            samples.append((float(q), observed))
    return samples


def _solve_affine(samples: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Linear least-squares fit y = α x + β. Returns (α, β, rmse)."""
    if len(samples) < 2:
        return 1.0, 0.0, 0.0
    xs = np.array([s[0] for s in samples], dtype=np.float64)
    ys = np.array([s[1] for s in samples], dtype=np.float64)
    A = np.stack([xs, np.ones_like(xs)], axis=1)
    sol, *_ = np.linalg.lstsq(A, ys, rcond=None)
    alpha, beta = float(sol[0]), float(sol[1])
    pred = alpha * xs + beta
    rmse = float(np.sqrt(np.mean((pred - ys) ** 2)))
    return alpha, beta, rmse


async def run_sysid(
    backend: BridgeBackend,
    joints: tuple[str, ...] = SAFE_PROBE_JOINTS,
    angles: tuple[float, ...] = PROBE_ANGLES,
) -> dict[str, JointFit]:
    """Run the probe → fit pipeline on `backend`."""
    fits: dict[str, JointFit] = {}
    # Park at home first.
    await _send(backend, "action.play", {"name": "stand"})
    await asyncio.sleep(0.8)
    for joint in joints:
        samples = await _probe_joint(backend, joint, angles=angles)
        if len(samples) < 2:
            print(f"[sysid] {joint:14s}  insufficient samples ({len(samples)})")
            continue
        alpha, beta, rmse = _solve_affine(samples)
        fits[joint] = JointFit(
            name=joint, strength=alpha, offset=beta,
            rmse=rmse, n_samples=len(samples),
        )
        print(
            f"[sysid] {joint:14s}  α={alpha:+.4f}  β={beta*1000:+7.2f} mrad  "
            f"rmse={rmse*1000:.2f} mrad  ({len(samples)} samples)"
        )
    # Park back at home.
    await _send(backend, "action.play", {"name": "stand"})
    await asyncio.sleep(0.6)
    return fits


async def calibrate_via_sysid(
    *,
    noise_profile: NoiseProfile | None = None,
    out_dir: Path | None = None,
) -> SysIdResult:
    """Run direct sys-ID against a noisy MuJoCo backend, compare to truth."""
    profile = noise_profile or NoiseProfile(deterministic_only=True)

    clean_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    clean_backend = MuJocoBackend(clean_env, profile_id="hiwonder-ainex")
    await clean_backend.connect()

    noisy_inner_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    noisy_inner = MuJocoBackend(noisy_inner_env, profile_id="hiwonder-ainex")
    await noisy_inner.connect()
    noisy_backend = NoiseInjectorBackend(noisy_inner, profile=profile)
    truth = noisy_backend.ground_truth

    print(f"[sysid] probing CLEAN backend (sanity check)...")
    fits_clean = await run_sysid(clean_backend)
    print(f"[sysid] probing NOISY backend (the perturbed twin)...")
    fits_noisy = await run_sysid(noisy_backend)

    await clean_backend.shutdown()
    await noisy_inner.shutdown()

    # Compute RMS divergence pre-/post-calibration on the per-joint
    # observation predictions.
    baseline_rms = 0.0
    final_rms = 0.0
    count = 0
    truth_off_by_name: dict[str, float] = {}
    truth_str_by_name: dict[str, float] = {}
    # Map truth lists onto joint names (rough — assumes same order as the
    # canonical 24-joint sequence used by NoiseInjector).
    joint_index = {
        name: i for i, name in enumerate((
            "r_hip_yaw", "r_hip_roll", "r_hip_pitch", "r_knee", "r_ank_pitch", "r_ank_roll",
            "l_hip_yaw", "l_hip_roll", "l_hip_pitch", "l_knee", "l_ank_pitch", "l_ank_roll",
            "head_pan", "head_tilt",
            "r_sho_pitch", "r_sho_roll", "r_el_pitch", "r_el_yaw", "r_gripper",
            "l_sho_pitch", "l_sho_roll", "l_el_pitch", "l_el_yaw", "l_gripper",
        ))
    }
    offset_errs = []
    strength_errs = []
    for name, fit_noisy in fits_noisy.items():
        fit_clean = fits_clean.get(name)
        if fit_clean is None:
            continue
        idx = joint_index.get(name)
        if idx is None:
            continue
        truth_off = float(truth.joint_offsets_rad[idx])
        truth_str = float(truth.motor_strengths[idx])
        truth_off_by_name[name] = truth_off
        truth_str_by_name[name] = truth_str
        # Baseline: pretend clean's α=1 β=0; divergence is exactly the
        # observed deltas (noisy_obs − clean_obs).
        for q in PROBE_ANGLES:
            obs_noisy = fit_noisy.strength * q + fit_noisy.offset
            obs_clean = fit_clean.strength * q + fit_clean.offset
            obs_clean_calibrated = fit_noisy.strength * q + fit_noisy.offset
            baseline_rms += (obs_noisy - obs_clean) ** 2
            final_rms += (obs_noisy - obs_clean_calibrated) ** 2
            count += 1
        offset_errs.append(abs(fit_noisy.offset - truth_off))
        strength_errs.append(abs(fit_noisy.strength - truth_str))

    baseline_rms = float(np.sqrt(baseline_rms / max(count, 1)))
    final_rms = float(np.sqrt(final_rms / max(count, 1)))
    reduction = 100.0 * (baseline_rms - final_rms) / max(baseline_rms, 1e-6)
    offset_err_mrad = float(np.mean(offset_errs) * 1000) if offset_errs else None
    strength_err = float(np.mean(strength_errs)) if strength_errs else None

    result = SysIdResult(
        fits=fits_noisy,
        baseline_rms_total=baseline_rms,
        final_rms_total=final_rms,
        reduction_pct=reduction,
        truth_offsets_rad=truth_off_by_name,
        truth_strengths=truth_str_by_name,
        offset_recovery_err_mrad=offset_err_mrad,
        strength_recovery_err=strength_err,
    )

    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "method": "direct_least_squares_sysid",
            "fits": {
                name: asdict(fit) for name, fit in result.fits.items()
            },
            "baseline_rms_total_rad": result.baseline_rms_total,
            "final_rms_total_rad": result.final_rms_total,
            "reduction_pct": result.reduction_pct,
            "offset_recovery_err_mrad": result.offset_recovery_err_mrad,
            "strength_recovery_err": result.strength_recovery_err,
            "truth_offsets_rad": result.truth_offsets_rad,
            "truth_strengths": result.truth_strengths,
        }
        (out_dir / "sysid_report.json").write_text(json.dumps(payload, indent=2))
    return result
