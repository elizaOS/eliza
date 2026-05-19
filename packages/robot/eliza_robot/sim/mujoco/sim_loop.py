"""Real-time MuJoCo simulation loop for AiNex walking policy.

Runs the v12 policy at 50Hz on CPU MuJoCo with interactive velocity
commands. Extracts observations from MuJoCo sensor data and maintains
a 3-frame observation history buffer.

Usage:
    # Headless (record MP4):
    python3 -m eliza_robot.sim.mujoco.sim_loop --checkpoint checkpoints/mujoco_locomotion_v12_dr

    # With viewer (interactive):
    python3 -m eliza_robot.sim.mujoco.sim_loop --checkpoint checkpoints/mujoco_locomotion_v12_dr --viewer

    # Fixed command:
    python3 -m eliza_robot.sim.mujoco.sim_loop --vx 0.5 --vyaw 0.3
"""

import argparse
import sys
import threading
import time
from pathlib import Path

import mujoco
import numpy as np

from eliza_robot.sim.mujoco import ainex_constants as consts
from eliza_robot.sim.mujoco.inference import load_policy


# Observation layout for v13 walking policy:
# gyro(3) + gravity(3) + command(3) + leg_pos(12) + leg_vel(12) + last_act(12) = 45
# NOTE: newer joystick.py adds gait_phase(2) = 47, but v13 was trained without it.
# The actual obs_size is auto-detected from the checkpoint config at runtime.
SINGLE_OBS_DIM = 45
OBS_HISTORY_SIZE = 3
TOTAL_OBS_DIM = SINGLE_OBS_DIM * OBS_HISTORY_SIZE  # 135
NUM_LEGS = 12
ACTION_SCALE = 0.3  # Overridden from checkpoint config at runtime
CTRL_DT = 0.02  # 50 Hz policy


def validate_robot_above_ground(
    model: mujoco.MjModel,
    data: mujoco.MjData,
    tolerance: float = -0.035,
    min_torso_z: float = 0.10,
    exclude_names: tuple[str, ...] = ("floor",),
) -> tuple[bool, list[str]]:
    """Check that no robot geometry extends catastrophically below ground.

    Checks the axis-aligned bounding box bottom of every geom against z=0.
    For mesh geoms, transforms mesh vertices to world frame and checks the
    minimum z. Also checks that the torso is above a minimum height.

    Note: Feet naturally have AABB slightly below z=0 due to ankle rotation;
    the tolerance is set to accommodate this while catching real issues
    (robot fallen, walking on arms, etc).

    Args:
        model: MuJoCo model.
        data: MuJoCo data (must have mj_forward called).
        tolerance: Maximum allowed penetration below z=0 (negative = below).
            Default -0.035m accommodates foot AABB margins from ankle rotation.
        min_torso_z: Minimum torso z height. If the torso drops below this,
            the robot has likely fallen.
        exclude_names: Geom names to skip (e.g., floor, entity objects).

    Returns:
        (ok, violations) where ok is True if no violations, and violations
        is a list of strings describing each violating geom.
    """
    violations = []
    entity_prefix = "entity_"

    for i in range(model.ngeom):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or f"geom_{i}"
        if name in exclude_names or name.startswith(entity_prefix):
            continue
        # Also exclude geoms whose parent body is an entity (unnamed geoms)
        body_id = model.geom_bodyid[i]
        body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id) or ""
        if body_name.startswith(entity_prefix):
            continue

        pos = data.geom_xpos[i]
        geom_type = model.geom_type[i]
        size = model.geom_size[i]

        # Geom types: 0=plane 2=sphere 3=capsule 4=ellipsoid 5=cylinder 6=box 7=mesh
        xmat = data.geom_xmat[i].reshape(3, 3)

        if geom_type == 0:  # plane
            continue
        elif geom_type == 7:  # mesh
            mesh_id = model.geom_dataid[i]
            if mesh_id >= 0:
                vert_start = model.mesh_vertadr[mesh_id]
                vert_count = model.mesh_vertnum[mesh_id]
                if vert_count > 0:
                    verts = model.mesh_vert[vert_start:vert_start + vert_count]
                    world_verts = verts @ xmat.T + pos
                    bottom_z = float(world_verts[:, 2].min())
                else:
                    bottom_z = pos[2]
            else:
                bottom_z = pos[2]
        elif geom_type == 6:  # box
            # Box half-sizes rotated to world frame
            corners_z = abs(xmat[2, 0]) * size[0] + abs(xmat[2, 1]) * size[1] + abs(xmat[2, 2]) * size[2]
            bottom_z = pos[2] - corners_z
        elif geom_type == 3:  # capsule (size[0]=radius, size[1]=half-length)
            # Capsule axis is local z; project to world and add radius
            axis_world = xmat[:, 2] * size[1]
            bottom_z = pos[2] - abs(axis_world[2]) - size[0]
        elif geom_type == 5:  # cylinder (size[0]=radius, size[1]=half-length)
            axis_world = xmat[:, 2] * size[1]
            bottom_z = pos[2] - abs(axis_world[2])
        elif geom_type == 2:  # sphere
            bottom_z = pos[2] - size[0]
        elif geom_type == 4:  # ellipsoid
            bottom_z = pos[2] - size[2]
        else:
            bottom_z = pos[2]

        if bottom_z < tolerance:
            violations.append(
                f"{name}: bottom_z={bottom_z:.4f} (pos_z={pos[2]:.4f})"
            )

    # Check torso height — if it drops too low the robot has fallen
    torso_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "body_link")
    if torso_id >= 0:
        torso_z = data.xpos[torso_id][2]
        if torso_z < min_torso_z:
            violations.append(
                f"body_link torso too low: z={torso_z:.4f} (min={min_torso_z})"
            )

    return len(violations) == 0, violations


