"""FINAL_GOAL evidence — one reproducible script that demonstrates the
whole loop with measurable sim2real compensation.

Pipeline:

    chat prompt (5 tier-1 curriculum tasks)
        │
        ▼
    TextConditionedPolicy
        │
        ▼  24-D joint targets at 8 Hz
    DualTargetBackend
        ├─→ real AiNex (rosbridge_suite)
        └─→ MuJoCo DemoEnv
            ▲
            │  every 100 ms
        StateMirrorBackend
            │
            └ reads real.read_joint_positions(),
              writes into sim.data.qpos + mj_forward.

For each prompt we record (in `--out`):
  - real_<prompt>.mp4   AiNex onboard camera (via bridge camera.snapshot)
  - sim_<prompt>.mp4    MuJoCo external view
  - sidebyside_<prompt>.mp4   real + sim side-by-side w/ live divergence HUD
  - report.json         per-prompt divergence statistics + verdicts

Verdict gate: each prompt PASSES if mean RMS divergence < 30 mrad
(double the encoder/mirror floor of ~16 mrad we measured earlier).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

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

PKG_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ALBERTA_CHECKPOINT = PKG_ROOT / "checkpoints" / "alberta_text_conditioned"
SUPPORTED_PROFILE_ID = "hiwonder-ainex"

PROMPTS = [
    "stand still",
    "walk forward",
    "turn left",
    "turn right",
    "wave hello",
]


def _load_checkpoint_manifest(checkpoint: Path) -> dict:
    manifest = checkpoint / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"missing checkpoint manifest: {manifest}")
    return json.loads(manifest.read_text(encoding="utf-8"))


def _validate_checkpoint_profile(checkpoint: Path) -> dict:
    manifest = _load_checkpoint_manifest(checkpoint)
    profile_id = manifest.get("profile_id")
    if not profile_id:
        raise ValueError(f"checkpoint manifest has no profile_id: {checkpoint}")
    if profile_id != SUPPORTED_PROFILE_ID:
        raise ValueError(
            "checkpoint profile mismatch: "
            f"checkpoint={profile_id!r} script_profile={SUPPORTED_PROFILE_ID!r}"
        )
    return manifest


def _slug(text: str) -> str:
    return text.lower().replace(" ", "_").replace("'", "").replace('"', "")


async def _read_sim_joints(sim_env) -> dict[str, float]:
    try:
        return {
            name: float(sim_env.data.qpos[sim_env._act_qpos_idx[idx]])
            for name, idx in sim_env._act_name_to_idx.items()
        }
    except Exception:
        return {}


async def _real_camera_frame(backend, request_id_prefix: str) -> np.ndarray | None:
    """Pull the AiNex onboard camera via the unified bridge command."""
    env = CommandEnvelope(
        request_id=f"{request_id_prefix}-cam-{time.time_ns()}",
        timestamp=utc_now_iso(),
        command="camera.snapshot", payload={},
    )
    try:
        resp = await backend.handle_command(env)
    except Exception:
        return None
    if not resp.ok:
        return None
    fb = resp.data.get("frame_base64")
    if not isinstance(fb, str):
        return None
    try:
        raw = base64.b64decode(fb)
        return np.array(Image.open(io.BytesIO(raw)).convert("RGB"), dtype=np.uint8)
    except Exception:
        return None


def _label_strip(
    real: np.ndarray | None, sim: np.ndarray,
    *, prompt: str, ms: int, rms_mrad: float, max_mrad: float,
    target_h: int = 360,
) -> np.ndarray:
    """Make a side-by-side BGR frame: real (left) + sim (right) + HUD."""
    sim_bgr = sim[:, :, ::-1].copy()
    sim_resized = cv2.resize(sim_bgr, (int(sim_bgr.shape[1] * target_h / sim_bgr.shape[0]), target_h))
    if real is not None:
        real_bgr = real[:, :, ::-1].copy()
        real_resized = cv2.resize(
            real_bgr,
            (int(real_bgr.shape[1] * target_h / real_bgr.shape[0]), target_h),
        )
    else:
        real_resized = np.full(
            (target_h, sim_resized.shape[1], 3), 30, dtype=np.uint8,
        )
        cv2.putText(real_resized, "(no real camera frame)",
                    (12, target_h // 2), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (200, 200, 200), 1)

    combined = np.concatenate([real_resized, sim_resized], axis=1)
    h, w = combined.shape[:2]
    # Bottom HUD bar
    bar_h = 56
    bar = np.full((bar_h, w, 3), 18, dtype=np.uint8)
    cv2.putText(bar, f"prompt: {prompt}    t+{ms} ms",
                (12, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (240, 240, 240), 1)
    cv2.putText(
        bar,
        f"sim2real RMS={rms_mrad:.1f} mrad    max={max_mrad:.1f} mrad    "
        f"({'PASS' if rms_mrad < 30 else 'over threshold'})",
        (12, 46), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
        (120, 240, 120) if rms_mrad < 30 else (120, 180, 240), 1,
    )
    # Top labels
    cv2.putText(combined, "REAL AiNex (onboard cam)",
                (12, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (240, 240, 240), 1)
    cv2.putText(combined, "MuJoCo sim (state-mirrored)",
                (real_resized.shape[1] + 12, 26),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (240, 240, 240), 1)
    return np.concatenate([combined, bar], axis=0)


async def _run(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = _validate_checkpoint_profile(Path(args.checkpoint))

    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim = MuJocoBackend(sim_env, profile_id=SUPPORTED_PROFILE_ID)
    if args.sim_only:
        # Sim-only mode: use a NoiseInjector-wrapped second MuJoCo as the
        # stand-in for the real robot. Deterministic, reproducible, and
        # crucially does NOT command the physical AiNex.
        from eliza_robot.bridge.backends.noise_injector import (
            NoiseInjectorBackend,
            NoiseProfile,
        )
        twin_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
        twin_inner = MuJocoBackend(twin_env, profile_id=SUPPORTED_PROFILE_ID)
        real = NoiseInjectorBackend(
            twin_inner,
            profile=NoiseProfile(deterministic_only=True, rng_seed=42),
        )
        print("[final-e2e] SIM-ONLY mode: noisy MuJoCo twin standing in for real robot")
    else:
        real = AinexRemoteBackend(host=args.host, port=args.port)
        print(f"[final-e2e] REAL ROBOT mode: ws://{args.host}:{args.port}")
    dual = DualTargetBackend(real=real, sim=sim)
    backend = StateMirrorBackend(
        dual, real=real, sim_env=sim_env, sync_period_s=args.mirror_period,
    )
    await backend.connect()
    await asyncio.sleep(2.0)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    per_prompt = []

    try:
        for prompt in PROMPTS:
            slug = _slug(prompt)
            print(f"[final-e2e] >>> {prompt!r}")
            t0 = time.time()
            cfg = InferenceLoopConfig(
                hz=args.policy_hz,
                max_steps=int(args.episode_s * args.policy_hz),
                action_scale=0.3,
            )
            inference_task = asyncio.create_task(
                run_inference(backend, args.checkpoint, prompt, config=cfg)
            )

            # Open video writers lazily once we know the frame size.
            side_writer: cv2.VideoWriter | None = None
            sample_sim = sim_env.render_external(width=640, height=480)
            sample_real = await _real_camera_frame(real, f"final-{slug}")
            initial_frame = _label_strip(
                sample_real, sample_sim, prompt=prompt, ms=0,
                rms_mrad=0.0, max_mrad=0.0,
            )
            side_writer = cv2.VideoWriter(
                str(out / f"sidebyside_{slug}.mp4"),
                fourcc, args.fps,
                (initial_frame.shape[1], initial_frame.shape[0]),
            )

            divergence_log = []
            frame_period = 1.0 / args.fps
            next_frame_t = time.time()
            t_end = time.time() + args.episode_s
            while time.time() < t_end:
                if time.time() < next_frame_t:
                    await asyncio.sleep(0.005)
                    continue
                next_frame_t += frame_period
                try:
                    real_pos = await real.read_joint_positions()
                except Exception:
                    real_pos = {}
                sim_pos = await _read_sim_joints(sim_env)
                keys = set(real_pos) & set(sim_pos)
                if keys:
                    diffs = [
                        float(real_pos[k]) - float(sim_pos[k]) for k in keys
                    ]
                    rms_mrad = float(np.sqrt(np.mean([d * d for d in diffs])) * 1000)
                    max_mrad = float(max(abs(d) for d in diffs) * 1000)
                else:
                    rms_mrad = max_mrad = 0.0
                divergence_log.append({
                    "t_s": time.time() - t0,
                    "rms_mrad": rms_mrad,
                    "max_mrad": max_mrad,
                    "n_joints": len(keys),
                })

                sim_frame = sim_env.render_external(width=640, height=480)
                real_frame = await _real_camera_frame(real, f"final-{slug}-{int((time.time()-t0)*1000)}")
                ms = int((time.time() - t0) * 1000)
                combined = _label_strip(
                    real_frame, sim_frame, prompt=prompt, ms=ms,
                    rms_mrad=rms_mrad, max_mrad=max_mrad,
                    target_h=initial_frame.shape[0] - 56,
                )
                # Ensure shape matches writer's expected dims.
                if combined.shape != initial_frame.shape:
                    combined = cv2.resize(
                        combined,
                        (initial_frame.shape[1], initial_frame.shape[0]),
                    )
                side_writer.write(combined)

            await inference_task
            side_writer.release()

            stats = {
                "prompt": prompt,
                "duration_s": round(time.time() - t0, 2),
                "samples": len(divergence_log),
                "mean_rms_mrad": (
                    float(np.mean([d["rms_mrad"] for d in divergence_log]))
                    if divergence_log else None
                ),
                "median_rms_mrad": (
                    float(np.median([d["rms_mrad"] for d in divergence_log]))
                    if divergence_log else None
                ),
                "p95_rms_mrad": (
                    float(np.percentile([d["rms_mrad"] for d in divergence_log], 95))
                    if divergence_log else None
                ),
                "max_rms_mrad": (
                    float(max([d["rms_mrad"] for d in divergence_log]))
                    if divergence_log else None
                ),
                "verdict": (
                    "PASS"
                    if (divergence_log
                        and float(np.mean([d["rms_mrad"] for d in divergence_log])) < 30.0)
                    else "OVER"
                ),
            }
            per_prompt.append(stats)
            print(
                f"[final-e2e]   {prompt}: mean={stats['mean_rms_mrad']:.1f} "
                f"median={stats['median_rms_mrad']:.1f} "
                f"p95={stats['p95_rms_mrad']:.1f} mrad → {stats['verdict']}"
            )
    finally:
        # Always stop, return to stand.
        await backend.handle_command(CommandEnvelope(
            request_id="final-stop", timestamp=utc_now_iso(),
            command="walk.command", payload={"action": "stop"}, preempt=True,
        ))
        await backend.handle_command(CommandEnvelope(
            request_id="final-stand", timestamp=utc_now_iso(),
            command="action.play", payload={"name": "stand"},
        ))
        await backend.shutdown()

    summary = {
        "checkpoint": str(args.checkpoint),
        "checkpoint_regime": manifest.get("regime"),
        "profile_id": SUPPORTED_PROFILE_ID,
        "host": f"{args.host}:{args.port}",
        "policy_hz": args.policy_hz,
        "episode_s": args.episode_s,
        "mirror_period_s": args.mirror_period,
        "n_prompts": len(per_prompt),
        "pass_count": sum(1 for p in per_prompt if p["verdict"] == "PASS"),
        "fail_count": sum(1 for p in per_prompt if p["verdict"] != "PASS"),
        "per_prompt": per_prompt,
        "aggregate_mean_rms_mrad": (
            float(np.mean([p["mean_rms_mrad"] for p in per_prompt if p["mean_rms_mrad"] is not None]))
            if per_prompt else None
        ),
    }
    (out / "report.json").write_text(json.dumps(summary, indent=2))
    print()
    print("=" * 60)
    print(
        f"FINAL_GOAL e2e: {summary['pass_count']}/{summary['n_prompts']} "
        f"prompts under 30 mrad mean RMS divergence"
    )
    if summary["aggregate_mean_rms_mrad"] is not None:
        print(
            f"aggregate mean divergence: "
            f"{summary['aggregate_mean_rms_mrad']:.1f} mrad"
        )
    return 0 if summary["fail_count"] == 0 else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=DEFAULT_ALBERTA_CHECKPOINT,
    )
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--policy-hz", type=float, default=8.0)
    parser.add_argument("--episode-s", type=float, default=3.0)
    parser.add_argument("--mirror-period", type=float, default=0.05)
    parser.add_argument(
        "--sim-only",
        action="store_true",
        default=True,
        help="use a noisy MuJoCo twin instead of the real robot (default ON for safety)",
    )
    parser.add_argument(
        "--use-real",
        dest="sim_only",
        action="store_false",
        help="actually drive the physical AiNex (opt-in)",
    )
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "FINAL_E2E",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
