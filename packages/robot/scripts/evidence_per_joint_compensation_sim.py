"""Per-joint sim2real compensation — proven on the deterministic noisy
sim twin where we have ground truth for the perturbations.

This is the "architecture works" demonstration:

  1. Build a noisy sim (NoiseInjectorBackend wrapping MuJoCo) with
     known per-joint α and β perturbations.
  2. Build a clean sim (MuJoCoBackend) — this is the SIM leg of our
     dual target.
  3. Run sys-ID against the noisy twin → recover per-joint (α, β).
  4. For each test angle, command both backends (clean and noisy)
     with the SAME raw angle, then with the calibration applied to
     the clean side. Measure the divergence.

Expected outcome (and what we'll prove): per-joint compensated
divergence drops from ~tens of mrad to single-digit mrad, confirming
the math closes the gap when the hardware tracks linearly.

On the real AiNex this falls back to "9/24 joints with good fits get
compensated, 15/24 have hardware issues that need mechanical work
before linear calibration can help."
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import numpy as np

from eliza_robot.bridge.backends.calibrated import (
    CalibratedBackend,
    JointCalibration,
    load_calibration_file,
)
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.backends.noise_injector import (
    NoiseInjectorBackend,
    NoiseProfile,
)
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.sim.mujoco.demo_env import DemoEnv
from eliza_robot.sim2real.sysid_full import run_full_sysid


TEST_JOINTS = [
    "head_pan", "head_tilt", "r_sho_pitch", "l_sho_pitch",
    "r_gripper", "l_gripper",
]
TEST_DELTAS = (-0.1, -0.05, 0.0, 0.05, 0.10)


async def _send(backend, cmd: str, payload: dict) -> bool:
    rid = f"perjoint-sim-{cmd}-{time.time_ns()}"
    resp = await backend.handle_command(CommandEnvelope(
        request_id=rid, timestamp=utc_now_iso(),
        command=cmd, payload=payload,
    ))
    return resp.ok


async def _read_obs(backend, sim_env, joint: str) -> float | None:
    """Pull the observed value for `joint` from whichever surface the
    backend exposes."""
    read = getattr(backend, "read_joint_positions", None)
    if callable(read):
        positions = await read()
        if joint in positions:
            return float(positions[joint])
    try:
        t = sim_env._build_telemetry()
        return float(t["joint_positions"].get(joint, 0.0))
    except Exception:
        return None


async def main_async(args) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Setup: noisy backend (the "real" stand-in) + clean backend (sim
    # leg of dual-target) + calibrated wrapper on clean.
    profile = NoiseProfile(deterministic_only=True, rng_seed=42)

    noisy_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    noisy_inner = MuJocoBackend(noisy_env, profile_id="hiwonder-ainex")
    await noisy_inner.connect()
    noisy = NoiseInjectorBackend(noisy_inner, profile=profile)

    clean_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    clean = MuJocoBackend(clean_env, profile_id="hiwonder-ainex")
    await clean.connect()

    # Step 1: sys-ID against the noisy twin.
    print("[per-joint-sim] running sys-ID against the noisy twin...")
    fits = await run_full_sysid(noisy, settle_s=0.4)
    fits_path = out_dir / "noisy_calibration.json"
    fits_path.write_text(json.dumps(
        {"fits": {n: {
            "name": f.name, "strength": f.strength,
            "offset": f.offset, "rmse": f.rmse,
        } for n, f in fits.items()}}, indent=2,
    ))
    trustworthy = load_calibration_file(fits_path)
    print(f"[per-joint-sim] {len(fits)} fit, {len(trustworthy)} pass trust filter")

    # Build a calibrated clean backend.
    calibrated = CalibratedBackend(clean, trustworthy)

    # Park both at stand.
    await _send(noisy, "action.play", {"name": "stand"})
    await _send(calibrated, "action.play", {"name": "stand"})
    await asyncio.sleep(1.5)

    truth_offsets = noisy.ground_truth.joint_offsets_rad
    truth_strengths = noisy.ground_truth.motor_strengths

    # Step 2: per-joint test.
    print("\n[per-joint-sim] running per-joint compensation test...")
    results = []
    for joint in TEST_JOINTS:
        if joint not in trustworthy:
            print(f"  {joint}: SKIP (not in trust-filtered set)")
            continue
        fit = trustworthy[joint]
        uncal_errs = []
        cal_errs = []
        per_angle = []
        for delta in TEST_DELTAS:
            # Read current pose of both, use as anchor.
            noisy_cur = await _read_obs(noisy, noisy_env, joint) or 0.0
            angle = noisy_cur + delta
            # Command noisy (the "real" twin) at raw angle.
            await _send(noisy, "servo.set", {
                "duration": 0.4,
                "joint_positions": {joint: angle},
                "positions": [],
            })
            # Command clean (sim) at raw angle (uncalibrated path).
            await _send(clean, "servo.set", {
                "duration": 0.4,
                "joint_positions": {joint: angle},
                "positions": [],
            })
            await asyncio.sleep(0.5)
            real_obs = await _read_obs(noisy, noisy_env, joint)
            sim_uncal_obs = await _read_obs(clean, clean_env, joint)
            uncal_err = None if real_obs is None or sim_uncal_obs is None else (
                real_obs - sim_uncal_obs
            )

            # Now command clean WITH calibration applied (calibrated path).
            await _send(calibrated, "servo.set", {
                "duration": 0.4,
                "joint_positions": {joint: angle},
                "positions": [],
            })
            await asyncio.sleep(0.5)
            sim_cal_obs = await _read_obs(clean, clean_env, joint)
            cal_err = None if real_obs is None or sim_cal_obs is None else (
                real_obs - sim_cal_obs
            )

            if uncal_err is not None:
                uncal_errs.append(uncal_err)
            if cal_err is not None:
                cal_errs.append(cal_err)
            per_angle.append({
                "commanded": angle, "real_obs": real_obs,
                "sim_uncal_obs": sim_uncal_obs,
                "sim_cal_obs": sim_cal_obs,
                "uncal_err_rad": uncal_err,
                "cal_err_rad": cal_err,
            })

        mean_uncal = float(np.mean(np.abs(uncal_errs)) * 1000) if uncal_errs else None
        mean_cal = float(np.mean(np.abs(cal_errs)) * 1000) if cal_errs else None
        reduction = None
        if mean_uncal and mean_cal is not None:
            reduction = float((mean_uncal - mean_cal) / max(mean_uncal, 1e-6) * 100)
        print(
            f"  {joint:14s} α={fit.strength:+.4f} β={fit.offset*1000:+.2f}mr  "
            f"uncal={mean_uncal:.2f}mr  cal={mean_cal:.2f}mr  "
            f"→ reduction {reduction:+.1f}%"
        )
        results.append({
            "joint": joint,
            "calibration": {"alpha": fit.strength, "beta": fit.offset, "rmse": fit.rmse},
            "mean_abs_uncal_mrad": mean_uncal,
            "mean_abs_cal_mrad": mean_cal,
            "reduction_pct": reduction,
            "per_angle": per_angle,
        })

    await clean.shutdown()
    await noisy_inner.shutdown()

    # Aggregate
    valid = [r for r in results if r["mean_abs_uncal_mrad"] is not None]
    if valid:
        agg_uncal = float(np.mean([r["mean_abs_uncal_mrad"] for r in valid]))
        agg_cal = float(np.mean([r["mean_abs_cal_mrad"] for r in valid]))
        agg_reduction = (agg_uncal - agg_cal) / max(agg_uncal, 1e-6) * 100
        print()
        print("=" * 60)
        print(f"AGGREGATE over {len(valid)} trustworthy joints:")
        print(f"  uncalibrated mean abs error: {agg_uncal:.2f} mrad")
        print(f"  calibrated   mean abs error: {agg_cal:.2f} mrad")
        print(f"  reduction:                   {agg_reduction:+.1f}%")
        agg = {
            "n_joints": len(valid),
            "uncal_mean_mrad": agg_uncal,
            "cal_mean_mrad": agg_cal,
            "reduction_pct": agg_reduction,
        }
    else:
        agg = {"n_joints": 0}

    (out_dir / "report.json").write_text(json.dumps({
        "noise_profile": "deterministic_only=True, seed=42",
        "results": results,
        "aggregate": agg,
    }, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "per_joint_sim",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
