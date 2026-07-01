"""Evaluate trained policy and render walking visualization.

Loads trained PPO params via eliza_robot.sim.mujoco.inference, runs the policy
in the MuJoCo environment, and renders GIFs showing locomotion behavior.

Usage:
    python3 -m eliza_robot.sim.mujoco.eval_policy
    python3 -m eliza_robot.sim.mujoco.eval_policy --checkpoint checkpoints/mujoco_locomotion
"""

import argparse
import json
import os
from pathlib import Path

import jax
import jax.numpy as jp
import mujoco
import numpy as np
from eliza_robot.sim.mujoco.inference import load_policy_jax
from eliza_robot.schema.canonical import adapt_state_vector
from eliza_robot.schema.canonical import AINEX_SCHEMA_VERSION


def rollout_mjx(env, policy_fn, n_steps=500, cmd=None, obs_size=None, action_size=None):
    """Roll out policy in MJX for n_steps. Returns trajectory data.

    Args:
        env: Joystick or TargetReaching environment.
        policy_fn: Callable (obs_jax, rng) -> (action_jax, extras).
        n_steps: Number of steps.
        cmd: Optional fixed velocity command [vx, vy, vyaw].
    """

    rng = jax.random.PRNGKey(42)
    state = jax.jit(env.reset)(rng)

    # Override command if specified
    if cmd is not None:
        state.info["command"] = jp.array(cmd)

    step_fn = jax.jit(env.step)

    trajectory = {
        "qpos": [],
        "qvel": [],
        "reward": [],
        "done": [],
        "torso_z": [],
        "torso_xy": [],
        "command": [],
    }

    def _command_for_state(current_state) -> np.ndarray:
        if "command" in current_state.info:
            return np.array(current_state.info["command"])
        if "target_pos" in current_state.info:
            return np.array(current_state.info["target_pos"])
        return np.zeros(3, dtype=np.float32)

    for i in range(n_steps):
        act_rng, rng = jax.random.split(rng)
        obs = state.obs
        if obs_size is not None and obs.shape[0] != obs_size:
            obs = jp.array(adapt_state_vector(np.array(obs).tolist(), obs_size))
        action, _ = policy_fn(obs, act_rng)
        if action_size is not None and action.shape[0] != action_size:
            action = jp.array(
                adapt_state_vector(np.array(action).tolist(), action_size)
            )
        state = step_fn(state, action)

        trajectory["qpos"].append(np.array(state.data.qpos))
        trajectory["qvel"].append(np.array(state.data.qvel))
        trajectory["reward"].append(float(state.reward))
        trajectory["done"].append(float(state.done))
        trajectory["torso_z"].append(float(state.data.xpos[env._torso_body_id, 2]))
        trajectory["torso_xy"].append(np.array(state.data.xpos[env._torso_body_id, :2]))
        trajectory["command"].append(_command_for_state(state))

        if i % 100 == 0:
            total_r = sum(trajectory["reward"])
            xy = trajectory["torso_xy"][-1]
            print(f"Step {i:4d}: reward={float(state.reward):.4f}  "
                  f"total={total_r:.2f}  "
                  f"torso_z={trajectory['torso_z'][-1]:.4f}  "
                  f"xy=({xy[0]:.3f}, {xy[1]:.3f})  "
                  f"done={float(state.done):.0f}  "
                  f"cmd={_command_for_state(state)}")

    return trajectory


def _build_qpos_map(src_model, dst_model):
    """Build a mapping from source model qpos indices to destination model qpos indices.

    Maps joints by name.  For the freejoint (root), maps the 7-DOF block.
    Returns (src_indices, dst_indices) arrays for assignment:
        dst_data.qpos[dst_indices] = src_qpos[src_indices]
    """
    src_idx, dst_idx = [], []
    for i in range(src_model.njnt):
        name = mujoco.mj_id2name(src_model, mujoco.mjtObj.mjOBJ_JOINT, i)
        dst_jnt = mujoco.mj_name2id(dst_model, mujoco.mjtObj.mjOBJ_JOINT, name)
        if dst_jnt < 0:
            continue
        src_type = src_model.jnt_type[i]
        ndim = {0: 7, 1: 1, 2: 1, 3: 1}[int(src_type)]  # free, ball, slide, hinge
        s_adr = int(src_model.jnt_qposadr[i])
        d_adr = int(dst_model.jnt_qposadr[dst_jnt])
        src_idx.extend(range(s_adr, s_adr + ndim))
        dst_idx.extend(range(d_adr, d_adr + ndim))
    return np.array(src_idx), np.array(dst_idx)


