"""Arm pose test renderer for AiNex.

Loads the MuJoCo model, applies each named arm pose, renders images from
multiple camera angles, and optionally saves a composite image or video.
Use this to visually verify that arm joint commands produce expected poses.

Usage:
    # Render all poses as images:
    python3 -m eliza_robot.sim.mujoco.arm_test --output training/videos/arm_poses

    # Render specific pose:
    python3 -m eliza_robot.sim.mujoco.arm_test --pose wave_left --output training/videos/arm_poses

    # Interactive viewer for a specific pose:
    python3 -m eliza_robot.sim.mujoco.arm_test --pose arms_forward --viewer

    # List all poses:
    python3 -m eliza_robot.sim.mujoco.arm_test --list

    # Sweep a single joint:
    python3 -m eliza_robot.sim.mujoco.arm_test --sweep r_sho_pitch --output training/videos/arm_sweep.mp4

    # Custom joint angles (space-separated name=value):
    python3 -m eliza_robot.sim.mujoco.arm_test --custom r_sho_pitch=-1.5 l_sho_pitch=-1.5 --viewer
"""

from __future__ import annotations

import argparse
from pathlib import Path

import mujoco
import numpy as np

from eliza_robot.sim.mujoco import ainex_constants as consts
from eliza_robot.sim.mujoco.arm_poses import ARM_POSES, ArmPose, list_poses


def _load_model(use_full_mesh: bool = True) -> tuple[mujoco.MjModel, mujoco.MjData]:
    """Load MuJoCo model and reset to stand keyframe."""
    xml_path = consts.SCENE_XML if use_full_mesh else consts.SCENE_PRIMITIVES_XML
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    data = mujoco.MjData(model)

    # Reset to stand keyframe
    key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "stand")
    if key_id >= 0:
        mujoco.mj_resetDataKeyframe(model, data, key_id)
    mujoco.mj_forward(model, data)

    return model, data


def _build_actuator_map(model: mujoco.MjModel) -> dict[str, int]:
    """Map joint name → actuator index."""
    act_map = {}
    for i in range(model.nu):
        act_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_ACTUATOR, i)
        if act_name and act_name.endswith("_act"):
            joint_name = act_name[:-4]  # strip "_act"
            act_map[joint_name] = i
    return act_map


def apply_pose(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    pose: dict[str, float],
    settle_steps: int = 500,
) -> None:
    """Apply joint positions via actuator control and simulate to settle."""
    act_map = _build_actuator_map(model)

    # Set ctrl for each joint in the pose
    for joint_name, target_rad in pose.items():
        if joint_name in act_map:
            data.ctrl[act_map[joint_name]] = target_rad

    # Step simulation to let the pose settle
    for _ in range(settle_steps):
        mujoco.mj_step(model, data)


def render_pose(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    width: int = 640,
    height: int = 480,
    azimuth: float = 180.0,
    elevation: float = -15.0,
    distance: float = 0.8,
) -> np.ndarray:
    """Render the current scene from a given camera angle."""
    renderer = mujoco.Renderer(model, height=height, width=width)

    body_id = model.body("body_link").id

    cam = mujoco.MjvCamera()
    cam.type = mujoco.mjtCamera.mjCAMERA_FREE
    cam.lookat[:] = data.xpos[body_id]
    cam.lookat[2] = 0.25
    cam.distance = distance
    cam.azimuth = azimuth
    cam.elevation = elevation

    renderer.update_scene(data, camera=cam)
    frame = renderer.render().copy()
    renderer.close()
    return frame


def render_pose_multiview(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    width: int = 480,
    height: int = 360,
) -> np.ndarray:
    """Render 4 views: front, right, back, left — assembled into a 2x2 grid."""
    views = []
    for azimuth in [180.0, 90.0, 0.0, 270.0]:  # front, right, back, left
        frame = render_pose(model, data, width=width, height=height,
                            azimuth=azimuth, distance=0.8)
        views.append(frame)

    # 2x2 grid
    top = np.concatenate([views[0], views[1]], axis=1)
    bottom = np.concatenate([views[2], views[3]], axis=1)
    grid = np.concatenate([top, bottom], axis=0)
    return grid


