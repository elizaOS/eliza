"""End-to-end demo: agent issues TEXT, trained policy emits JOINT TARGETS,
both MuJoCo sim and real AiNex move in lock-step.

This is the FINAL_GOAL gate. The flow:

  user text  ──→  TextConditionedPolicy.act(text, proprio)
                       │
                       ▼
            24-D joint targets
                       │
                       ▼
                 servo.set
                       │
                       ▼
            DualTargetBackend
              ├─→ real AiNex (rosbridge_suite)
              └─→ MuJoCo DemoEnv

A separate Obsbot camera tracks ArUco markers and the loop continuously
measures (and optionally corrects) sim2real divergence.

Outputs in `--out`:
  - text_to_action_e2e.mp4              external (Obsbot) view
  - text_to_action_e2e_sim.mp4          MuJoCo external view
  - text_to_action_e2e_robot_cam.mp4    AiNex onboard view
  - report.json                         per-text-prompt steps + divergence
  - divergence_plot.png                 RMS xy and |Δyaw| over time

This script is intended to be run AFTER training completes (locally or
on Nebius) and the checkpoint has been rsynced back. For sim-only
verification (no real robot in the loop), pass `--no-real`.
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
from eliza_robot.bridge.backends.asimov_mujoco import AsimovMujocoBackend
from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend
from eliza_robot.bridge.backends.dual_target import DualTargetBackend
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetector
from eliza_robot.rl.text_conditioned.inference_loop import (
    InferenceLoopConfig,
    run_inference,
)
from eliza_robot.sim.mujoco.demo_env import DemoEnv
from eliza_robot.sim2real.aruco_anchor import (
    detect_robot_pose,
    measure_divergence,
)


def _load_manifest(checkpoint: Path) -> dict:
    manifest = checkpoint / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"missing checkpoint manifest: {manifest}")
    return json.loads(manifest.read_text(encoding="utf-8"))


def _resolve_profile(args) -> str:
    manifest = _load_manifest(Path(args.checkpoint))
    manifest_profile = str(manifest.get("profile_id") or "")
    if not manifest_profile:
        raise ValueError(f"checkpoint manifest has no profile_id: {args.checkpoint}")
    requested = args.profile or manifest_profile
    if requested != manifest_profile:
        raise ValueError(
            "checkpoint profile mismatch: "
            f"manifest profile_id={manifest_profile!r}, requested profile={requested!r}"
        )
    args.profile = requested
    return requested


async def _build_backend(args) -> tuple:
    """Return (backend, env-or-None) for the chosen topology."""
    if args.profile == "asimov-1":
        if args.no_real:
            backend = AsimovMujocoBackend(profile_id=args.profile)
            await backend.connect()
            return backend, None
        real = AsimovRemoteBackend(host=args.host, port=args.port, profile_id=args.profile)
        await real.connect()
        return real, None

    if args.profile != "hiwonder-ainex":
        raise ValueError(
            "text-to-action evidence currently supports HiWonder AiNex and ASIMOV-1; "
            f"got profile {args.profile!r}"
        )

    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim = MuJocoBackend(sim_env, profile_id=args.profile)
    if args.no_real:
        await sim.connect()
        return sim, sim_env
    real = AinexRemoteBackend(host=args.host, port=args.port)
    dual = DualTargetBackend(real=real, sim=sim)
    await dual.connect()
    return dual, sim_env


async def _run(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    profile_id = _resolve_profile(args)

    backend, sim_env = await _build_backend(args)
    print(f"[e2e] backend ready: {backend.backend_name}")

    obsbot = None
    detector = None
    intrinsics = None
    if not args.no_obsbot:
        try:
            cap = cv2.VideoCapture(args.obsbot_device, cv2.CAP_V4L2)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
            for _ in range(15):
                ok, fr = cap.read()
                if ok and fr is not None and fr.size > 0:
                    h, w = fr.shape[:2]
                    fx = w / (2 * np.tan(np.radians(43.0)))
                    intrinsics = CameraIntrinsics(
                        fx=fx, fy=fx, cx=w / 2, cy=h / 2, width=w, height=h,
                    )
                    detector = ArucoDetector(intrinsics, marker_size_m=0.05)
                    obsbot = cap
                    print(f"[e2e] Obsbot @ /dev/video{args.obsbot_device} -> {w}x{h}")
                    break
                await asyncio.sleep(0.05)
            if obsbot is None:
                cap.release()
        except Exception as exc:
            print(f"[e2e] no Obsbot ({exc})")

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    ext_writer = None
    if obsbot is not None:
        ok, sample = obsbot.read()
        if ok:
            ext_writer = cv2.VideoWriter(
                str(out / "text_to_action_e2e.mp4"), fourcc, args.fps,
                (sample.shape[1], sample.shape[0]),
            )
    sim_writer = None
    sim_sample = None
    if sim_env is not None:
        sim_sample = sim_env.render_external(width=1280, height=720)
        sim_writer = cv2.VideoWriter(
            str(out / "text_to_action_e2e_sim.mp4"), fourcc, args.fps,
            (sim_sample.shape[1], sim_sample.shape[0]),
        )
    robot_cam_writer: cv2.VideoWriter | None = None

    divergence_log: list[dict] = []
    per_prompt: list[dict] = []

    prompts = [t.strip() for t in args.prompts.split(",") if t.strip()]
    print(f"[e2e] {len(prompts)} prompts queued: {prompts}")

    async def _watch(prompt: str, episode_max_s: float) -> dict:
        """Record frames + divergence while a single inference episode runs."""
        t0 = time.time()
        last_record_t = 0.0
        frame_period = 1.0 / args.fps
        samples = 0
        while time.time() - t0 < episode_max_s:
            now = time.time()
            if now - last_record_t < frame_period:
                await asyncio.sleep(0.01)
                continue
            last_record_t = now
            divergence = None
            if obsbot is not None and ext_writer is not None and detector is not None:
                ok, frame = obsbot.read()
                if ok and frame is not None:
                    pose = detect_robot_pose(
                        frame[:, :, ::-1].copy(), intrinsics, detector=detector,
                    )
                    annotated = frame.copy()
                    for d in detector.detect(frame):
                        cv2.aruco.drawDetectedMarkers(
                            annotated, [d.corners.reshape(1, 4, 2)],
                            np.array([[d.marker_id]]),
                        )
                    label = [f'"{prompt}"', f"t+{int((now-t0)*1000)} ms"]
                    if pose is not None and sim_env is not None:
                        divergence = measure_divergence(sim_env, pose)
                        label.append(
                            f"sim2real {divergence['rms_xy_m']*100:.1f} cm  "
                            f"|Δyaw|={abs(divergence['dyaw_deg']):.1f}°"
                        )
                    # banner
                    h_, w_ = annotated.shape[:2]
                    overlay = annotated.copy()
                    cv2.rectangle(overlay, (0, h_-26*(len(label)+1)), (w_, h_), (0,0,0), -1)
                    annotated = cv2.addWeighted(overlay, 0.6, annotated, 0.4, 0)
                    y = h_ - 26*len(label) - 4
                    for ln in label:
                        cv2.putText(annotated, ln, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (240,240,240), 1)
                        y += 26
                    ext_writer.write(annotated)
            # sim frame
            if sim_env is not None and sim_writer is not None and sim_sample is not None:
                sim_frame = sim_env.render_external(
                    width=sim_sample.shape[1],
                    height=sim_sample.shape[0],
                )
                sim_writer.write(sim_frame[:, :, ::-1])
            samples += 1
            if divergence is not None:
                divergence["t_s"] = now - t0
                divergence["prompt"] = prompt
                divergence_log.append(divergence)
        return {"frames": samples}

    try:
        for prompt in prompts:
            print(f"[e2e] >>> prompt: {prompt!r}")
            t0 = time.time()
            # Run the inference loop and a parallel watcher simultaneously.
            cfg = InferenceLoopConfig(
                hz=args.policy_hz,
                max_steps=int(args.episode_s * args.policy_hz),
                action_scale=0.3,
                profile_id=profile_id,
            )
            inference_task = asyncio.create_task(
                run_inference(backend, args.checkpoint, prompt, config=cfg)
            )
            watcher_task = asyncio.create_task(
                _watch(prompt, episode_max_s=args.episode_s)
            )
            inference_result, watcher_result = await asyncio.gather(
                inference_task, watcher_task,
            )
            duration = time.time() - t0
            per_prompt.append({
                "prompt": prompt,
                "duration_s": round(duration, 2),
                "matched_task": inference_result["matched_task_id"],
                "similarity": round(inference_result["similarity"], 3),
                "steps_completed": inference_result["steps_completed"],
                "video_frames": watcher_result["frames"],
            })
    finally:
        if ext_writer is not None:
            ext_writer.release()
        if sim_writer is not None:
            sim_writer.release()
        if robot_cam_writer is not None:
            robot_cam_writer.release()
        if obsbot is not None:
            obsbot.release()
        await backend.shutdown()

    # Divergence plot
    if divergence_log:
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            ts = [d["t_s"] for d in divergence_log]
            rms = [d["rms_xy_m"] * 100 for d in divergence_log]
            dy = [abs(d["dyaw_deg"]) for d in divergence_log]
            fig, ax1 = plt.subplots(figsize=(8, 4))
            ax1.plot(ts, rms, "b-", label="RMS xy (cm)")
            ax1.set_xlabel("t (s)")
            ax1.set_ylabel("RMS xy (cm)", color="b")
            ax2 = ax1.twinx()
            ax2.plot(ts, dy, "r-", label="|Δyaw| (°)")
            ax2.set_ylabel("|Δyaw| (°)", color="r")
            plt.title("sim2real divergence during text→action e2e")
            plt.tight_layout()
            plt.savefig(out / "divergence_plot.png", dpi=120)
            plt.close()
            print(f"[e2e] wrote {out / 'divergence_plot.png'}")
        except ImportError:
            pass

    report = {
        "checkpoint": str(args.checkpoint),
        "profile_id": profile_id,
        "backend": backend.backend_name,
        "host": f"{args.host}:{args.port}",
        "no_real": args.no_real,
        "policy_hz": args.policy_hz,
        "episode_s": args.episode_s,
        "prompts": per_prompt,
        "divergence_samples": len(divergence_log),
        "divergence_mean_rms_cm": float(np.mean([d["rms_xy_m"]*100 for d in divergence_log])) if divergence_log else None,
        "divergence_mean_dyaw_deg": float(np.mean([abs(d["dyaw_deg"]) for d in divergence_log])) if divergence_log else None,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(f"[e2e] wrote {out / 'report.json'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "checkpoints" / "alberta_text_conditioned",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help="Robot profile id. Defaults to checkpoint manifest profile_id.",
    )
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--obsbot-device", type=int, default=4)
    parser.add_argument("--no-real", action="store_true",
                        help="skip the real robot path (sim-only verification)")
    parser.add_argument("--no-obsbot", action="store_true",
                        help="skip the Obsbot path (no external camera evidence)")
    parser.add_argument(
        "--prompts",
        default="stand up,walk forward,turn left,wave",
        help="comma-separated free-form chat prompts to drive the policy",
    )
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--policy-hz", type=float, default=10.0)
    parser.add_argument("--episode-s", type=float, default=5.0)
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "examples" / "robot-mujoco-demo"
        / "evidence" / "text_to_action_e2e",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
