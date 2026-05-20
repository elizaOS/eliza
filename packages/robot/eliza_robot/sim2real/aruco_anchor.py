"""ArUco-based sim2real anchor.

Closes the largest sim2real gap on a hobby biped (per the sim2real
research survey): the real robot's torso pose drifts from where the sim
thinks it is. We pin the sim to the real pose using fiducials.

Pipeline:

    external camera (Obsbot)
        ── reads RGB ──→
    ArucoDetector
        ── detects body marker (id 0) ──→
    CameraExtrinsics (camera→world)
        ── transforms tvec/rvec to world frame ──→
    apply to MuJoCo data.qpos[0:7] (free joint pose)
        ── env is now synced to the real robot's actual location ──

Used by the testbed during sim+real co-execution: every command goes to
both sides via DualTargetBackend; the anchor periodically resets the
sim's free joint to where the camera observes the real robot to be,
zeroing out integrated drift.

We also expose `measure_divergence(env, marker_detection) → dict` so the
training-time domain-randomization loop can score how well the current
DR distribution matches reality.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import (
    ArucoDetection,
    ArucoDetector,
)


@dataclass
class WorldFrame:
    """World-frame placement of the external camera."""

    # 3x3 rotation matrix camera→world (right-multiplied: p_world = R @ p_cam + t).
    R_world_from_cam: np.ndarray
    t_world_from_cam: np.ndarray
    note: str = ""

    @classmethod
    def identity(cls, note: str = "default-identity") -> "WorldFrame":
        return cls(
            R_world_from_cam=np.eye(3),
            t_world_from_cam=np.zeros(3),
            note=note,
        )

    @classmethod
    def from_ground_marker(
        cls, detection: ArucoDetection
    ) -> "WorldFrame":
        """Treat a single ground-plane marker as the world origin.

        For the canonical `demo_aruco.yaml` layout, ID 2 (Ground Origin)
        defines the world frame; once detected, every other observation
        is expressed relative to it.
        """
        # cv2.Rodrigues : rvec -> R(cam→marker)
        try:
            import cv2

            R_marker_from_cam, _ = cv2.Rodrigues(detection.rvec.reshape(3, 1))
        except Exception:
            R_marker_from_cam = np.eye(3)
        t_marker_from_cam = detection.tvec.reshape(3)
        # world := marker frame (per demo_aruco convention for ID 2/3/4/5)
        # So world ← cam is the inverse:
        R_world_from_cam = R_marker_from_cam.T
        t_world_from_cam = -R_world_from_cam @ t_marker_from_cam
        return cls(
            R_world_from_cam=R_world_from_cam,
            t_world_from_cam=t_world_from_cam,
            note=f"anchored to marker id={detection.marker_id}",
        )


def _camera_to_world(
    frame: WorldFrame, tvec_cam: np.ndarray
) -> np.ndarray:
    return (frame.R_world_from_cam @ tvec_cam.reshape(3)) + frame.t_world_from_cam


def detect_robot_pose(
    rgb: np.ndarray,
    intrinsics: CameraIntrinsics,
    *,
    detector: ArucoDetector | None = None,
    body_marker_id: int = 0,
    ground_origin_id: int = 2,
    marker_size_m: float = 0.05,
) -> dict | None:
    """Run ArUco on `rgb`, recover (world-frame torso pose, yaw).

    Returns None if either the world-origin marker or the robot body
    marker is missing from the frame.
    """
    detector = detector or ArucoDetector(intrinsics, marker_size_m=marker_size_m)
    detections = detector.detect(rgb)
    by_id = {int(d.marker_id): d for d in detections}
    origin = by_id.get(ground_origin_id)
    body = by_id.get(body_marker_id)
    if origin is None or body is None:
        return None
    world = WorldFrame.from_ground_marker(origin)
    body_t_world = _camera_to_world(world, body.tvec)
    # Yaw from the body marker's rotation matrix.
    try:
        import cv2

        R_body_from_cam, _ = cv2.Rodrigues(body.rvec.reshape(3, 1))
        # world->body
        R_world_from_body = world.R_world_from_cam @ R_body_from_cam
        yaw = math.atan2(R_world_from_body[1, 0], R_world_from_body[0, 0])
    except Exception:
        yaw = 0.0
    return {
        "world": world,
        "torso_world_xyz_m": body_t_world.tolist(),
        "yaw_rad": float(yaw),
        "body_detection_distance_m": float(body.distance),
        "origin_detection_distance_m": float(origin.distance),
        "marker_count": len(detections),
    }


def anchor_mujoco_env(env, pose: dict) -> None:
    """Set the DemoEnv's free-joint qpos to the measured real-world pose.

    Idempotent — safe to call every tick. Uses `mj_forward` to recompute
    derived state without integrating physics (so we don't double-step).
    """
    import mujoco

    pos = np.asarray(pose["torso_world_xyz_m"], dtype=np.float64)
    yaw = float(pose["yaw_rad"])
    half = yaw * 0.5
    w = math.cos(half)
    z = math.sin(half)
    # qpos[0:7] = (x, y, z, qw, qx, qy, qz) for the free joint
    if env.data.qpos.size < 7:
        return
    env.data.qpos[0] = float(pos[0])
    env.data.qpos[1] = float(pos[1])
    env.data.qpos[2] = float(pos[2])
    env.data.qpos[3] = w
    env.data.qpos[4] = 0.0
    env.data.qpos[5] = 0.0
    env.data.qpos[6] = z
    mujoco.mj_forward(env.model, env.data)


def measure_divergence(env, pose: dict) -> dict:
    """Return per-axis gap between sim's torso state and the measured pose."""
    import math as _math

    sim_pos = env.get_robot_position()
    sim_yaw = env.get_robot_yaw()
    real_pos = np.asarray(pose["torso_world_xyz_m"], dtype=np.float64)
    real_yaw = float(pose["yaw_rad"])
    dx = float(sim_pos[0] - real_pos[0])
    dy = float(sim_pos[1] - real_pos[1])
    dz = float(sim_pos[2] - real_pos[2])
    dyaw = _math.atan2(_math.sin(sim_yaw - real_yaw), _math.cos(sim_yaw - real_yaw))
    return {
        "dx_m": dx,
        "dy_m": dy,
        "dz_m": dz,
        "dyaw_rad": float(dyaw),
        "dyaw_deg": float(_math.degrees(dyaw)),
        "rms_xy_m": float(_math.sqrt(dx * dx + dy * dy)),
    }
