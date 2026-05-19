"""Render high-quality MP4 videos of trained AiNex walking policy.

Rolls out the policy in MJX (GPU, fast), collects qpos trajectories,
then replays them in CPU MuJoCo with the full mesh model (25 STL meshes)
for high-quality rendering.

Usage:
    python3 -m eliza_robot.sim.mujoco.render_video
    python3 -m eliza_robot.sim.mujoco.render_video --checkpoint checkpoints/mujoco_locomotion_v12_dr
    python3 -m eliza_robot.sim.mujoco.render_video --scenario forward --speed 0.5
"""

import argparse
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import imageio
import jax
import jax.numpy as jp
import mujoco
import numpy as np
from PIL import Image, ImageDraw

from eliza_robot.sim.mujoco import ainex_constants as consts
from eliza_robot.sim.mujoco.eval_policy import rollout_mjx, _build_qpos_map
from eliza_robot.sim.mujoco.inference import load_policy_jax
from eliza_robot.sim.mujoco.sim_loop import validate_robot_above_ground


@dataclass
class Scenario:
    """A named velocity command scenario for video rendering."""
    name: str
    command: list[float]  # [vx, vy, vyaw]
    n_steps: int = 500
    description: str = ""


SCENARIOS = {
    "forward_slow": Scenario(
        name="forward_slow",
        command=[0.3, 0.0, 0.0],
        n_steps=500,
        description="Forward walk 0.3 m/s",
    ),
    "forward": Scenario(
        name="forward",
        command=[0.5, 0.0, 0.0],
        n_steps=500,
        description="Forward walk 0.5 m/s",
    ),
    "forward_fast": Scenario(
        name="forward_fast",
        command=[0.8, 0.0, 0.0],
        n_steps=500,
        description="Forward walk 0.8 m/s",
    ),
    "lateral_left": Scenario(
        name="lateral_left",
        command=[0.0, 0.2, 0.0],
        n_steps=400,
        description="Lateral walk left 0.2 m/s",
    ),
    "lateral_right": Scenario(
        name="lateral_right",
        command=[0.0, -0.4, 0.0],
        n_steps=400,
        description="Lateral walk right 0.4 m/s",
    ),
    "turn_left": Scenario(
        name="turn_left",
        command=[0.0, 0.0, 0.5],
        n_steps=500,
        description="Turn left 0.5 rad/s",
    ),
    "turn_right": Scenario(
        name="turn_right",
        command=[0.0, 0.0, -0.3],
        n_steps=500,
        description="Turn right 0.3 rad/s",
    ),
    "combined": Scenario(
        name="combined",
        command=[0.4, 0.1, 0.3],
        n_steps=600,
        description="Forward 0.4 + lateral 0.1 + yaw 0.3",
    ),
}


def render_trajectory_mp4(
    trajectory: dict,
    output_path: str | Path,
    env_config,
    width: int = 640,
    height: int = 480,
    fps: int = 30,
    use_full_mesh: bool = True,
    overlay: bool = True,
) -> None:
    """Render trajectory as MP4 using CPU MuJoCo with full mesh model.

    Args:
        trajectory: Dict from rollout_mjx with qpos, reward, command, torso_xy, etc.
        output_path: Path for output .mp4 file.
        env_config: Environment config (for sim_dt, ctrl_dt).
        width: Frame width.
        height: Frame height.
        fps: Output video FPS.
        use_full_mesh: If True, use ainex.xml (full STL meshes). Else primitives.
        overlay: If True, draw telemetry text overlay on frames.
    """
    xml_path = consts.SCENE_XML if use_full_mesh else consts.SCENE_PRIMITIVES_XML
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    model.opt.timestep = env_config.sim_dt
    data = mujoco.MjData(model)
    renderer = mujoco.Renderer(model, height=height, width=width)

    body_id = model.body("body_link").id

    # Build qpos mapping if trajectory was recorded with a different model
    traj_nq = len(trajectory["qpos"][0]) if trajectory["qpos"] else model.nq
    need_remap = traj_nq != model.nq
    if need_remap:
        src_model = mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))
        src_idx, dst_idx = _build_qpos_map(src_model, model)

    # Compute frame skip to match target fps
    ctrl_dt = env_config.ctrl_dt
    frame_skip = max(1, int(1.0 / (fps * ctrl_dt)))

    frames = []
    for i, qpos in enumerate(trajectory["qpos"]):
        if i % frame_skip != 0:
            continue

        # Set state
        qpos_flat = np.asarray(qpos).flatten()
        if need_remap:
            key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "stand_bent_knees")
            if key_id >= 0:
                mujoco.mj_resetDataKeyframe(model, data, key_id)
            data.qpos[dst_idx] = qpos_flat[src_idx]
        else:
            data.qpos[:] = qpos_flat
        mujoco.mj_forward(model, data)

        # Validate robot stays above ground (warn but don't abort for rendering)
        ok, violations = validate_robot_above_ground(model, data)
        if not ok and i < 5:
            # Only abort on very early ground penetration (bad init)
            renderer.close()
            raise RuntimeError(
                f"Ground penetration at trajectory step {i}:\n"
                + "\n".join(f"  {v}" for v in violations)
            )

        # Camera follows robot
        cam = mujoco.MjvCamera()
        cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        cam.lookat[:] = data.xpos[body_id]
        cam.lookat[2] = 0.25
        cam.distance = 0.9
        cam.azimuth = 135
        cam.elevation = -20

        renderer.update_scene(data, camera=cam)
        frame = renderer.render().copy()

        # Overlay telemetry
        if overlay and i < len(trajectory.get("command", [])):
            frame = _add_overlay(
                frame,
                step=i,
                reward=trajectory["reward"][i] if i < len(trajectory["reward"]) else 0.0,
                command=trajectory["command"][i] if i < len(trajectory["command"]) else [0, 0, 0],
                torso_z=trajectory["torso_z"][i] if i < len(trajectory["torso_z"]) else 0.0,
                torso_xy=trajectory["torso_xy"][i] if i < len(trajectory["torso_xy"]) else [0, 0],
            )

        frames.append(frame)

    renderer.close()

    if frames:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        writer = imageio.get_writer(str(output_path), fps=fps, codec="libx264",
                                    quality=8, pixelformat="yuv420p")
        for frame in frames:
            writer.append_data(frame)
        writer.close()

        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"Saved MP4: {output_path} ({len(frames)} frames, {size_mb:.1f} MB)")