class SimLoop:
    """Real-time CPU MuJoCo simulation with trained Brax policy."""

    def __init__(
        self,
        checkpoint_dir: str,
        use_full_mesh: bool = True,
        kp: float | None = None,
        kd: float | None = None,
    ):
        # Load policy
        print(f"Loading policy from {checkpoint_dir}...")
        self.inference_fn, self.config = load_policy(checkpoint_dir)
        print("Policy loaded.")

        # Auto-detect physics params from checkpoint config
        env_cfg = self.config.get("env_config", {})
        if kp is None:
            kp = float(env_cfg.get("Kp", 200.0))
        if kd is None:
            kd = float(env_cfg.get("Kd", 5.0))

        # Auto-detect obs and action dimensions
        global SINGLE_OBS_DIM, TOTAL_OBS_DIM, ACTION_SCALE
        ckpt_obs = self.config.get("obs_size")
        ckpt_act_scale = float(env_cfg.get("action_scale", 0.3))
        if ckpt_obs:
            obs_history = int(env_cfg.get("obs_history_size", 3))
            SINGLE_OBS_DIM = ckpt_obs // obs_history
            TOTAL_OBS_DIM = ckpt_obs
        ACTION_SCALE = ckpt_act_scale
        print(f"Config: Kp={kp} Kd={kd} obs={SINGLE_OBS_DIM}×{OBS_HISTORY_SIZE}={TOTAL_OBS_DIM} action_scale={ACTION_SCALE}")

        # Use the PRIMITIVES model — this is what base_env.py loads for
        # Brax/MJX training.  Previous versions used SCENE_MJX_XML which has
        # different Kp (50 vs 200), damping (1 vs 5), foot sizes, and force
        # ranges, causing a massive sim gap.
        self.use_full_mesh = use_full_mesh
        self.model = mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))
        self.model.opt.timestep = 0.004  # sim_dt matching training
        self.data = mujoco.MjData(self.model)

        # Set PD gains on LEG actuators only (0:12), matching base_env.py.
        # Head/arm actuators keep their XML-defined kp values.
        n_leg = min(12, self.model.nu)
        self.model.actuator_gainprm[:n_leg, 0] = kp
        self.model.actuator_biasprm[:n_leg, 1] = -kp
        for i in range(n_leg):
            jnt_id = self.model.actuator_trnid[i, 0]
            dof_adr = self.model.jnt_dofadr[jnt_id]
            self.model.dof_damping[dof_adr] = kd

        # Build actuator → qpos/qvel index maps.
        # Models may differ in how many DOFs precede the actuated joints
        # (e.g., full mesh has 3 extra slide joints before the freejoint).
        self._act_qpos_idx = np.array([
            self.model.jnt_qposadr[self.model.actuator_trnid[i, 0]]
            for i in range(self.model.nu)
        ])
        self._act_dof_idx = np.array([
            self.model.jnt_dofadr[self.model.actuator_trnid[i, 0]]
            for i in range(self.model.nu)
        ])

        # Default pose = model's initial qpos (matches training env init).
        # NOTE: Previous versions loaded the "stand_bent_knees" keyframe here,
        # but the Brax training env initializes from qpos0 (all zeros), so the
        # policy was trained relative to the straight-leg pose, not bent knees.
        mujoco.mj_forward(self.model, self.data)
        self.default_pose = self.data.qpos[self._act_qpos_idx].copy()

        # Set initial control to default pose
        self.data.ctrl[:] = self.default_pose
        mujoco.mj_forward(self.model, self.data)

        # Sensor addresses
        self._gyro_adr = self._sensor_slice("gyro")
        self._gravity_adr = self._sensor_slice("upvector")

        # Body ID for torso tracking
        self._torso_id = self.model.body("body_link").id

        # State
        self.command = np.array([0.0, 0.0, 0.0], dtype=np.float32)  # vx, vy, vyaw
        self.last_action = np.zeros(NUM_LEGS, dtype=np.float32)
        self.obs_history = np.zeros(TOTAL_OBS_DIM, dtype=np.float32)
        self.step_count = 0

        # Gait phase clock (for policies trained with gait_phase obs)
        self.gait_phase = 0.0
        self._gait_frequency = float(env_cfg.get("gait_frequency", 2.0))
        self._has_gait_phase = SINGLE_OBS_DIM >= 47  # 47 = 45 + 2 (sin/cos)

        # Substeps per control step
        self.n_substeps = int(CTRL_DT / self.model.opt.timestep)

    def _sensor_slice(self, name: str) -> slice:
        """Get sensordata slice for a named sensor."""
        sid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SENSOR, name)
        adr = self.model.sensor_adr[sid]
        dim = self.model.sensor_dim[sid]
        return slice(adr, adr + dim)

    def get_obs(self) -> np.ndarray:
        """Extract observation from CPU MuJoCo data.

        Layout (45 or 47 dims depending on checkpoint):
          gyro(3) + gravity(3) + command(3) + [gait_phase(2)] + leg_pos(12) + leg_vel(12) + last_act(12)
        """
        gyro = self.data.sensordata[self._gyro_adr].copy()
        gravity = self.data.sensordata[self._gravity_adr].copy()

        # Use actuator index maps — works for both full mesh and primitives models
        leg_qpos_idx = self._act_qpos_idx[:NUM_LEGS]
        leg_dof_idx = self._act_dof_idx[:NUM_LEGS]
        leg_pos = self.data.qpos[leg_qpos_idx] - self.default_pose[:NUM_LEGS]
        leg_vel = self.data.qvel[leg_dof_idx] * 0.05

        parts = [
            gyro,                     # 3
            gravity,                  # 3
            self.command,             # 3
        ]
        if self._has_gait_phase:
            parts.append(np.array([
                np.sin(self.gait_phase),
                np.cos(self.gait_phase),
            ], dtype=np.float32))     # 2
        parts.extend([
            leg_pos,                  # 12
            leg_vel,                  # 12
            self.last_action,         # 12
        ])

        return np.concatenate(parts).astype(np.float32)

    def stack_history(self, obs: np.ndarray) -> np.ndarray:
        """Push new obs into front of history buffer, shift old ones back."""
        self.obs_history = np.roll(self.obs_history, obs.size)
        self.obs_history[:obs.size] = obs
        return self.obs_history.copy()

    def policy_step(self) -> np.ndarray:
        """Run one policy inference step and apply action to simulation.

        Returns the 12-dim joint target offsets (raw policy output).
        """
        obs = self.get_obs()
        full_obs = self.stack_history(obs)

        # Run policy
        action = self.inference_fn(full_obs)
        action = np.clip(action, -1.0, 1.0)

        # Convert to motor targets: default_pose + action * action_scale
        leg_targets = self.default_pose[:NUM_LEGS] + action[:NUM_LEGS] * ACTION_SCALE

        # Full control: legs from policy, head/arms from default
        ctrl = self.default_pose.copy()
        ctrl[:NUM_LEGS] = leg_targets

        # Clip to actuator limits
        ctrl = np.clip(ctrl, self.model.actuator_ctrlrange[:, 0],
                        self.model.actuator_ctrlrange[:, 1])
        self.data.ctrl[:] = ctrl

        # Step simulation
        for _ in range(self.n_substeps):
            mujoco.mj_step(self.model, self.data)

        self.last_action = action[:NUM_LEGS].astype(np.float32)
        self.step_count += 1

        # Advance gait phase clock
        if self._has_gait_phase:
            self.gait_phase = (
                self.gait_phase + 2.0 * np.pi * self._gait_frequency * CTRL_DT
            ) % (2.0 * np.pi)

        return action[:NUM_LEGS]

    def get_torso_state(self) -> dict:
        """Get current torso position and orientation."""
        pos = self.data.xpos[self._torso_id].copy()
        return {
            "x": float(pos[0]),
            "y": float(pos[1]),
            "z": float(pos[2]),
            "step": self.step_count,
        }

    def reset(self):
        """Reset simulation to standing pose."""
        key_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_KEY, "stand_bent_knees")
        if key_id >= 0:
            mujoco.mj_resetDataKeyframe(self.model, self.data, key_id)
        self.data.ctrl[:] = self.default_pose
        mujoco.mj_forward(self.model, self.data)
        self.last_action = np.zeros(NUM_LEGS, dtype=np.float32)
        self.obs_history = np.zeros(TOTAL_OBS_DIM, dtype=np.float32)
        self.step_count = 0
        self.gait_phase = 0.0


