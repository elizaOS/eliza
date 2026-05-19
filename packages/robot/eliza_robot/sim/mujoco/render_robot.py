"""Render the AiNex MuJoCo model in 3D.

Loads the MJCF, sets standing pose, simulates under gravity,
and renders images + animated GIF from multiple camera angles.

Usage:
    python3 -m eliza_robot.sim.mujoco.render_robot
"""

import os
from pathlib import Path

import numpy as np
import mujoco

from eliza_robot.sim.mujoco import _resolve_mjcf

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
XML_PATH = _resolve_mjcf("ainex.xml")
OUTPUT_DIR = SCRIPT_DIR.parent / "videos"


def load_model():
    """Load the AiNex MJCF model."""
    model = mujoco.MjModel.from_xml_path(str(XML_PATH))
    data = mujoco.MjData(model)
    print(f"Model loaded: {model.nbody} bodies, {model.njnt} joints, "
          f"{model.nu} actuators, {model.nq} qpos, {model.nv} qvel")
    return model, data


def set_standing_pose(model, data, use_bent_knees=True):
    """Set the robot to standing pose using keyframe."""
    key_name = "stand_bent_knees" if use_bent_knees else "stand"
    key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, key_name)
    if key_id >= 0:
        mujoco.mj_resetDataKeyframe(model, data, key_id)
        print(f"Set keyframe: {key_name}")
    else:
        print(f"Warning: keyframe '{key_name}' not found, using defaults")
        mujoco.mj_resetData(model, data)

    # Set control to match joint positions (position actuators)
    # Control order matches actuator order
    stand_ctrl = np.zeros(model.nu)
    if use_bent_knees:
        # Right leg: r_hip_yaw, r_hip_roll, r_hip_pitch, r_knee, r_ank_pitch, r_ank_roll
        stand_ctrl[0:6] = [0, 0, -0.3, 0.6, -0.3, 0]
        # Left leg: l_hip_yaw, l_hip_roll, l_hip_pitch, l_knee, l_ank_pitch, l_ank_roll
        stand_ctrl[6:12] = [0, 0, 0.3, -0.6, 0.3, 0]
        # Head: head_pan, head_tilt
        stand_ctrl[12:14] = [0, 0]
        # Right arm: r_sho_pitch, r_sho_roll, r_el_pitch, r_el_yaw, r_gripper
        stand_ctrl[14:19] = [0, 1.403, 0, 1.226, 0]
        # Left arm: l_sho_pitch, l_sho_roll, l_el_pitch, l_el_yaw, l_gripper
        stand_ctrl[19:24] = [0, -1.403, 0, -1.226, 0]
    else:
        stand_ctrl[14:19] = [0, 1.403, 0, 1.226, 0]
        stand_ctrl[19:24] = [0, -1.403, 0, -1.226, 0]

    data.ctrl[:] = stand_ctrl
    mujoco.mj_forward(model, data)


def simulate_settle(model, data, seconds=2.0):
    """Simulate for some time to let the robot settle under gravity."""
    body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "body_link")
    n_steps = int(seconds / model.opt.timestep)
    print(f"Simulating {seconds}s ({n_steps} steps) to settle...")
    for i in range(n_steps):
        mujoco.mj_step(model, data)
        if i % 500 == 0:
            torso_z = data.xpos[body_id, 2]
            foot_r = data.xpos[mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "r_ank_roll_link"), 2]
            t = i * model.opt.timestep
            print(f"  t={t:.2f}s: torso_z={torso_z:.4f}, r_foot_z={foot_r:.4f}")
            if torso_z < 0.05:
                print(f"  Robot fell!")
                return False
    torso_z = data.xpos[body_id, 2]
    print(f"  Settled. Torso height: {torso_z:.3f}m")
    return torso_z > 0.1


def make_camera(model, data, lookat=None, distance=0.8, azimuth=135, elevation=-20):
    """Create an MjvCamera with given parameters."""
    cam = mujoco.MjvCamera()
    cam.type = mujoco.mjtCamera.mjCAMERA_FREE

    if lookat is not None:
        cam.lookat[:] = lookat
    else:
        body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "body_link")
        cam.lookat[:] = data.xpos[body_id]

    cam.distance = distance
    cam.azimuth = azimuth
    cam.elevation = elevation
    return cam


