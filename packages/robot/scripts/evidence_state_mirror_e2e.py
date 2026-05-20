"""State-mirror sim2real evidence — the unambiguous demonstration.

Pipeline:

    agent text → TextConditionedPolicy → 24-D joint targets
        │
        ▼
    DualTargetBackend (broadcasts to real + sim)
        │
        ▼
    StateMirrorBackend (out-of-band: real_obs → force sim.qpos)

The mirror task runs at ~20 Hz, pulling the real robot's measured
joint angles and force-writing them into the MuJoCo sim's qpos. Sim
becomes a state-locked twin of real.

Outputs in `--out`:
  - mirror_e2e_sim.mp4         external MuJoCo view (now mirroring real)
  - report.json                per-prompt steps + mirror.stats
  - divergence_plot.png        sim2real divergence over time
                               (should collapse to encoder noise)

Run baseline (no mirror) to A/B:
    --no-mirror
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
from eliza_robot.bridge.backends.dual_target import DualTargetBackend
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.backends.state_mirror import StateMirrorBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.rl.text_conditioned.inference_loop import (
    InferenceLoopConfig,
    run_inference,
)
from eliza_robot.sim.mujoco.demo_env import DemoEnv


async def _measure_divergence(real_pos: dict, sim_pos: dict) -> dict:
    keys = set(real_pos) & set(sim_pos)
    if not keys:
        return {"rms_mrad": 0.0, "max_mrad": 0.0, "n": 0}
    diffs = [float(real_pos[k]) - float(sim_pos[k]) for k in keys]
    rms = float(np.sqrt(np.mean([d * d for d in diffs])) * 1000)
    mx = float(max(abs(d) for d in diffs) * 1000)
    return {"rms_mrad": rms, "max_mrad": mx, "n": len(keys)}


async def _read_sim_joints(sim_env) -> dict[str, float]:
    try:
        return {
            name: float(sim_env.data.qpos[sim_env._act_qpos_idx[idx]])
            for name, idx in sim_env._act_name_to_idx.items()
        }
    except Exception:
        return {}


async def _run(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    real = AinexRemoteBackend(host=args.host, port=args.port)
    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim = MuJocoBackend(sim_env, profile_id="hiwonder-ainex")
    dual = DualTargetBackend(real=real, sim=sim)

    if args.no_mirror:
        backend = dual
        print(f"[mirror-e2e] MIRROR DISABLED (baseline A/B)")
    else:
        backend = StateMirrorBackend(
            dual, real=real, sim_env=sim_env,
            sync_period_s=args.mirror_period,
        )
        print(f"[mirror-e2e] mirror enabled, sync period {args.mirror_period*1000:.0f} ms")

    await backend.connect()
    await asyncio.sleep(2.0)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    sim_sample = sim_env.render_external(width=1280, height=720)
    sim_writer = cv2.VideoWriter(
        str(out / "mirror_e2e_sim.mp4"), fourcc, args.fps,
        (sim_sample.shape[1], sim_sample.shape[0]),
    )

    prompts = [p.strip() for p in args.prompts.split(",") if p.strip()]
    per_prompt = []
    divergence_log = []

    try:
        for prompt in prompts:
            print(f"[mirror-e2e] >>> {prompt!r}")
            t0 = time.time()
            cfg = InferenceLoopConfig(
                hz=args.policy_hz,
                max_steps=int(args.episode_s * args.policy_hz),
                action_scale=0.3,
            )
            inference_task = asyncio.create_task(
                run_inference(backend, args.checkpoint, prompt, config=cfg)
            )
            t_end = time.time() + args.episode_s
            frame_period = 1.0 / args.fps
            while time.time() < t_end:
                try:
                    real_pos = await real.read_joint_positions()
                except Exception:
                    real_pos = {}
                sim_pos = await _read_sim_joints(sim_env)
                div = await _measure_divergence(real_pos, sim_pos)
                if div["n"] > 0:
                    div["t_s"] = time.time() - t0
                    div["prompt"] = prompt
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
                tag = "mirror ON" if not args.no_mirror else "mirror OFF (baseline)"
                cv2.putText(bgr, f"{prompt}  [{tag}]", (16, h - 38),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (240, 240, 240), 2)
                cv2.putText(
                    bgr,
                    f"sim2real RMS={div['rms_mrad']:.1f} mrad "
                    f"max={div['max_mrad']:.1f} mrad",
                    (16, h - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                    (140, 240, 140) if not args.no_mirror else (140, 180, 240), 1,
                )
                sim_writer.write(bgr)
                await asyncio.sleep(max(0.0, frame_period - 0.005))

            result = await inference_task
            per_prompt.append({
                "prompt": prompt,
                "duration_s": round(time.time() - t0, 2),
                "matched_task": result["matched_task_id"],
                "steps_completed": result["steps_completed"],
            })
    finally:
        sim_writer.release()
        await backend.shutdown()

    summary = {
        "checkpoint": str(args.checkpoint),
        "mirror_enabled": not args.no_mirror,
        "mirror_period_s": args.mirror_period if not args.no_mirror else None,
        "host": f"{args.host}:{args.port}",
        "policy_hz": args.policy_hz,
        "episode_s": args.episode_s,
        "prompts": per_prompt,
        "divergence_samples": len(divergence_log),
        "mean_rms_mrad": float(np.mean([d["rms_mrad"] for d in divergence_log])) if divergence_log else None,
        "median_rms_mrad": float(np.median([d["rms_mrad"] for d in divergence_log])) if divergence_log else None,
        "max_rms_mrad": float(max([d["rms_mrad"] for d in divergence_log])) if divergence_log else None,
        "p95_rms_mrad": float(np.percentile([d["rms_mrad"] for d in divergence_log], 95)) if divergence_log else None,
    }
    (out / "report.json").write_text(json.dumps(summary, indent=2))
    print(f"[mirror-e2e] wrote {out / 'report.json'}")

    if divergence_log:
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            ts = [d["t_s"] for d in divergence_log]
            rms = [d["rms_mrad"] for d in divergence_log]
            fig, ax = plt.subplots(figsize=(8, 4))
            ax.plot(ts, rms, "g-" if not args.no_mirror else "b-", lw=1.5)
            ax.set_xlabel("t (s)")
            ax.set_ylabel("sim2real RMS (mrad)")
            ax.set_title(
                f"sim2real divergence — mirror "
                f"{'ON' if not args.no_mirror else 'OFF'}"
            )
            ax.grid(True, alpha=0.3)
            plt.tight_layout()
            plt.savefig(out / "divergence_plot.png", dpi=120)
            plt.close()
            print(f"[mirror-e2e] wrote {out / 'divergence_plot.png'}")
        except ImportError:
            pass

    if summary["mean_rms_mrad"] is not None:
        print(
            f"[mirror-e2e] divergence — mean {summary['mean_rms_mrad']:.1f} mrad, "
            f"median {summary['median_rms_mrad']:.1f}, "
            f"p95 {summary['p95_rms_mrad']:.1f}, "
            f"max {summary['max_rms_mrad']:.1f}"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "checkpoints" / "text_conditioned_v2",
    )
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument(
        "--prompts",
        default="stand still,wave hello,turn left,walk forward",
    )
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--policy-hz", type=float, default=8.0)
    parser.add_argument("--episode-s", type=float, default=4.0)
    parser.add_argument("--mirror-period", type=float, default=0.10)
    parser.add_argument(
        "--no-mirror", action="store_true",
        help="disable mirror for baseline A/B",
    )
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "state_mirror_e2e",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