def _add_text_overlay(frame: np.ndarray, text: str) -> np.ndarray:
    """Add simple text overlay (top-left) using pixel manipulation.

    Falls back to no-op if the frame is too small.
    """
    try:
        import cv2
        frame = frame.copy()
        cv2.putText(frame, text, (10, 30), cv2.FONT_HERSHEY_SIMPLEX,
                    0.7, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(frame, text, (10, 30), cv2.FONT_HERSHEY_SIMPLEX,
                    0.7, (0, 0, 0), 1, cv2.LINE_AA)
    except ImportError:
        pass
    return frame


def get_arm_joint_positions(model: mujoco.MjModel, data: mujoco.MjData) -> dict[str, float]:
    """Read actual arm joint positions from simulation."""
    from eliza_robot.sim.mujoco.arm_poses import ALL_ARM_JOINTS
    result = {}
    for name in ALL_ARM_JOINTS:
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
        if jid >= 0:
            qpos_adr = model.jnt_qposadr[jid]
            result[name] = float(data.qpos[qpos_adr])
    return result


def get_body_positions(model: mujoco.MjModel, data: mujoco.MjData) -> dict[str, np.ndarray]:
    """Get world positions of arm-related bodies."""
    arm_bodies = [
        "r_sho_pitch_link", "r_sho_roll_link", "r_el_pitch_link", "r_el_yaw_link", "r_gripper_link",
        "l_sho_pitch_link", "l_sho_roll_link", "l_el_pitch_link", "l_el_yaw_link", "l_gripper_link",
    ]
    positions = {}
    for name in arm_bodies:
        bid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, name)
        if bid >= 0:
            positions[name] = data.xpos[bid].copy()
    return positions


def render_all_poses(output_dir: str, use_full_mesh: bool = True) -> None:
    """Render all named arm poses and save images."""
    import imageio

    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    model, data = _load_model(use_full_mesh)

    for pose_name, arm_pose in ARM_POSES.items():
        # Reset to stand before each pose
        key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "stand")
        if key_id >= 0:
            mujoco.mj_resetDataKeyframe(model, data, key_id)
        mujoco.mj_forward(model, data)

        # Apply pose
        apply_pose(model, data, arm_pose.joints, settle_steps=500)

        # Get actual joint positions
        actual = get_arm_joint_positions(model, data)

        # Render multiview
        grid = render_pose_multiview(model, data)
        grid = _add_text_overlay(grid, f"{pose_name}: {arm_pose.description[:60]}")

        img_path = out_path / f"{pose_name}.png"
        imageio.imwrite(str(img_path), grid)

        # Print joint comparison
        print(f"\n=== {pose_name} ===")
        print(f"  Description: {arm_pose.description}")
        from eliza_robot.sim.mujoco.arm_poses import ALL_ARM_JOINTS
        for jname in ALL_ARM_JOINTS:
            target = arm_pose.joints.get(jname, 0.0)
            actual_val = actual.get(jname, 0.0)
            diff = abs(target - actual_val)
            marker = " *" if diff > 0.05 else ""
            print(f"  {jname:16s}: target={target:+6.3f}  actual={actual_val:+6.3f}  diff={diff:.3f}{marker}")

        # Body positions
        bodies = get_body_positions(model, data)
        for bname, pos in bodies.items():
            print(f"  {bname:24s}: xyz=({pos[0]:+.3f}, {pos[1]:+.3f}, {pos[2]:+.3f})")

        print(f"  Saved: {img_path}")

    print(f"\nAll poses saved to {out_path}/")


def render_single_pose(pose_name: str, output_dir: str, use_full_mesh: bool = True) -> None:
    """Render a single named pose."""
    import imageio

    if pose_name not in ARM_POSES:
        print(f"Unknown pose: {pose_name}")
        print(f"Available: {', '.join(list_poses())}")
        return

    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    model, data = _load_model(use_full_mesh)
    arm_pose = ARM_POSES[pose_name]
    apply_pose(model, data, arm_pose.joints, settle_steps=500)
    grid = render_pose_multiview(model, data)
    grid = _add_text_overlay(grid, f"{pose_name}: {arm_pose.description[:60]}")

    img_path = out_path / f"{pose_name}.png"
    imageio.imwrite(str(img_path), grid)
    print(f"Saved: {img_path}")
    print(f"Description: {arm_pose.description}")