def render_trajectory_gif(trajectory, output_path, env_config,
                          width=640, height=480, fps=30):
    """Render trajectory as GIF using CPU MuJoCo with full mesh model."""
    from PIL import Image
    from eliza_robot.sim.mujoco import ainex_constants as consts

    # Load full mesh model for high-quality rendering (falls back to primitives)
    xml_path = consts.SCENE_XML if consts.SCENE_XML.exists() else consts.SCENE_PRIMITIVES_XML
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    model.opt.timestep = env_config.sim_dt
    data = mujoco.MjData(model)
    renderer = mujoco.Renderer(model, height=height, width=width)

    body_id = model.body("body_link").id

    # Build qpos mapping if trajectory was recorded with a different model
    # (e.g., primitives nq=31 → full mesh nq=34).
    traj_nq = len(trajectory["qpos"][0]) if trajectory["qpos"] else model.nq
    need_remap = traj_nq != model.nq
    if need_remap:
        src_model = mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))
        src_idx, dst_idx = _build_qpos_map(src_model, model)

    frames = []

    # Render every Nth qpos to match fps
    ctrl_dt = env_config.ctrl_dt
    frame_skip = max(1, int(1.0 / (fps * ctrl_dt)))

    for i, qpos in enumerate(trajectory["qpos"]):
        if i % frame_skip != 0:
            continue

        qpos_flat = np.asarray(qpos).flatten()
        if need_remap:
            # Reset to keyframe first for correct defaults
            key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "stand_bent_knees")
            if key_id >= 0:
                mujoco.mj_resetDataKeyframe(model, data, key_id)
            data.qpos[dst_idx] = qpos_flat[src_idx]
        else:
            data.qpos[:] = qpos_flat
        mujoco.mj_forward(model, data)

        # Camera follows robot
        cam = mujoco.MjvCamera()
        cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        cam.lookat[:] = data.xpos[body_id]
        cam.lookat[2] = 0.2  # Keep camera at torso height
        cam.distance = 0.8
        cam.azimuth = 135
        cam.elevation = -20

        renderer.update_scene(data, camera=cam)
        img = renderer.render()
        frames.append(Image.fromarray(img.copy()))

    renderer.close()

    if frames:
        duration = int(1000 / fps)
        frames[0].save(
            str(output_path),
            save_all=True,
            append_images=frames[1:],
            duration=duration,
            loop=0,
            optimize=True,
        )
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"Saved GIF: {output_path} ({len(frames)} frames, {size_mb:.1f} MB)")


def render_trajectory_topdown(trajectory, output_path, width=400, height=400):
    """Render top-down view of trajectory path."""
    from PIL import Image, ImageDraw

    xys = np.array(trajectory["torso_xy"])
    rewards = np.array(trajectory["reward"])

    # Scale to image
    margin = 0.1
    x_min, x_max = xys[:, 0].min() - margin, xys[:, 0].max() + margin
    y_min, y_max = xys[:, 1].min() - margin, xys[:, 1].max() + margin

    # Keep aspect ratio
    x_range = max(x_max - x_min, 0.5)
    y_range = max(y_max - y_min, 0.5)
    scale = min(width / x_range, height / y_range) * 0.8

    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)

    # Draw path
    cx, cy = width // 2, height // 2
    x_center = (x_min + x_max) / 2
    y_center = (y_min + y_max) / 2

    points = []
    for xy in xys:
        px = int(cx + (xy[0] - x_center) * scale)
        py = int(cy - (xy[1] - y_center) * scale)  # flip y
        points.append((px, py))

    # Draw trajectory line
    for i in range(1, len(points)):
        # Color by time: blue -> red
        t = i / len(points)
        r = int(255 * t)
        b = int(255 * (1 - t))
        draw.line([points[i-1], points[i]], fill=(r, 0, b), width=2)

    # Mark start and end
    draw.ellipse([points[0][0]-5, points[0][1]-5, points[0][0]+5, points[0][1]+5],
                 fill="green")
    draw.ellipse([points[-1][0]-5, points[-1][1]-5, points[-1][0]+5, points[-1][1]+5],
                 fill="red")

    # Add text
    total_dist = np.sum(np.linalg.norm(np.diff(xys, axis=0), axis=1))
    total_reward = sum(rewards)
    draw.text((10, 10), f"Distance: {total_dist:.2f}m", fill="black")
    draw.text((10, 25), f"Total reward: {total_reward:.1f}", fill="black")
    draw.text((10, 40), f"Steps: {len(xys)}", fill="black")

    img.save(str(output_path))
    print(f"Saved trajectory plot: {output_path}")