def render_frame(model, data, renderer, lookat=None,
                 distance=0.8, azimuth=135, elevation=-20):
    """Render a single frame."""
    cam = make_camera(model, data, lookat, distance, azimuth, elevation)
    renderer.update_scene(data, camera=cam)
    return renderer.render()


def render_multi_view(model, data, width=640, height=480):
    """Render from 4 camera angles and combine into one image."""
    renderer = mujoco.Renderer(model, height=height, width=width)

    body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "body_link")
    lookat = data.xpos[body_id].copy()

    views = [
        {"azimuth": 135, "elevation": -20, "distance": 0.7, "label": "Front-Right"},
        {"azimuth": 225, "elevation": -20, "distance": 0.7, "label": "Front-Left"},
        {"azimuth": 180, "elevation": -15, "distance": 0.6, "label": "Front"},
        {"azimuth": 180, "elevation": -80, "distance": 0.6, "label": "Top-Down"},
    ]

    images = []
    for v in views:
        img = render_frame(model, data, renderer, lookat=lookat,
                          distance=v["distance"], azimuth=v["azimuth"],
                          elevation=v["elevation"])
        images.append(img.copy())

    renderer.close()

    # Combine into 2x2 grid
    top = np.concatenate([images[0], images[1]], axis=1)
    bottom = np.concatenate([images[2], images[3]], axis=1)
    combined = np.concatenate([top, bottom], axis=0)

    return combined, images


def render_turntable_gif(model, data, output_path, width=640, height=480,
                         n_frames=60, fps=20):
    """Render a turntable rotation GIF."""
    from PIL import Image

    renderer = mujoco.Renderer(model, height=height, width=width)
    body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "body_link")
    lookat = data.xpos[body_id].copy()

    frames = []
    for i in range(n_frames):
        azimuth = 360.0 * i / n_frames
        img = render_frame(model, data, renderer, lookat=lookat,
                          distance=0.65, azimuth=azimuth, elevation=-18)
        frames.append(Image.fromarray(img.copy()))

    renderer.close()

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
    print(f"  Saved turntable GIF: {output_path} ({n_frames} frames, {size_mb:.1f} MB)")


def render_simulation_gif(model, data, output_path, width=640, height=480,
                          sim_seconds=3.0, fps=30):
    """Render a GIF of the robot settling/standing under gravity."""
    from PIL import Image

    # Reset to standing pose
    set_standing_pose(model, data, use_bent_knees=False)

    renderer = mujoco.Renderer(model, height=height, width=width)
    body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "body_link")

    frames = []
    frame_interval = int(1.0 / (fps * model.opt.timestep))
    n_steps = int(sim_seconds / model.opt.timestep)

    for step in range(n_steps):
        mujoco.mj_step(model, data)

        if step % frame_interval == 0:
            lookat = data.xpos[body_id].copy()
            img = render_frame(model, data, renderer, lookat=lookat,
                              distance=0.65, azimuth=150, elevation=-18)
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
        print(f"  Saved simulation GIF: {output_path} ({len(frames)} frames, {size_mb:.1f} MB)")


def main():
    from PIL import Image

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("AiNex MuJoCo 3D Renderer")
    print("=" * 60)

    # Load model
    model, data = load_model()

    # 1. Render standing pose (multi-view) - settle first
    print("\n--- Standing Pose + Settle ---")
    set_standing_pose(model, data, use_bent_knees=False)
    simulate_settle(model, data, seconds=2.0)
    combined, views = render_multi_view(model, data)
    img_path = OUTPUT_DIR / "ainex_standing_4view.png"
    Image.fromarray(combined).save(str(img_path))
    print(f"  Saved: {img_path}")

    # Also save individual views
    for i, label in enumerate(["front_right", "front_left", "front", "top"]):
        vpath = OUTPUT_DIR / f"ainex_standing_{label}.png"
        Image.fromarray(views[i]).save(str(vpath))

    # 2. Turntable GIF (settled pose)
    print("\n--- Turntable Rotation ---")
    render_turntable_gif(model, data, OUTPUT_DIR / "ainex_turntable.gif",
                         n_frames=72, fps=24)

    # 3. Simulation GIF (settling under gravity from initial pose)
    print("\n--- Gravity Simulation ---")
    render_simulation_gif(model, data, OUTPUT_DIR / "ainex_gravity_settle.gif",
                          sim_seconds=4.0, fps=30)

    print(f"\nAll renders saved to {OUTPUT_DIR}/")
    print("=" * 60)


if __name__ == "__main__":
    main()