def _command_reader(sim: SimLoop, stop_event: threading.Event):
    """Read velocity commands from stdin in a background thread.

    Format: vx vy vyaw  (space-separated floats)
    Special commands: quit, reset, status
    """
    print("\nCommand input (vx vy vyaw), or: quit, reset, status")
    print(f"Current command: {sim.command}")

    while not stop_event.is_set():
        try:
            line = input("> ").strip()
        except EOFError:
            break

        if not line:
            continue
        if line == "quit":
            stop_event.set()
            break
        if line == "reset":
            sim.reset()
            print("Reset.")
            continue
        if line == "status":
            state = sim.get_torso_state()
            print(f"Step: {state['step']}, Pos: ({state['x']:.3f}, {state['y']:.3f}, {state['z']:.3f})")
            print(f"Command: vx={sim.command[0]:.2f} vy={sim.command[1]:.2f} vyaw={sim.command[2]:.2f}")
            continue

        try:
            parts = line.split()
            if len(parts) == 1:
                sim.command[0] = float(parts[0])
            elif len(parts) == 2:
                sim.command[0] = float(parts[0])
                sim.command[2] = float(parts[1])
            elif len(parts) >= 3:
                sim.command[0] = float(parts[0])
                sim.command[1] = float(parts[1])
                sim.command[2] = float(parts[2])
            print(f"Command: vx={sim.command[0]:.2f} vy={sim.command[1]:.2f} vyaw={sim.command[2]:.2f}")
        except ValueError:
            print("Usage: vx [vy] [vyaw] — e.g. '0.5' or '0.5 0.0 0.3'")


