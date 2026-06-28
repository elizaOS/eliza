"""Sim + real co-execution with ArUco anchoring and sim2real divergence
tracking — the integration vehicle for the FINAL GOAL.

What this does:

  1. Opens a `DualTargetBackend` (real AiNex via rosbridge + MuJoCo DemoEnv).
  2. Opens the Obsbot camera and detects ArUco markers each frame.
  3. Anchors the MuJoCo sim's free joint to the real robot's torso pose
     (recovered via ArUco) every ~1 s.
  4. For each task in a chosen task list:
       - issues the bridge command(s) (programmatic mode) OR
         `policy.start{task=...}` (RL mode once a checkpoint exists)
       - records both onboard + Obsbot frames
       - tracks per-frame divergence (real_pos − sim_pos, real_yaw − sim_yaw)
  5. At the end, writes:
       - sim_real_co_execution.mp4         (Obsbot, with ArUco overlay)
       - sim_real_co_execution_sim.mp4     (MuJoCo external camera)
       - sim_real_divergence_plot.png      (RMS dx/dy/dyaw over time)
       - report.json                       (numerical summary)

Usage:

    PYTHONPATH=packages/robot python packages/robot/scripts/evidence_sim_real_co_execution.py \
        --host 192.168.1.218 --port 9090 --obsbot-device 4 \
        --tasks stand_up,walk_forward,turn_left --use-rl=false

    # Once a text-conditioned checkpoint exists, swap --use-rl=true and the
    # script routes through policy.start instead of programmatic commands.
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
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetector
from eliza_robot.sim.mujoco.demo_env import DemoEnv
from eliza_robot.sim2real.aruco_anchor import (
    anchor_mujoco_env,
    detect_robot_pose,
    measure_divergence,
)


def _label(frame: np.ndarray, lines: list[str]) -> np.ndarray:
    out = frame.copy()
    overlay = out.copy()
    h, w = out.shape[:2]
    cv2.rectangle(overlay, (0, h - 26 * (len(lines) + 1)), (w, h), (0, 0, 0), -1)
    out = cv2.addWeighted(overlay, 0.55, out, 0.45, 0)
    y = h - 26 * len(lines) - 4
    for ln in lines:
        cv2.putText(out, ln, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (240, 240, 240), 1)
        y += 26
    return out


def _build_drive(task_id: str, curriculum) -> list[tuple[str, dict, bool]]:
    """Map curriculum task → bridge commands (programmatic baseline)."""
    spec = curriculum.by_id(task_id)
    r = spec.reward
    if task_id == "stand_up":
        return [("action.play", {"name": "stand"}, False)]
    if task_id == "sit_down":
        return [("action.play", {"name": "sit"}, False)]
    if task_id == "walk_forward":
        return [
            ("walk.set", {"speed": 1, "height": 0.036, "x": 0.02, "y": 0.0, "yaw": 0.0}, False),
            ("walk.command", {"action": "start"}, False),
        ]
    if task_id == "turn_left":
        return [
            ("walk.set", {"speed": 1, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": 4.0}, False),
            ("walk.command", {"action": "start"}, False),
        ]
    if task_id == "turn_right":
        return [
            ("walk.set", {"speed": 1, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": -4.0}, False),
            ("walk.command", {"action": "start"}, False),
        ]
    if task_id == "wave_left" or task_id == "wave_right":
        return [("action.play", {"name": "wave"}, False)]
    if task_id == "bow" or task_id == "look_down":
        return [("action.play", {"name": "bow"}, False)]
    return [("action.play", {"name": "stand"}, False)]


async def _run(args) -> int:
    curriculum = load_curriculum()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Build the dual-target backend.
    real = AinexRemoteBackend(host=args.host, port=args.port)
    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim = MuJocoBackend(sim_env, profile_id="hiwonder-ainex")
    dual = DualTargetBackend(real=real, sim=sim)
    print(f"[co-exec] connecting (real {args.host}:{args.port} + MuJoCo sim)...")
    await dual.connect()
    print("[co-exec] connected")
    await asyncio.sleep(1.5)

    # Obsbot for ArUco anchoring.
    obsbot = cv2.VideoCapture(args.obsbot_device, cv2.CAP_V4L2)
    obsbot.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    obsbot.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    obsbot.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    first = None
    for _ in range(15):
        ok, fr = obsbot.read()
        if ok and fr is not None and fr.size > 0:
            first = fr
            break
        await asyncio.sleep(0.05)
    if first is None:
        obsbot.release()
        print(
            f"[co-exec] Obsbot at /dev/video{args.obsbot_device} unavailable; "
            f"continuing without ArUco anchor"
        )
        intrinsics = None
        detector = None
    else:
        h, w = first.shape[:2]
        fx = w / (2 * np.tan(np.radians(43.0)))
        intrinsics = CameraIntrinsics(
            fx=fx, fy=fx, cx=w / 2, cy=h / 2, width=w, height=h
        )
        detector = ArucoDetector(intrinsics, marker_size_m=0.05)
        print(f"[co-exec] Obsbot @ /dev/video{args.obsbot_device} -> {w}x{h}")

    # Video writers.
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    ext_writer = None
    sim_writer = None
    if first is not None:
        ext_writer = cv2.VideoWriter(
            str(out_dir / "sim_real_co_execution.mp4"),
            fourcc, args.fps, (first.shape[1], first.shape[0]),
        )
    # Sim external view
    sim_sample = sim_env.render_external(width=1280, height=720)
    sim_writer = cv2.VideoWriter(
        str(out_dir / "sim_real_co_execution_sim.mp4"),
        fourcc, args.fps, (sim_sample.shape[1], sim_sample.shape[0]),
    )

    divergence_log: list[dict] = []
    per_task_results: list[dict] = []

    async def _send(cmd, payload, preempt=False):
        rid = f"co-{cmd}-{time.time_ns()}"
        env = CommandEnvelope(
            request_id=rid, timestamp=utc_now_iso(),
            command=cmd, payload=payload, preempt=preempt,
        )
        return await dual.handle_command(env)

    tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
    if not tasks:
        tasks = ["stand_up", "walk_forward", "turn_left"]
    print(f"[co-exec] running tasks: {tasks} (use_rl={args.use_rl})")

    try:
        for task_id in tasks:
            spec = curriculum.by_id(task_id)
            print(f"[co-exec] >>> {task_id}")
            t0 = time.time()
            if args.use_rl:
                await _send("policy.start", {
                    "task": task_id, "canonical_action": task_id,
                    "hz": 10, "max_steps": int(spec.max_episode_s * 50),
                })
            else:
                for cmd, payload, preempt in _build_drive(task_id, curriculum):
                    await _send(cmd, payload, preempt)

            # Hold the task for hold_s.
            hold_s = min(spec.max_episode_s, args.max_task_s)
            t_hold0 = time.time()
            while time.time() - t_hold0 < hold_s:
                ms = int((time.time() - t0) * 1000)
                # Real frame + ArUco
                divergence = None
                pose = None
                if obsbot is not None and ext_writer is not None and detector is not None:
                    ok, frame = obsbot.read()
                    if ok and frame is not None:
                        annotated = frame.copy()
                        pose = detect_robot_pose(
                            frame[:, :, ::-1].copy(), intrinsics,
                            detector=detector,
                        )
                        if pose is not None:
                            divergence = measure_divergence(sim_env, pose)
                            if args.anchor:
                                anchor_mujoco_env(sim_env, pose)
                            # Annotate with detected markers
                            for d in detector.detect(frame):
                                cv2.aruco.drawDetectedMarkers(
                                    annotated, [d.corners.reshape(1, 4, 2)],
                                    np.array([[d.marker_id]]),
                                )
                        lines = [task_id, f"t+{ms} ms"]
                        if divergence is not None:
                            lines.append(
                                f"sim2real RMS={divergence['rms_xy_m']*100:.1f}cm "
                                f"|Δyaw|={abs(divergence['dyaw_deg']):.1f}°"
                            )
                        ext_writer.write(_label(annotated, lines))
                # Sim frame
                sim_frame = sim_env.render_external(width=sim_sample.shape[1], height=sim_sample.shape[0])
                sim_writer.write(_label(
                    sim_frame[:, :, ::-1].copy(),
                    [f"{task_id} [sim]", f"t+{ms} ms"],
                ))
                if divergence is not None:
                    divergence["t_s"] = time.time() - t0
                    divergence["task_id"] = task_id
                    divergence_log.append(divergence)
                await asyncio.sleep(max(0.0, 1.0 / args.fps - 0.01))

            # post-stop
            await _send("walk.command", {"action": "stop"}, True)
            if args.use_rl:
                await _send("policy.stop", {"reason": "task_done"})

            per_task_results.append({
                "task_id": task_id,
                "duration_s": round(time.time() - t0, 2),
                "samples": sum(1 for d in divergence_log if d["task_id"] == task_id),
            })
    finally:
        await _send("walk.command", {"action": "stop"}, True)
        await _send("action.play", {"name": "stand"}, False)
        if ext_writer is not None:
            ext_writer.release()
        if sim_writer is not None:
            sim_writer.release()
        if obsbot is not None:
            obsbot.release()
        await dual.shutdown()

    # Save divergence plot + report.
    if divergence_log:
        try:
            import matplotlib

            matplotlib.use("Agg")
            import matplotlib.pyplot as plt

            ts = [d["t_s"] for d in divergence_log]
            rms = [d["rms_xy_m"] * 100 for d in divergence_log]
            dyaw = [abs(d["dyaw_deg"]) for d in divergence_log]
            fig, ax1 = plt.subplots(figsize=(8, 4))
            ax1.plot(ts, rms, "b-", label="RMS xy [cm]")
            ax1.set_xlabel("time (s)")
            ax1.set_ylabel("RMS xy (cm)", color="b")
            ax2 = ax1.twinx()
            ax2.plot(ts, dyaw, "r-", label="|Δyaw| [°]")
            ax2.set_ylabel("|Δyaw| (°)", color="r")
            plt.title("sim2real divergence over co-execution")
            plt.tight_layout()
            plt.savefig(out_dir / "sim_real_divergence_plot.png", dpi=120)
            plt.close()
            print(f"[co-exec] wrote {out_dir / 'sim_real_divergence_plot.png'}")
        except ImportError:
            print("[co-exec] matplotlib not available; skipping divergence plot")

    report = {
        "host": f"{args.host}:{args.port}",
        "obsbot_device": f"/dev/video{args.obsbot_device}",
        "use_rl": args.use_rl,
        "anchor": args.anchor,
        "tasks": per_task_results,
        "divergence_samples": len(divergence_log),
        "divergence_mean_rms_cm": round(
            float(np.mean([d["rms_xy_m"] * 100 for d in divergence_log])), 2
        ) if divergence_log else None,
        "divergence_mean_dyaw_deg": round(
            float(np.mean([abs(d["dyaw_deg"]) for d in divergence_log])), 2
        ) if divergence_log else None,
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2))
    print(f"[co-exec] wrote {out_dir / 'report.json'}")
    print(f"[co-exec] {len(per_task_results)} tasks executed sim+real, "
          f"{len(divergence_log)} divergence samples")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--obsbot-device", type=int, default=4)
    parser.add_argument("--tasks", default="stand_up,walk_forward,turn_left,wave_left")
    parser.add_argument("--use-rl", type=lambda v: v.lower() == "true", default=False)
    parser.add_argument("--anchor", type=lambda v: v.lower() == "true", default=True,
                        help="snap sim's free joint to ArUco pose each frame")
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--max-task-s", type=float, default=5.0,
                        help="cap any single task's duration to this many seconds")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence"
        / "co_execution",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