def sweep_joint(joint_name: str, output_path: str, n_frames: int = 60,
                use_full_mesh: bool = True) -> None:
    """Sweep a single arm joint through its range, save as MP4."""
    import imageio

    model, data = _load_model(use_full_mesh)

    # Get joint range
    jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, joint_name)
    if jid < 0:
        print(f"Joint not found: {joint_name}")
        return

    lower = float(model.jnt_range[jid, 0])
    upper = float(model.jnt_range[jid, 1])
    print(f"Sweeping {joint_name}: [{lower:.2f}, {upper:.2f}] rad over {n_frames} frames")

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    writer = imageio.get_writer(str(out), fps=15, codec="libx264",
                                quality=8, pixelformat="yuv420p")

    from bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS
    base_pose = dict(STAND_JOINT_POSITIONS)

    angles = np.linspace(lower * 0.9, upper * 0.9, n_frames)

    for angle in angles:
        # Reset
        key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "stand")
        if key_id >= 0:
            mujoco.mj_resetDataKeyframe(model, data, key_id)
        mujoco.mj_forward(model, data)

        # Apply pose with this joint
        pose = dict(base_pose)
        pose[joint_name] = float(angle)
        apply_pose(model, data, pose, settle_steps=300)

        frame = render_pose(model, data, azimuth=180.0)
        frame = _add_text_overlay(frame, f"{joint_name}={angle:+.2f} rad")
        writer.append_data(frame)

    writer.close()
    print(f"Saved: {out}")


def run_viewer(pose: dict[str, float], use_full_mesh: bool = True) -> None:
    """Launch MuJoCo interactive viewer with the given pose."""
    try:
        import mujoco.viewer
    except ImportError:
        print("mujoco.viewer not available.")
        return

    model, data = _load_model(use_full_mesh)
    apply_pose(model, data, pose, settle_steps=500)

    print("Launching viewer. Close window to exit.")
    print("Arm joint positions:")
    actual = get_arm_joint_positions(model, data)
    for name, val in sorted(actual.items()):
        print(f"  {name}: {val:+.3f} rad")

    mujoco.viewer.launch(model, data)


def run_custom_pose(joint_args: list[str], use_full_mesh: bool = True) -> dict[str, float]:
    """Parse name=value pairs and create a custom pose."""
    from bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS
    pose = dict(STAND_JOINT_POSITIONS)
    for arg in joint_args:
        name, val = arg.split("=")
        pose[name.strip()] = float(val.strip())
    return pose


def main() -> None:
    parser = argparse.ArgumentParser(description="AiNex arm pose test renderer")
    parser.add_argument("--pose", type=str, default=None,
                        help="Render a specific named pose")
    parser.add_argument("--output", type=str, default="training/videos/arm_poses",
                        help="Output directory for images (or .mp4 path for sweep)")
    parser.add_argument("--viewer", action="store_true",
                        help="Launch interactive 3D viewer")
    parser.add_argument("--list", action="store_true",
                        help="List available poses")
    parser.add_argument("--sweep", type=str, default=None,
                        help="Sweep a single joint through its range (save MP4)")
    parser.add_argument("--custom", nargs="*", default=None,
                        help="Custom joint angles: name=value ...")
    parser.add_argument("--primitives", action="store_true",
                        help="Use primitives model instead of full mesh")
    args = parser.parse_args()

    use_mesh = not args.primitives

    if args.list:
        print("Available arm poses:")
        for name in list_poses():
            p = ARM_POSES[name]
            print(f"  {name:20s} — {p.description}")
        return

    if args.sweep:
        sweep_joint(args.sweep, args.output, use_full_mesh=use_mesh)
        return

    if args.custom is not None:
        pose = run_custom_pose(args.custom, use_full_mesh=use_mesh)
        if args.viewer:
            run_viewer(pose, use_full_mesh=use_mesh)
        else:
            import imageio
            model, data = _load_model(use_mesh)
            apply_pose(model, data, pose, settle_steps=500)
            grid = render_pose_multiview(model, data)
            desc = " ".join(args.custom)
            grid = _add_text_overlay(grid, f"custom: {desc[:60]}")
            out = Path(args.output)
            out.mkdir(parents=True, exist_ok=True)
            img_path = out / "custom.png"
            imageio.imwrite(str(img_path), grid)
            print(f"Saved: {img_path}")
        return

    if args.pose:
        if args.viewer:
            if args.pose not in ARM_POSES:
                print(f"Unknown pose: {args.pose}. Available: {', '.join(list_poses())}")
                return
            run_viewer(ARM_POSES[args.pose].joints, use_full_mesh=use_mesh)
        else:
            render_single_pose(args.pose, args.output, use_full_mesh=use_mesh)
        return

    # Default: render all poses
    if args.viewer:
        print("--viewer requires --pose or --custom. Use --list to see poses.")
        return

    render_all_poses(args.output, use_full_mesh=use_mesh)


if __name__ == "__main__":
    main()
