"""FINAL_GOAL evidence: agent text → trained policy → CALIBRATED sim + real,
both moving in lockstep, with per-joint sim2real compensation applied.

Pipeline:

    text prompt
        │
        ▼
    TextConditionedPolicy.act(text, proprio) → 24-D joint targets
        │
        ▼
    DualTargetBackend
       ├─→ real AiNex (raw)              ───── these two now produce
       └─→ Calibrated(sim)               ───── matching observed states

Where Calibrated(sim) applies α_i, β_i recovered from a previous run
of `evidence_real_robot_sysid.py` to each outgoing joint target.

Outputs in `--out`:
  - report.json                     per-prompt steps, sim/real responses
  - sim_real_calibrated.mp4         live Obsbot footage if available
  - sim_real_calibrated_sim.mp4     external MuJoCo view
  - divergence_plot.png             RMS divergence (calibrated vs uncalibrated)

If no calibration file is given, behaves identically to the raw e2e.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend
from eliza_robot.bridge.backends.calibrated import CalibratedBackend
from eliza_robot.bridge.backends.dual_target import DualTargetBackend
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.rl.text_conditioned.inference_loop import (
    InferenceLoopConfig,
    run_inference,
)
from eliza_robot.sim.mujoco.demo_env import DemoEnv


async def _build_backend(args):
    """Real + (optionally calibrated) sim, wrapped in DualTargetBackend."""
    real = AinexRemoteBackend(host=args.host, port=args.port)
    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim = MuJocoBackend(sim_env, profile_id="hiwonder-ainex")
    if args.calibration is not None and Path(args.calibration).is_file():
        sim_wrapped = CalibratedBackend.from_file(sim, args.calibration)
        print(f"[e2e] calibrated sim with {args.calibration}")
        sim = sim_wrapped
    dual = DualTargetBackend(real=real, sim=sim)
    await dual.connect()
    return dual, sim_env


async def _measure_divergence(real_pos: dict, sim_pos: dict) -> dict:
    """Compute per-joint divergence between two pose dicts."""
    keys = set(real_pos) & set(sim_pos)
    if not keys:
        return {"rms_joint_rad": 0.0, "max_joint_rad": 0.0, "n": 0}
    diffs = [float(real_pos[k]) - float(sim_pos[k]) for k in keys]
    rms = float(np.sqrt(np.mean([d * d for d in diffs])))
    mx = float(max(abs(d) for d in diffs))
    return {"rms_joint_rad": rms, "max_joint_rad": mx, "n": len(keys)}


async def _read_real_joints(real: AinexRemoteBackend) -> dict[str, float]:
    try:
        return await real.read_joint_positions()
    except Exception:
        return {}


async def _read_sim_joints(sim_env) -> dict[str, float]:
    try:
        telemetry = sim_env._build_telemetry()
        return {
            name: float(telemetry["joint_positions"][name])
            for name in sim_env.joint_names
            if name in telemetry["joint_positions"]
        }
    except Exception:
        return {}


async def _run(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    backend, sim_env = await _build_backend(args)
    real_inner = backend._real  # type: ignore[attr-defined]
    print(f"[e2e] dual backend ready (calibration: {args.calibration is not None})")

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    sim_sample = sim_env.render_external(width=1280, height=720)
    sim_writer = cv2.VideoWriter(
        str(out / "sim_real_calibrated_sim.mp4"), fourcc, args.fps,
        (sim_sample.shape[1], sim_sample.shape[0]),
    )

    prompts = [p.strip() for p in args.prompts.split(",") if p.strip()]
    per_prompt = []
    divergence_log: list[dict] = []

    try:
        for prompt in prompts:
            print(f"[e2e] >>> {prompt!r}")
            t0 = time.time()
            cfg = InferenceLoopConfig(
                hz=args.policy_hz,
                max_steps=int(args.episode_s * args.policy_hz),
                action_scale=0.3,
            )
            inference_task = asyncio.create_task(
                run_inference(backend, args.checkpoint, prompt, config=cfg)
            )

            # Concurrent watcher records sim frames + per-tick divergence.
            t_end = time.time() + args.episode_s
            frame_period = 1.0 / args.fps
            while time.time() < t_end:
                real_pos = await _read_real_joints(real_inner)
                sim_pos = await _read_sim_joints(sim_env)
                div = await _measure_divergence(real_pos, sim_pos)
                div["t_s"] = time.time() - t0
                div["prompt"] = prompt
                if div["n"] > 0:
                    divergence_log.append(div)
                # Render sim
                sim_frame = sim_env.render_external(
                    width=sim_sample.shape[1], height=sim_sample.shape[0],
                )
                bgr = sim_frame[:, :, ::-1].copy()
                h, w = bgr.shape[:2]
                overlay = bgr.copy()
                cv2.rectangle(overlay, (0, h - 70), (w, h), (0, 0, 0), -1)
                bgr = cv2.addWeighted(overlay, 0.6, bgr, 0.4, 0)
                cv2.putText(bgr, prompt, (16, h - 38),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (240, 240, 240), 2)
                cv2.putText(
                    bgr,
                    f"sim2real RMS={div['rms_joint_rad']*1000:.1f} mrad "
                    f"max={div['max_joint_rad']*1000:.1f} mrad",
                    (16, h - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 230, 180), 1,
                )
                sim_writer.write(bgr)
                await asyncio.sleep(max(0.0, frame_period - 0.005))

            inference_result = await inference_task
            per_prompt.append({
                "prompt": prompt,
                "duration_s": round(time.time() - t0, 2),
                "matched_task": inference_result["matched_task_id"],
                "similarity": round(inference_result["similarity"], 3),
                "steps_completed": inference_result["steps_completed"],
            })
    finally:
        sim_writer.release()
        await backend.shutdown()

    if divergence_log:
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            ts = [d["t_s"] for d in divergence_log]
            rms = [d["rms_joint_rad"] * 1000 for d in divergence_log]
            mx = [d["max_joint_rad"] * 1000 for d in divergence_log]
            fig, ax = plt.subplots(figsize=(8, 4))
            ax.plot(ts, rms, "b-", label="RMS sim2real joint divergence (mrad)")
            ax.plot(ts, mx, "r--", alpha=0.4, label="max joint divergence (mrad)")
            ax.set_xlabel("t (s)")
            ax.set_ylabel("divergence (mrad)")
            ax.set_title(
                "sim2real joint-position divergence during calibrated e2e"
                + (" (calibrated)" if args.calibration else " (uncalibrated)")
            )
            ax.grid(True, alpha=0.3)
            ax.legend()
            plt.tight_layout()
            plt.savefig(out / "divergence_plot.png", dpi=120)
            plt.close()
            print(f"[e2e] wrote {out / 'divergence_plot.png'}")
        except ImportError:
            pass

    summary = {
        "checkpoint": str(args.checkpoint),
        "calibration": str(args.calibration) if args.calibration else None,
        "host": f"{args.host}:{args.port}",
        "policy_hz": args.policy_hz,
        "episode_s": args.episode_s,
        "prompts": per_prompt,
        "divergence_samples": len(divergence_log),
        "divergence_mean_rms_mrad": float(np.mean([d["rms_joint_rad"]*1000 for d in divergence_log])) if divergence_log else None,
        "divergence_max_rms_mrad": float(max([d["rms_joint_rad"]*1000 for d in divergence_log])) if divergence_log else None,
    }
    (out / "report.json").write_text(json.dumps(summary, indent=2))
    print(f"[e2e] wrote {out / 'report.json'}")
    if summary["divergence_mean_rms_mrad"] is not None:
        print(
            f"[e2e] sim2real divergence — mean {summary['divergence_mean_rms_mrad']:.1f} mrad, "
            f"max {summary['divergence_max_rms_mrad']:.1f} mrad"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "checkpoints" / "text_conditioned_v2",
    )
    parser.add_argument(
        "--calibration",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "calibration"
        / "ainex_192_168_1_218.json",
    )
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument(
        "--prompts",
        default="stand still,wave hello,turn left",
    )
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--policy-hz", type=float, default=8.0)
    parser.add_argument("--episode-s", type=float, default=4.0)
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "examples" / "robot-mujoco-demo"
        / "evidence" / "calibrated_e2e",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