def _add_overlay(
    frame: np.ndarray,
    step: int,
    reward: float,
    command: np.ndarray | list,
    torso_z: float,
    torso_xy: np.ndarray | list,
) -> np.ndarray:
    """Draw telemetry text overlay on a frame."""
    img = Image.fromarray(frame)
    draw = ImageDraw.Draw(img)

    cmd = np.asarray(command)
    xy = np.asarray(torso_xy)

    lines = [
        f"Step: {step}",
        f"Reward: {reward:.3f}",
        f"Cmd: vx={cmd[0]:.2f} vy={cmd[1]:.2f} vyaw={cmd[2]:.2f}",
        f"Pos: ({xy[0]:.2f}, {xy[1]:.2f}) z={torso_z:.3f}",
    ]

    y = 8
    for line in lines:
        # Shadow for readability
        draw.text((9, y + 1), line, fill=(0, 0, 0))
        draw.text((8, y), line, fill=(255, 255, 255))
        y += 16

    return np.array(img)


def render_multi_angle_mp4(
    trajectory: dict,
    output_path: str | Path,
    env_config,
    width: int = 640,
    height: int = 480,
    fps: int = 30,
) -> None:
    """Render trajectory from multiple camera angles in a 2x2 grid."""
    xml_path = consts.SCENE_XML
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    model.opt.timestep = env_config.sim_dt
    data = mujoco.MjData(model)

    half_w, half_h = width // 2, height // 2
    renderer = mujoco.Renderer(model, height=half_h, width=half_w)

    body_id = model.body("body_link").id
    ctrl_dt = env_config.ctrl_dt
    frame_skip = max(1, int(1.0 / (fps * ctrl_dt)))

    # Build qpos mapping if trajectory was recorded with a different model
    traj_nq = len(trajectory["qpos"][0]) if trajectory["qpos"] else model.nq
    need_remap = traj_nq != model.nq
    if need_remap:
        src_model = mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))
        src_idx, dst_idx = _build_qpos_map(src_model, model)

    camera_configs = [
        {"azimuth": 135, "elevation": -20, "distance": 0.9},   # Front-right
        {"azimuth": 225, "elevation": -20, "distance": 0.9},   # Front-left
        {"azimuth": 180, "elevation": -15, "distance": 0.7},   # Front
        {"azimuth": 180, "elevation": -80, "distance": 0.8},   # Top-down
    ]

    frames = []
    for i, qpos in enumerate(trajectory["qpos"]):
        if i % frame_skip != 0:
            continue

        qpos_flat = np.asarray(qpos).flatten()
        if need_remap:
            key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "stand_bent_knees")
            if key_id >= 0:
                mujoco.mj_resetDataKeyframe(model, data, key_id)
            data.qpos[dst_idx] = qpos_flat[src_idx]
        else:
            data.qpos[:] = qpos_flat
        mujoco.mj_forward(model, data)

        views = []
        for cc in camera_configs:
            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            cam.lookat[:] = data.xpos[body_id]
            cam.lookat[2] = 0.25
            cam.distance = cc["distance"]
            cam.azimuth = cc["azimuth"]
            cam.elevation = cc["elevation"]
            renderer.update_scene(data, camera=cam)
            views.append(renderer.render().copy())

        # 2x2 grid
        top = np.concatenate([views[0], views[1]], axis=1)
        bottom = np.concatenate([views[2], views[3]], axis=1)
        combined = np.concatenate([top, bottom], axis=0)
        frames.append(combined)

    renderer.close()

    if frames:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        writer = imageio.get_writer(str(output_path), fps=fps, codec="libx264",
                                    quality=8, pixelformat="yuv420p")
        for frame in frames:
            writer.append_data(frame)
        writer.close()

        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"Saved multi-angle MP4: {output_path} ({len(frames)} frames, {size_mb:.1f} MB)")


