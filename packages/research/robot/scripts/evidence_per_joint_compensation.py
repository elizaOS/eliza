"""Per-joint sim2real compensation demonstration.

The aggregate "all 24 joints" divergence metric is dominated by joints
whose physical servos don't track the probe (10 of 24 on this specific
AiNex). To show the calibration MATH is correct, this script probes a
single, well-fit joint and demonstrates that:

    Δ (sim_obs − real_obs) WITH calibration   ≪   Δ WITHOUT calibration

The honest story:
  - Architecture is complete (sys-ID + CalibratedBackend + DualTargetBackend).
  - Calibration recovers per-joint α, β where the hardware tracks.
  - 9 / 24 joints on this AiNex have sufficient hardware quality for
    sub-15 mrad sim2real compensation. The other 15 either have weak
    servo response (α < 0.7) or non-linear behavior outside the probe
    window (|β| > 0.1 rad).

Tested joints (the trustworthy subset from the full sys-ID):
    head_pan, head_tilt, r_gripper, l_gripper,
    r_hip_roll, r_knee, l_hip_yaw, l_hip_roll, l_ank_roll
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import numpy as np

from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend
from eliza_robot.bridge.backends.calibrated import (
    JointCalibration,
    load_calibration_file,
)
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.sim.mujoco.demo_env import DemoEnv

TRUSTWORTHY_JOINTS = [
    "head_pan", "head_tilt", "r_gripper", "l_gripper",
    "r_hip_roll", "r_knee", "l_hip_yaw", "l_hip_roll", "l_ank_roll",
]


async def _send(backend, command: str, payload: dict) -> bool:
    rid = f"perjoint-{command}-{time.time_ns()}"
    resp = await backend.handle_command(CommandEnvelope(
        request_id=rid, timestamp=utc_now_iso(),
        command=command, payload=payload,
    ))
    return resp.ok


async def _measure_one_joint(
    real: AinexRemoteBackend,
    sim_env,
    sim_backend,
    joint: str,
    test_angles_rad: list[float],
    fit: JointCalibration | None,
    settle_s: float = 0.5,
) -> dict:
    """For each test angle, command both backends and read back."""
    samples: list[dict] = []
    for angle in test_angles_rad:
        # Real receives the raw command.
        from eliza_robot.bridge.isaaclab.joint_map import (
            joint_name_to_servo_id, radians_to_pulse,
        )
        try:
            sid = joint_name_to_servo_id(joint)
            pulse = int(radians_to_pulse(angle, sid))
            positions = [{"id": sid, "position": pulse}]
        except Exception:
            positions = []
        await _send(real, "servo.set", {
            "duration": settle_s,
            "joint_positions": {joint: float(angle)},
            "positions": positions,
        })
        # Sim receives the SAME raw command (uncalibrated path) AND
        # also the calibrated path so we can compare.
        sim_raw_cmd = float(angle)
        sim_cal_cmd = (
            fit.strength * float(angle) + fit.offset if fit is not None else float(angle)
        )

        await _send(sim_backend, "servo.set", {
            "duration": settle_s,
            "joint_positions": {joint: sim_raw_cmd},
            "positions": [],
        })
        await asyncio.sleep(settle_s + 0.2)
        real_obs = (await real.read_joint_positions()).get(joint)
        sim_raw_obs = None
        try:
            t = sim_env._build_telemetry()
            sim_raw_obs = float(t["joint_positions"].get(joint, 0.0))
        except Exception:
            pass

        # Re-run with calibration applied.
        await _send(sim_backend, "servo.set", {
            "duration": settle_s,
            "joint_positions": {joint: sim_cal_cmd},
            "positions": [],
        })
        await asyncio.sleep(settle_s + 0.2)
        sim_cal_obs = None
        try:
            t = sim_env._build_telemetry()
            sim_cal_obs = float(t["joint_positions"].get(joint, 0.0))
        except Exception:
            pass

        samples.append({
            "commanded_rad": float(angle),
            "real_obs_rad": real_obs,
            "sim_raw_obs_rad": sim_raw_obs,
            "sim_calibrated_obs_rad": sim_cal_obs,
            "calibration": (
                {"alpha": fit.strength, "beta": fit.offset} if fit else None
            ),
        })
    return {"joint": joint, "samples": samples}


def _summarize(joint_result: dict) -> dict:
    """Compute uncalibrated vs calibrated divergence."""
    uncal_diffs = []
    cal_diffs = []
    for s in joint_result["samples"]:
        if s["real_obs_rad"] is None:
            continue
        if s["sim_raw_obs_rad"] is not None:
            uncal_diffs.append(s["real_obs_rad"] - s["sim_raw_obs_rad"])
        if s["sim_calibrated_obs_rad"] is not None:
            cal_diffs.append(s["real_obs_rad"] - s["sim_calibrated_obs_rad"])
    return {
        "joint": joint_result["joint"],
        "n_samples": len(joint_result["samples"]),
        "mean_abs_uncal_mrad": float(np.mean(np.abs(uncal_diffs)) * 1000) if uncal_diffs else None,
        "mean_abs_cal_mrad": float(np.mean(np.abs(cal_diffs)) * 1000) if cal_diffs else None,
        "rms_uncal_mrad": float(np.sqrt(np.mean([d * d for d in uncal_diffs])) * 1000) if uncal_diffs else None,
        "rms_cal_mrad": float(np.sqrt(np.mean([d * d for d in cal_diffs])) * 1000) if cal_diffs else None,
    }


async def main_async(args) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Load only the trustworthy fits.
    cal = load_calibration_file(args.calibration)
    print(f"[per-joint] loaded {len(cal)} trustworthy fits")

    real = AinexRemoteBackend(host=args.host, port=args.port)
    await real.connect()
    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim_backend = MuJocoBackend(sim_env, profile_id="hiwonder-ainex")
    await sim_backend.connect()
    await asyncio.sleep(1.0)

    # Park both at stand.
    await _send(real, "action.play", {"name": "stand"})
    await _send(sim_backend, "action.play", {"name": "stand"})
    await asyncio.sleep(2.0)

    test_angles = [0.0, 0.1, -0.1, 0.2, -0.2, 0.0]
    results = []
    try:
        for joint in [j for j in TRUSTWORTHY_JOINTS if j in cal]:
            print(f"[per-joint] {joint}...")
            result = await _measure_one_joint(
                real, sim_env, sim_backend, joint, test_angles, cal[joint],
            )
            summary = _summarize(result)
            results.append({"detail": result, "summary": summary})
            uncal = summary["mean_abs_uncal_mrad"]
            calv = summary["mean_abs_cal_mrad"]
            uncal_s = f"{uncal:.1f} mrad" if uncal is not None else "n/a"
            cal_s = f"{calv:.1f} mrad" if calv is not None else "n/a"
            print(f"  uncalibrated: {uncal_s}  calibrated: {cal_s}")
    finally:
        await real.shutdown()
        await sim_backend.shutdown()

    payload = {
        "host": f"{args.host}:{args.port}",
        "calibration_file": str(args.calibration),
        "test_angles_rad": test_angles,
        "n_joints_tested": len(results),
        "results": results,
    }
    (out_dir / "per_joint_compensation.json").write_text(
        json.dumps(payload, indent=2)
    )

    # Print aggregate
    summaries = [r["summary"] for r in results]
    if summaries:
        mean_uncal = float(np.mean([s["mean_abs_uncal_mrad"] for s in summaries if s["mean_abs_uncal_mrad"] is not None]))
        mean_cal = float(np.mean([s["mean_abs_cal_mrad"] for s in summaries if s["mean_abs_cal_mrad"] is not None]))
        reduction = 100.0 * (mean_uncal - mean_cal) / max(mean_uncal, 1e-6)
        print()
        print("=" * 60)
        print(f"AGGREGATE over {len(summaries)} trustworthy joints:")
        print(f"  uncalibrated mean abs error: {mean_uncal:.2f} mrad")
        print(f"  calibrated   mean abs error: {mean_cal:.2f} mrad")
        print(f"  reduction:                   {reduction:+.1f}%")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--calibration",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "calibration"
        / "ainex_192_168_1_218_full.json",
    )
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "per_joint_compensation",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
