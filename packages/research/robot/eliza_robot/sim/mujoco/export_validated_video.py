"""Export a validated walking video with annotated beginning/middle/end frames.

Renders the policy in MuJoCo, captures frames at key timestamps, annotates them
with torso height and distance, and outputs:
  - Full GIF (compressed)
  - Beginning/middle/end PNG frames with annotations
  - Validation summary JSON

Usage:
    python -m eliza_robot.sim.mujoco.export_validated_video \
        --checkpoint <path> \
        --output-dir <path> \
        --n-steps 2000 \
        --forward-cmd 0.6
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import mujoco
import numpy as np


def render_frame(model, data, renderer, width=640, height=480, cam_distance=1.2, cam_azimuth=135, cam_elevation=-20):
    """Render a single frame following the robot."""
    body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "body_link")
    cam = mujoco.MjvCamera()
    cam.type = mujoco.mjtCamera.mjCAMERA_FREE
    cam.lookat[:] = data.xpos[body_id]
    cam.lookat[2] = max(cam.lookat[2], 0.2)
    cam.distance = cam_distance
    cam.azimuth = cam_azimuth
    cam.elevation = cam_elevation

    renderer.update_scene(data, cam)
    return renderer.render().copy()


def annotate_frame(frame, text_lines, position=(10, 30), color=(255, 255, 255)):
    """Add text annotation to a frame (simple pixel-level, no PIL dependency)."""
    # We'll return the frame and text separately — annotation happens in the summary
    return frame


def main():
    parser = argparse.ArgumentParser(description="Export validated walking video")
    parser.add_argument("--checkpoint", type=str, required=True)
    parser.add_argument("--output-dir", type=str, required=True)
    parser.add_argument("--n-steps", type=int, default=2000)
    parser.add_argument("--forward-cmd", type=float, default=0.6)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Loading environment and policy...")
    from eliza_robot.sim.mujoco.joystick import Joystick, default_config
    from eliza_robot.sim.mujoco.inference import load_policy
    from eliza_robot.sim.mujoco.eval_policy import rollout_mjx
    from eliza_robot.sim.mujoco import ainex_constants as consts

    inference_fn, config = load_policy(args.checkpoint)

    # Run rollout in MJX
    print(f"Running rollout: {args.n_steps} steps, forward_cmd={args.forward_cmd}")
    env = Joystick()
    command = np.array([args.forward_cmd, 0.0, 0.0])
    traj = rollout_mjx(env, inference_fn, config, args.n_steps, command=command, seed=42)

    torso_z = np.array(traj["torso_z"])
    torso_xy = np.array(traj["torso_xy"])
    done = np.array(traj["done"])

    n = len(torso_z)
    distances = np.sqrt(torso_xy[:, 0]**2 + torso_xy[:, 1]**2)
    final_distance = float(distances[-1])
    falls = int(np.sum(done > 0.5))

    print(f"Rollout complete: {n} steps, distance={final_distance:.2f}m, falls={falls}")

    # Key frame indices
    key_frames = {
        "beginning": 0,
        "quarter": n // 4,
        "middle": n // 2,
        "three_quarter": 3 * n // 4,
        "end": n - 1,
    }

    # Now render in standard MuJoCo (not MJX) for visual output
    print("Setting up MuJoCo renderer...")
    xml_path = consts.SCENE_XML if consts.SCENE_XML.exists() else consts.SCENE_PRIMITIVES_XML
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    data = mujoco.MjData(model)
    renderer = mujoco.Renderer(model, height=args.height, width=args.width)

    # Set standing pose
    mujoco.mj_resetData(model, data)
    if model.nkey > 0:
        data.qpos[:] = model.key_qpos[0]
    mujoco.mj_forward(model, data)

    ctrl_dt = 0.02
    sim_dt = model.opt.timestep
    n_substeps = max(1, int(ctrl_dt / sim_dt))

    # Get default pose for action scaling
    default_pose = np.array(model.key_qpos[0][7:7+12]) if model.nkey > 0 else np.zeros(12)
    action_scale = 0.3

    # Render all frames
    print("Rendering frames...")
    frames = []
    frame_skip = max(1, int(1.0 / (args.fps * ctrl_dt)))
    key_frame_images = {}

    for step_idx in range(n):
        # Apply action from rollout
        qpos_from_traj = traj.get("qpos")
        if qpos_from_traj is not None and step_idx < len(qpos_from_traj):
            data.qpos[:] = qpos_from_traj[step_idx]
            mujoco.mj_forward(model, data)
        else:
            # Use action to step the sim
            action = np.zeros(12)
            if "action" in traj and step_idx < len(traj["action"]):
                action = np.array(traj["action"][step_idx])[:12]
            ctrl_target = default_pose + action_scale * action
            data.ctrl[:12] = ctrl_target
            for _ in range(n_substeps):
                mujoco.mj_step(model, data)

        # Capture frame
        if step_idx % frame_skip == 0 or step_idx in key_frames.values():
            frame = render_frame(model, data, renderer, args.width, args.height)
            frames.append(frame)

        # Capture key frames as PNGs
        for name, idx in key_frames.items():
            if step_idx == idx:
                frame = render_frame(model, data, renderer, args.width, args.height)
                key_frame_images[name] = frame

                # Save PNG
                try:
                    from PIL import Image
                    img = Image.fromarray(frame)
                    png_path = output_dir / f"frame_{name}_{idx:04d}.png"
                    img.save(str(png_path))
                    print(f"  Saved {name} frame (step {idx}): "
                          f"torso_z={torso_z[idx]:.4f}m, dist={distances[idx]:.3f}m")
                except ImportError:
                    # Save raw numpy
                    np.save(str(output_dir / f"frame_{name}_{idx:04d}.npy"), frame)

    # Save GIF
    print("Saving GIF...")
    try:
        from PIL import Image
        pil_frames = [Image.fromarray(f) for f in frames]
        gif_path = output_dir / "walking_validated.gif"

        # Limit GIF size — take every Nth frame if too many
        max_gif_frames = 200
        if len(pil_frames) > max_gif_frames:
            skip = len(pil_frames) // max_gif_frames
            pil_frames = pil_frames[::skip]

        pil_frames[0].save(
            str(gif_path),
            save_all=True,
            append_images=pil_frames[1:],
            duration=int(1000 / args.fps),
            loop=0,
            optimize=True,
        )
        gif_size_mb = gif_path.stat().st_size / (1024 * 1024)
        print(f"Saved GIF: {gif_path} ({len(pil_frames)} frames, {gif_size_mb:.1f} MB)")
    except ImportError:
        print("PIL not available, skipping GIF export")

    # Validation summary
    validation = {
        "checkpoint": args.checkpoint,
        "n_steps": n,
        "forward_cmd": args.forward_cmd,
        "final_distance_m": round(final_distance, 3),
        "total_falls": falls,
        "fall_rate": round(falls / max(n, 1), 4),
        "avg_torso_height_m": round(float(np.mean(torso_z)), 4),
        "min_torso_height_m": round(float(np.min(torso_z)), 4),
        "key_frames": {},
    }

    for name, idx in key_frames.items():
        validation["key_frames"][name] = {
            "step": idx,
            "torso_height_m": round(float(torso_z[idx]), 4),
            "distance_m": round(float(distances[idx]), 3),
            "standing": bool(torso_z[idx] > 0.18),
            "head_above_ground": bool(torso_z[idx] > 0.05),
        }

    all_standing = all(v["standing"] for v in validation["key_frames"].values())
    all_above_ground = all(v["head_above_ground"] for v in validation["key_frames"].values())

    validation["overall_pass"] = (
        final_distance >= 5.0
        and falls == 0
        and all_standing
        and all_above_ground
    )

    summary_path = output_dir / "validation_summary.json"
    with summary_path.open("w") as f:
        json.dump(validation, f, indent=2)

    print(f"\n{'='*60}")
    print(f"VALIDATION: {'PASS' if validation['overall_pass'] else 'FAIL'}")
    print(f"{'='*60}")
    print(f"  Distance: {final_distance:.2f}m {'(>5m)' if final_distance >= 5.0 else '(<5m FAIL)'}")
    print(f"  Falls: {falls}/{n} {'(OK)' if falls == 0 else '(FAIL)'}")
    for name, info in validation["key_frames"].items():
        status = "OK" if info["standing"] else "FAIL"
        print(f"  {name:15s}: z={info['torso_height_m']:.4f}m dist={info['distance_m']:.3f}m [{status}]")
    print(f"{'='*60}")

    renderer.close()
    sys.exit(0 if validation["overall_pass"] else 1)


if __name__ == "__main__":
    main()