def render_scenarios(
    checkpoint_dir: str,
    output_dir: str | Path,
    scenarios: Sequence[str] | None = None,
    n_steps: int | None = None,
    fps: int = 30,
    width: int = 640,
    height: int = 480,
    multi_angle: bool = False,
) -> list[Path]:
    """Render multiple scenario videos from a checkpoint.

    Args:
        checkpoint_dir: Path to Brax checkpoint directory.
        output_dir: Output directory for MP4 files.
        scenarios: List of scenario names from SCENARIOS. None = all.
        n_steps: Override step count per scenario.
        fps: Video FPS.
        width: Frame width.
        height: Frame height.
        multi_angle: Also render 2x2 multi-angle video.

    Returns:
        List of output file paths.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading policy from {checkpoint_dir}...")
    policy_fn, config, env = load_policy_jax(checkpoint_dir)
    env_config = env._config

    if scenarios is None:
        scenario_list = list(SCENARIOS.values())
    else:
        scenario_list = [SCENARIOS[s] for s in scenarios if s in SCENARIOS]

    outputs = []
    for scenario in scenario_list:
        steps = n_steps or scenario.n_steps
        print(f"\n{'='*60}")
        print(f"Scenario: {scenario.name} — {scenario.description}")
        print(f"Command: vx={scenario.command[0]}, vy={scenario.command[1]}, "
              f"vyaw={scenario.command[2]}")
        print(f"Steps: {steps}")
        print(f"{'='*60}")

        traj = rollout_mjx(env, policy_fn, n_steps=steps, cmd=scenario.command)

        # Summary
        total_r = sum(traj["reward"])
        final_xy = traj["torso_xy"][-1]
        dist = np.linalg.norm(final_xy)
        falls = sum(1 for d in traj["done"] if d > 0.5)
        print(f"  Reward: {total_r:.2f}, Distance: {dist:.3f}m, Falls: {falls}/{steps}")

        # Render MP4
        mp4_path = output_dir / f"ainex_{scenario.name}.mp4"
        render_trajectory_mp4(traj, mp4_path, env_config,
                              width=width, height=height, fps=fps)
        outputs.append(mp4_path)

        if multi_angle:
            multi_path = output_dir / f"ainex_{scenario.name}_multi.mp4"
            render_multi_angle_mp4(traj, multi_path, env_config,
                                   width=width, height=height, fps=fps)
            outputs.append(multi_path)

    return outputs


def main():
    parser = argparse.ArgumentParser(description="Render AiNex walking policy videos")
    parser.add_argument("--checkpoint", type=str,
                        default="checkpoints/mujoco_locomotion_v12_dr",
                        help="Path to Brax checkpoint directory")
    parser.add_argument("--output-dir", type=str, default="training/videos",
                        help="Output directory")
    parser.add_argument("--scenario", type=str, nargs="*", default=None,
                        help=f"Scenarios to render (default: all). "
                             f"Options: {list(SCENARIOS.keys())}")
    parser.add_argument("--n-steps", type=int, default=None,
                        help="Override step count per scenario")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--multi-angle", action="store_true",
                        help="Also render 2x2 multi-angle video")
    parser.add_argument("--primitives", action="store_true",
                        help="Use primitives model instead of full mesh")
    args = parser.parse_args()

    outputs = render_scenarios(
        checkpoint_dir=args.checkpoint,
        output_dir=args.output_dir,
        scenarios=args.scenario,
        n_steps=args.n_steps,
        fps=args.fps,
        width=args.width,
        height=args.height,
        multi_angle=args.multi_angle,
    )

    print(f"\n{'='*60}")
    print(f"Rendered {len(outputs)} videos to {args.output_dir}/")
    for p in outputs:
        print(f"  {p}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
