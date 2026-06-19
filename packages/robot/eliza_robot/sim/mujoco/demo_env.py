"""CPU MuJoCo environment for closed-loop demos.

Provides the same telemetry interface as the bridge, but backed by
MuJoCo physics instead of real hardware. Used to validate the full
LLM -> perception -> policy -> joints loop in simulation.

Usage:
    from eliza_robot.sim.mujoco.demo_env import DemoEnv

    env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    telemetry = env.reset()
    frame = env.render_ego()

    for _ in range(500):
        telemetry = env.step(joint_targets={"r_hip_pitch": -0.3, ...})
        frame = env.render_ego()
        if env.is_target_reached():
            break

    env.close()
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

try:
    import mujoco
except ImportError:
    mujoco = None  # type: ignore[assignment]

from eliza_robot.sim.mujoco import ainex_constants as consts


# Head camera name in all AiNex MJCF files.
_HEAD_CAM_NAME = "head_cam"

# Default PD gains matching sim_loop.py training.
# Default gains — TargetReaching uses 21.1/1.084, Joystick uses 200/5.
# Callers should pass the correct values for their checkpoint.
_DEFAULT_KP = 21.1
_DEFAULT_KD = 1.084


class DemoEnv:
    """CPU MuJoCo environment for closed-loop demos.

    Provides the same telemetry interface as the bridge, but backed by
    MuJoCo physics instead of real hardware. Used to validate the full
    LLM -> perception -> policy -> joints loop in simulation.
    """

    def __init__(
        self,
        xml_path: str | None = None,
        target_position: tuple[float, float, float] = (2.0, 0.0, 0.05),
        target_type: str = "sphere",
        target_color: tuple[float, ...] = (1.0, 0.0, 0.0, 1.0),
        target_size: float = 0.05,
        camera_width: int = 640,
        camera_height: int = 480,
        timestep: float = 0.002,
        kp: float = _DEFAULT_KP,
        kd: float = _DEFAULT_KD,
    ) -> None:
        if mujoco is None:
            raise ImportError(
                "mujoco is required for DemoEnv. Install with: pip install mujoco"
            )

        self._camera_width = camera_width
        self._camera_height = camera_height
        self._target_position = np.array(target_position, dtype=np.float64)
        self._closed = False

        # --- Load model with injected target body --------------------------
        # Use PRIMITIVES model — matches base_env.py training physics
        resolved_xml = xml_path or str(consts.SCENE_PRIMITIVES_XML)
        spec = mujoco.MjSpec.from_file(resolved_xml)
        # Bump the offscreen framebuffer so render_external() can produce
        # ≥720p frames; default in the primitives MJCF is 640×480.
        spec.visual.global_.offwidth = max(1280, spec.visual.global_.offwidth)
        spec.visual.global_.offheight = max(720, spec.visual.global_.offheight)

        # Add an external "third-person" camera so callers can render the
        # robot from outside its head (useful for evidence videos that
        # need to show the robot moving, not what the robot sees).
        ext_cam_body = spec.worldbody.add_body()
        ext_cam_body.name = "external_cam_body"
        ext_cam_body.pos = [-1.0, -1.2, 0.45]  # behind-left, slightly above torso
        ext_cam = ext_cam_body.add_camera()
        ext_cam.name = "external_cam"
        ext_cam.fovy = 60.0
        ext_cam.mode = mujoco.mjtCamLight.mjCAMLIGHT_TARGETBODY
        ext_cam.targetbody = "body_link"  # always frame the torso

        # Add a target body with a visible geom (no collision).
        body = spec.worldbody.add_body()
        body.name = "target_ball"
        body.pos = list(target_position)
        geom = body.add_geom()
        geom.name = "target_ball_geom"
        _geom_type_map = {
            "sphere": mujoco.mjtGeom.mjGEOM_SPHERE,
            "box": mujoco.mjtGeom.mjGEOM_BOX,
            "cylinder": mujoco.mjtGeom.mjGEOM_CYLINDER,
        }
        geom.type = _geom_type_map.get(target_type, mujoco.mjtGeom.mjGEOM_SPHERE)
        geom.size = [target_size, 0, 0]
        geom.rgba = list(target_color)
        geom.contype = 0
        geom.conaffinity = 0

        self.model: mujoco.MjModel = spec.compile()
        self.model.opt.timestep = timestep
        self.data: mujoco.MjData = mujoco.MjData(self.model)

        # --- PD gains (matching sim_loop.py) --------------------------------
        self.model.actuator_gainprm[:, 0] = kp
        self.model.actuator_biasprm[:, 1] = -kp
        for i in range(self.model.nu):
            jnt_id = self.model.actuator_trnid[i, 0]
            dof_adr = self.model.jnt_dofadr[jnt_id]
            self.model.dof_damping[dof_adr] = kd

        # --- Actuator -> qpos/qvel index maps ------------------------------
        self._act_qpos_idx = np.array([
            self.model.jnt_qposadr[self.model.actuator_trnid[i, 0]]
            for i in range(self.model.nu)
        ])
        self._act_dof_idx = np.array([
            self.model.jnt_dofadr[self.model.actuator_trnid[i, 0]]
            for i in range(self.model.nu)
        ])

        # --- Actuator name -> index map ------------------------------------
        self._act_name_to_idx: dict[str, int] = {}
        for i in range(self.model.nu):
            jnt_id = self.model.actuator_trnid[i, 0]
            jnt_name = mujoco.mj_id2name(
                self.model, mujoco.mjtObj.mjOBJ_JOINT, jnt_id
            )
            if jnt_name:
                self._act_name_to_idx[jnt_name] = i

        # --- Default (standing) pose from keyframe -------------------------
        key_id = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_KEY, "stand_bent_knees"
        )
        if key_id >= 0:
            mujoco.mj_resetDataKeyframe(self.model, self.data, key_id)
        self._default_pose = self.data.qpos[self._act_qpos_idx].copy()
        self.data.ctrl[:] = self._default_pose
        mujoco.mj_forward(self.model, self.data)

        # --- Sensor address slices ------------------------------------------
        self._gyro_adr = self._sensor_slice("gyro")
        self._accel_adr = self._sensor_slice("accelerometer")
        self._gravity_adr = self._sensor_slice("upvector")

        # --- Body IDs -------------------------------------------------------
        self._torso_id = self.model.body("body_link").id
        self._target_body_id = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_BODY, "target_ball"
        )

        # --- Camera (SimCamera-compatible) ----------------------------------
        from eliza_robot.perception.sim.sim_camera import SimCamera

        self._sim_camera = SimCamera(
            model=self.model,
            data=self.data,
            camera_name=_HEAD_CAM_NAME,
            width=camera_width,
            height=camera_height,
        )
        # Third-person renderer used by `render_external()`. Lazily
        # constructed so the import + GL context aren't paid unless
        # somebody actually asks for an external frame.
        self._external_renderer: mujoco.Renderer | None = None
        self._external_size = (camera_width, camera_height)

        # --- Runtime state --------------------------------------------------
        self._is_walking = False
        self._step_count = 0

    # ------------------------------------------------------------------
    # Sensor helpers
    # ------------------------------------------------------------------

    def _sensor_slice(self, name: str) -> slice:
        sid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SENSOR, name)
        if sid < 0:
            raise ValueError(f"Sensor '{name}' not found in model")
        adr = self.model.sensor_adr[sid]
        dim = self.model.sensor_dim[sid]
        return slice(adr, adr + dim)

    # ------------------------------------------------------------------
    # Joint name helpers
    # ------------------------------------------------------------------

    @property
    def joint_names(self) -> tuple[str, ...]:
        """All actuated joint names in actuator order."""
        return consts.ALL_JOINT_NAMES

    @property
    def default_pose(self) -> np.ndarray:
        """Default (standing) joint angles for all actuators."""
        return self._default_pose.copy()

    # ------------------------------------------------------------------
    # Telemetry extraction (bridge-compatible format)
    # ------------------------------------------------------------------

    def _build_telemetry(self) -> dict[str, Any]:
        """Build telemetry dict matching the bridge server format."""
        # Joint positions
        joint_positions: dict[str, float] = {}
        for jname, act_idx in self._act_name_to_idx.items():
            qpos_idx = self._act_qpos_idx[act_idx]
            joint_positions[jname] = float(self.data.qpos[qpos_idx])

        # IMU: the upvector sensor (framezaxis on body_link) reads the body's
        # Z-axis in world frame.  The convention depends on the XML:
        #   primitives: [0,0,1] when upright (Z-up body frame)
        #   mjx:        [0,-1,0] when upright (Y-down body frame)
        # We detect the convention from the initial reading and convert to
        # roll=0, pitch=0 when upright.
        gravity = self.data.sensordata[self._gravity_adr].copy()
        if abs(gravity[2]) > abs(gravity[1]):
            # Z-up convention (primitives): upright=[0,0,1]
            imu_roll = float(math.atan2(-gravity[1], gravity[2]))
            imu_pitch = float(math.atan2(-gravity[0], gravity[2]))
        else:
            # Y-down convention (mjx): upright=[0,-1,0]
            imu_roll = float(math.atan2(gravity[0], -gravity[1]))
            imu_pitch = float(math.atan2(gravity[2], -gravity[1]))

        # Gyro
        gyro = self.data.sensordata[self._gyro_adr].copy()

        return {
            "joint_positions": joint_positions,
            "imu_roll": imu_roll,
            "imu_pitch": imu_pitch,
            "gyro": [float(gyro[0]), float(gyro[1]), float(gyro[2])],
            "walking": self._is_walking,
            "battery_mv": 12400,
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def reset(self) -> dict[str, Any]:
        """Reset the environment. Returns initial telemetry."""
        key_id = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_KEY, "stand_bent_knees"
        )
        if key_id >= 0:
            mujoco.mj_resetDataKeyframe(self.model, self.data, key_id)
        self.data.ctrl[:] = self._default_pose
        mujoco.mj_forward(self.model, self.data)
        self._is_walking = False
        self._step_count = 0
        return self._build_telemetry()

    def step(self, joint_targets: dict[str, float] | None = None) -> dict[str, Any]:
        """Step physics and return telemetry dict matching bridge format.

        Args:
            joint_targets: Optional dict mapping joint name -> target radians.
                Only the provided joints are updated; others keep their
                current control target.

        Returns:
            Telemetry dict with joint_positions, imu_roll, imu_pitch,
            gyro, walking, and battery_mv.
        """
        if joint_targets:
            self._is_walking = True
            for jname, target_rad in joint_targets.items():
                act_idx = self._act_name_to_idx.get(jname)
                if act_idx is not None:
                    self.data.ctrl[act_idx] = float(target_rad)

        mujoco.mj_step(self.model, self.data)
        self._step_count += 1
        return self._build_telemetry()

    def step_n(
        self,
        n: int,
        joint_targets: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        """Step physics n times with the same targets. Returns final telemetry."""
        if joint_targets:
            self._is_walking = True
            for jname, target_rad in joint_targets.items():
                act_idx = self._act_name_to_idx.get(jname)
                if act_idx is not None:
                    self.data.ctrl[act_idx] = float(target_rad)

        for _ in range(n):
            mujoco.mj_step(self.model, self.data)
            self._step_count += 1
        return self._build_telemetry()

    def render_ego(self) -> np.ndarray:
        """Render RGB frame from the ego (head) camera.

        Returns:
            (H, W, 3) uint8 array in RGB order.
        """
        # SimCamera.render_rgb returns BGR; convert to RGB.
        bgr = self._sim_camera.render_rgb(self.data)
        return bgr[:, :, ::-1].copy()

    def render_external(
        self,
        width: int | None = None,
        height: int | None = None,
    ) -> np.ndarray:
        """Render RGB frame from the auto-tracking external/third-person camera.

        Always frames the robot's torso (`body_link`) — driven by
        `mode=mjCAMLIGHT_TARGETBODY` so the camera follows the robot as
        it rotates or moves. Useful for evidence recordings that need to
        show the robot moving from the outside.

        Returns:
            (H, W, 3) uint8 array in RGB order.
        """
        w, h = self._external_size
        w = width or w
        h = height or h
        if (
            self._external_renderer is None
            or self._external_renderer.width != w
            or self._external_renderer.height != h
        ):
            if self._external_renderer is not None:
                self._external_renderer.close()
            self._external_renderer = mujoco.Renderer(self.model, height=h, width=w)
            self._external_size = (w, h)
        self._external_renderer.update_scene(self.data, camera="external_cam")
        return self._external_renderer.render().copy()

    def get_target_position(self) -> np.ndarray:
        """Get current target object position in world frame."""
        if self._target_body_id >= 0:
            return self.data.xpos[self._target_body_id].copy()
        return self._target_position.copy()

    def get_robot_position(self) -> np.ndarray:
        """Get robot base position in world frame."""
        return self.data.xpos[self._torso_id].copy()

    def get_robot_yaw(self) -> float:
        """Get robot heading in world frame (radians).

        Extracts yaw from the torso body quaternion.
        """
        # qpos[3:7] is the freejoint quaternion (w, x, y, z)
        quat = self.data.xquat[self._torso_id]
        w, x, y, z = quat[0], quat[1], quat[2], quat[3]
        # yaw = atan2(2*(wz + xy), 1 - 2*(y^2 + z^2))
        siny_cosp = 2.0 * (w * z + x * y)
        cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
        return float(math.atan2(siny_cosp, cosy_cosp))

    def is_target_reached(self, threshold: float = 0.3) -> bool:
        """Check if robot is within threshold distance of target (XY plane)."""
        robot_xy = self.get_robot_position()[:2]
        target_xy = self.get_target_position()[:2]
        return float(np.linalg.norm(target_xy - robot_xy)) < threshold

    def distance_to_target(self) -> float:
        """Euclidean XY distance from robot to target."""
        robot_xy = self.get_robot_position()[:2]
        target_xy = self.get_target_position()[:2]
        return float(np.linalg.norm(target_xy - robot_xy))

    def bearing_to_target(self) -> float:
        """Signed bearing angle from robot heading to target (radians).

        Positive = target is to the left, negative = to the right.
        """
        robot_xy = self.get_robot_position()[:2]
        target_xy = self.get_target_position()[:2]
        delta = target_xy - robot_xy
        target_angle = math.atan2(delta[1], delta[0])
        yaw = self.get_robot_yaw()
        bearing = math.atan2(
            math.sin(target_angle - yaw), math.cos(target_angle - yaw)
        )
        return bearing

    @property
    def step_count(self) -> int:
        return self._step_count

    def close(self) -> None:
        """Release MuJoCo resources."""
        if self._closed:
            return
        self._closed = True
        try:
            self._sim_camera.close()
        except Exception:
            pass

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