def run_headless(
    sim: SimLoop,
    n_steps: int = 500,
    output_path: str = "training/videos/sim_loop.mp4",
    fps: int = 30,
    width: int = 640,
    height: int = 480,
):
    """Run simulation headless, record MP4.

    Physics run on the primitives model.  If use_full_mesh is enabled,
    a separate full-mesh model is loaded for rendering and qpos is
    remapped each frame.
    """
    import imageio
    from eliza_robot.sim.mujoco.eval_policy import _build_qpos_map

    # Rendering model: full mesh if requested, otherwise same as physics model
    if sim.use_full_mesh and consts.SCENE_XML.exists():
        render_model = mujoco.MjModel.from_xml_path(str(consts.SCENE_XML))
        render_data = mujoco.MjData(render_model)
        src_idx, dst_idx = _build_qpos_map(sim.model, render_model)
        need_remap = True
    else:
        render_model = sim.model
        render_data = sim.data
        need_remap = False

    renderer = mujoco.Renderer(render_model, height=height, width=width)
    body_id = render_model.body("body_link").id

    frame_skip = max(1, int(1.0 / (fps * CTRL_DT)))

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = imageio.get_writer(str(output_path), fps=fps, codec="libx264",
                                quality=8, pixelformat="yuv420p")

    print(f"Running {n_steps} steps headless, recording to {output_path}...")
    for step in range(n_steps):
        action = sim.policy_step()

        # Validate robot stays above ground (check physics model every step)
        ok, violations = validate_robot_above_ground(sim.model, sim.data)
        if not ok:
            state = sim.get_torso_state()
            msg = (
                f"Ground penetration at step {step} "
                f"(torso z={state['z']:.4f}):\n"
                + "\n".join(f"  {v}" for v in violations)
            )
            writer.close()
            renderer.close()
            raise RuntimeError(msg)

        if step % frame_skip == 0:
            # Copy physics state to render model
            if need_remap:
                key_id = mujoco.mj_name2id(render_model, mujoco.mjtObj.mjOBJ_KEY,
                                           "stand_bent_knees")
                if key_id >= 0:
                    mujoco.mj_resetDataKeyframe(render_model, render_data, key_id)
                render_data.qpos[dst_idx] = sim.data.qpos[src_idx]
                mujoco.mj_forward(render_model, render_data)

            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            cam.lookat[:] = render_data.xpos[body_id]
            cam.lookat[2] = 0.25
            cam.distance = 0.9
            cam.azimuth = 135
            cam.elevation = -20
            renderer.update_scene(render_data, camera=cam)
            frame = renderer.render()
            writer.append_data(frame.copy())

        if step % 100 == 0:
            state = sim.get_torso_state()
            print(f"  Step {step}: pos=({state['x']:.3f}, {state['y']:.3f}, {state['z']:.3f})")

    writer.close()
    renderer.close()
    print(f"Saved: {output_path}")