def export_rollout_trace(trajectory, output_path, command_name: str) -> None:
    """Export a lightweight JSON trace for downstream analysis."""
    reward_total = float(sum(trajectory["reward"]))
    payload = {
        "schema_version": AINEX_SCHEMA_VERSION,
        "command_name": command_name,
        "num_steps": len(trajectory["reward"]),
        "reward_total": reward_total,
        "trajectory": {
            "reward": trajectory["reward"],
            "done": trajectory["done"],
            "torso_z": trajectory["torso_z"],
            "torso_xy": [xy.tolist() for xy in trajectory["torso_xy"]],
            "command": [cmd.tolist() for cmd in trajectory["command"]],
        },
    }
    output_path.write_text(json.dumps(payload, indent=2))
    print(f"Saved rollout trace: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Evaluate trained AiNex policy")
    parser.add_argument("--checkpoint", type=str,
                        default="checkpoints/mujoco_locomotion",
                        help="Path to checkpoint directory (or direct params file)")
    parser.add_argument("--n-steps", type=int, default=500,
                        help="Number of evaluation steps")
    parser.add_argument("--output-dir", type=str, default="training/videos",
                        help="Output directory for renders")
    parser.add_argument("--forward-cmd", type=float, default=0.5,
                        help="Forward velocity command (m/s)")
    parser.add_argument("--export-trace", action="store_true",
                        help="Export lightweight JSON traces alongside renders")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("AiNex Policy Evaluation")
    print("=" * 60)

    # Load policy and environment via inference module
    ckpt_dir = args.checkpoint
    if Path(ckpt_dir).is_file():
        ckpt_dir = str(Path(ckpt_dir).parent)
    print(f"Loading checkpoint: {ckpt_dir}")
    policy_fn, config, env = load_policy_jax(ckpt_dir)
    env_config = env._config
    print(f"Environment: {config.get('env', 'AiNexJoystick')}, {env.action_size} actuators")
    print()

    # Rollout 1: Forward walking
    print("=== Rollout: Forward walking ===")
    cmd_forward = [args.forward_cmd, 0.0, 0.0]  # forward, no lateral, no yaw
    print(f"Command: vx={cmd_forward[0]}, vy={cmd_forward[1]}, vyaw={cmd_forward[2]}")
    traj_fwd = rollout_mjx(
        env,
        policy_fn,
        n_steps=args.n_steps,
        cmd=cmd_forward,
        obs_size=config["obs_size"],
        action_size=env.action_size,
    )

    total_r = sum(traj_fwd["reward"])
    final_xy = traj_fwd["torso_xy"][-1]
    dist = np.linalg.norm(final_xy)
    avg_z = np.mean(traj_fwd["torso_z"])
    falls = sum(1 for d in traj_fwd["done"] if d > 0.5)
    print(f"\nSummary:")
    print(f"  Total reward: {total_r:.2f}")
    print(f"  Distance traveled: {dist:.3f}m")
    print(f"  Final position: ({final_xy[0]:.3f}, {final_xy[1]:.3f})")
    print(f"  Average torso height: {avg_z:.4f}m")
    print(f"  Falls: {falls}/{args.n_steps}")
    print()

    # Render GIF
    print("Rendering forward walking GIF...")
    render_trajectory_gif(traj_fwd, output_dir / "ainex_walking_forward.gif", env_config)

    # Render trajectory plot
    render_trajectory_topdown(traj_fwd, output_dir / "ainex_trajectory_forward.png")
    if args.export_trace:
        export_rollout_trace(traj_fwd, output_dir / "ainex_trace_forward.json", "forward")
    print()

    # Rollout 2: Random commands (as in training)
    print("=== Rollout: Random commands ===")
    traj_rand = rollout_mjx(
        env,
        policy_fn,
        n_steps=args.n_steps,
        cmd=None,
        obs_size=config["obs_size"],
        action_size=env.action_size,
    )
    total_r2 = sum(traj_rand["reward"])
    dist2 = np.linalg.norm(traj_rand["torso_xy"][-1])
    falls2 = sum(1 for d in traj_rand["done"] if d > 0.5)
    print(f"\nSummary:")
    print(f"  Total reward: {total_r2:.2f}")
    print(f"  Distance: {dist2:.3f}m")
    print(f"  Falls: {falls2}/{args.n_steps}")
    print()

    print("Rendering random commands GIF...")
    render_trajectory_gif(traj_rand, output_dir / "ainex_walking_random.gif", env_config)
    render_trajectory_topdown(traj_rand, output_dir / "ainex_trajectory_random.png")
    if args.export_trace:
        export_rollout_trace(traj_rand, output_dir / "ainex_trace_random.json", "random")

    # Rollout 3: Turning
    print("\n=== Rollout: Turning in place ===")
    cmd_turn = [0.0, 0.0, 0.5]  # yaw only
    print(f"Command: vx={cmd_turn[0]}, vy={cmd_turn[1]}, vyaw={cmd_turn[2]}")
    traj_turn = rollout_mjx(
        env,
        policy_fn,
        n_steps=args.n_steps,
        cmd=cmd_turn,
        obs_size=config["obs_size"],
        action_size=env.action_size,
    )
    total_r3 = sum(traj_turn["reward"])
    falls3 = sum(1 for d in traj_turn["done"] if d > 0.5)
    print(f"\nSummary:")
    print(f"  Total reward: {total_r3:.2f}")
    print(f"  Falls: {falls3}/{args.n_steps}")

    print("\nRendering turning GIF...")
    render_trajectory_gif(traj_turn, output_dir / "ainex_turning.gif", env_config)
    if args.export_trace:
        export_rollout_trace(traj_turn, output_dir / "ainex_trace_turning.json", "turn")

    print(f"\nAll outputs saved to {output_dir}/")
    print("=" * 60)


if __name__ == "__main__":
    main()