def run_viewer(sim: SimLoop, max_steps: int = 10000):
    """Run simulation with MuJoCo viewer (interactive 3D window)."""
    try:
        import mujoco.viewer
    except ImportError:
        print("mujoco.viewer not available. Use --headless instead.")
        return

    stop_event = threading.Event()

    # Start command reader thread
    cmd_thread = threading.Thread(target=_command_reader, args=(sim, stop_event), daemon=True)
    cmd_thread.start()

    print(f"Starting viewer. Enter commands in terminal.")
    print(f"Close viewer window or type 'quit' to stop.")

    with mujoco.viewer.launch_passive(sim.model, sim.data) as viewer:
        step = 0
        while viewer.is_running() and not stop_event.is_set() and step < max_steps:
            t0 = time.monotonic()

            sim.policy_step()

            # Validate robot stays above ground
            ok, violations = validate_robot_above_ground(sim.model, sim.data)
            if not ok:
                state = sim.get_torso_state()
                print(
                    f"\nWARNING: Ground penetration at step {step} "
                    f"(torso z={state['z']:.4f}):"
                )
                for v in violations:
                    print(f"  {v}")

            viewer.sync()
            step += 1

            # Maintain real-time pace
            elapsed = time.monotonic() - t0
            sleep_time = CTRL_DT - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

            if step % 250 == 0:
                state = sim.get_torso_state()
                print(f"  Step {step}: pos=({state['x']:.3f}, {state['y']:.3f}, {state['z']:.3f})")

    stop_event.set()
    print("Viewer closed.")


def main():
    parser = argparse.ArgumentParser(description="Real-time AiNex simulation loop")
    parser.add_argument("--checkpoint", type=str,
                        default="checkpoints/mujoco_locomotion_v12_dr",
                        help="Path to Brax checkpoint directory")
    parser.add_argument("--viewer", action="store_true",
                        help="Launch interactive 3D viewer")
    parser.add_argument("--n-steps", type=int, default=500,
                        help="Number of steps (headless mode)")
    parser.add_argument("--output", type=str, default="training/videos/sim_loop.mp4",
                        help="Output MP4 path (headless mode)")
    parser.add_argument("--vx", type=float, default=0.5,
                        help="Initial forward velocity command")
    parser.add_argument("--vy", type=float, default=0.0,
                        help="Initial lateral velocity command")
    parser.add_argument("--vyaw", type=float, default=0.0,
                        help="Initial yaw velocity command")
    parser.add_argument("--primitives", action="store_true",
                        help="Use primitives model instead of full mesh")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    args = parser.parse_args()

    sim = SimLoop(
        checkpoint_dir=args.checkpoint,
        use_full_mesh=not args.primitives,
    )
    sim.command[:] = [args.vx, args.vy, args.vyaw]
    print(f"Initial command: vx={args.vx}, vy={args.vy}, vyaw={args.vyaw}")

    if args.viewer:
        run_viewer(sim, max_steps=args.n_steps * 20)
    else:
        run_headless(sim, n_steps=args.n_steps, output_path=args.output,
                     fps=args.fps, width=args.width, height=args.height)


if __name__ == "__main__":
    main()
