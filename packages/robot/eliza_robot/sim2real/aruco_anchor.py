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


# ----------------------------------------------------------------------
# Fused anchor: joints (StateMirror) + free-joint torso pose (ArUco)
# ----------------------------------------------------------------------


@dataclass
class FusedAnchorStats:
    """Per-tick fused sim2real divergence record.

    Fields:
        joint_rms_mrad / joint_n — joint divergence the StateMirror is
            closing each tick (real_pos - sim_pos, RMS in milliradians).
        torso_dx_m..torso_dyaw_deg — residual torso gap *after* anchoring
            (typically PnP / quantization noise).
        torso_pre_dxy_m / torso_pre_dyaw_deg — torso gap *before* anchoring
            (the drift the ArUco anchor zeroed out this tick).
        aruco_ids_seen — every marker ID detected in the last frame.
        aruco_pose_locked — True iff both body + origin markers were
            detected (so the anchor ran successfully).
    """

    t_s: float
    joint_rms_mrad: float
    joint_n: int
    torso_dx_m: float
    torso_dy_m: float
    torso_dz_m: float
    torso_dxy_m: float
    torso_dyaw_deg: float
    torso_pre_dxy_m: float
    torso_pre_dyaw_deg: float
    aruco_ids_seen: list[int]
    aruco_pose_locked: bool

    def to_json(self) -> dict:
        return {
            "t_s": round(self.t_s, 3),
            "joint_rms_mrad": round(self.joint_rms_mrad, 3),
            "joint_n": self.joint_n,
            "torso_dx_m": round(self.torso_dx_m, 4),
            "torso_dy_m": round(self.torso_dy_m, 4),
            "torso_dz_m": round(self.torso_dz_m, 4),
            "torso_dxy_m": round(self.torso_dxy_m, 4),
            "torso_dyaw_deg": round(self.torso_dyaw_deg, 3),
            "torso_pre_dxy_m": round(self.torso_pre_dxy_m, 4),
            "torso_pre_dyaw_deg": round(self.torso_pre_dyaw_deg, 3),
            "aruco_ids_seen": list(self.aruco_ids_seen),
            "aruco_pose_locked": self.aruco_pose_locked,
        }


class FusedSim2RealAnchor:
    """Pins the sim's whole-body state to what's measurable on the real robot.

    Composes two existing primitives — does NOT reimplement them:

    1. **Joints** — `StateMirrorBackend` reads `real.read_joint_positions()`
       and force-writes them into `env.data.qpos[act_qpos_idx]`. That
       backend stays opaque here; we just observe its `stats` and re-read
       sim qpos for divergence reporting.

    2. **Free-joint torso pose** — `detect_robot_pose()` on each Obsbot
       frame; on success, `anchor_mujoco_env()` writes
       `env.data.qpos[0:7]` (xyz + quat).

    The two anchors touch disjoint slices of `qpos` (StateMirror writes
    joint slots from `_act_qpos_idx`; ArUco writes `qpos[0:7]`), so they
    compose cleanly under a single `mj_forward`.

    This class is the orchestrator — it owns the ArUco detector + the
    intrinsics + the per-tick anchor call and divergence record. It does
    NOT own the StateMirror backend (caller wires that). It is safe to
    drive on a sim-only loop (no real backend) for synthetic-marker
    validation, in which case `pose_source` returns frames composited
    from the sim's external render and `joint_rms_mrad` is reported as
    zero.
    """

    def __init__(
        self,
        env,
        intrinsics: CameraIntrinsics,
        *,
        detector: ArucoDetector | None = None,
        body_marker_id: int = 0,
        ground_origin_id: int = 2,
        marker_size_m: float = 0.0508,
    ) -> None:
        self._env = env
        self._intrinsics = intrinsics
        self._detector = detector or ArucoDetector(
            intrinsics, marker_size_m=marker_size_m
        )
        self._body_marker_id = int(body_marker_id)
        self._ground_origin_id = int(ground_origin_id)
        self._last_pose: dict | None = None
        self._last_anchor_t: float = 0.0
        self._pre_anchor_pos: np.ndarray = np.zeros(3, dtype=np.float64)
        self._pre_anchor_yaw: float = 0.0

    @property
    def detector(self) -> ArucoDetector:
        return self._detector

    @property
    def last_pose(self) -> dict | None:
        return self._last_pose

    def anchor_from_frame(self, rgb: np.ndarray) -> dict | None:
        """Detect markers in `rgb`, anchor sim torso if both IDs present.

        Returns the pose dict on success (sim was updated), None if the
        required markers weren't both visible (sim left alone).

        Side effect: stores the **pre-anchor** sim torso pose on
        `self._pre_anchor_pos` / `self._pre_anchor_yaw` so callers can
        report how much drift the anchor just zeroed out.
        """
        # Snapshot sim's belief BEFORE we overwrite qpos[0:7].
        self._pre_anchor_pos = self._env.get_robot_position().copy()
        self._pre_anchor_yaw = float(self._env.get_robot_yaw())
        pose = detect_robot_pose(
            rgb,
            self._intrinsics,
            detector=self._detector,
            body_marker_id=self._body_marker_id,
            ground_origin_id=self._ground_origin_id,
        )
        if pose is not None:
            anchor_mujoco_env(self._env, pose)
            self._last_pose = pose
        return pose

    def divergence(
        self,
        t_s: float,
        *,
        real_joint_positions: dict[str, float] | None = None,
        aruco_ids_seen: list[int] | None = None,
    ) -> FusedAnchorStats:
        """Compute per-tick fused divergence — joints + torso pose.

        - `real_joint_positions`: most-recent dict from
          `real.read_joint_positions()`. None for sim-only mode.
        - `aruco_ids_seen`: marker IDs detected in the last frame
          (informational; doesn't change the torso math).
        """
        # Joint divergence: compare real reading against current sim qpos.
        joint_rms_mrad = 0.0
        joint_n = 0
        if real_joint_positions:
            act_name_to_idx = getattr(self._env, "_act_name_to_idx", None)
            act_qpos_idx = getattr(self._env, "_act_qpos_idx", None)
            if act_name_to_idx is not None and act_qpos_idx is not None:
                diffs: list[float] = []
                for name, val in real_joint_positions.items():
                    act_idx = act_name_to_idx.get(name)
                    if act_idx is None:
                        continue
                    qpos_idx = act_qpos_idx[act_idx]
                    sim_val = float(self._env.data.qpos[qpos_idx])
                    diffs.append(float(val) - sim_val)
                if diffs:
                    joint_n = len(diffs)
                    joint_rms_mrad = float(
                        math.sqrt(sum(d * d for d in diffs) / len(diffs))
                        * 1000.0
                    )

        # Torso divergence: sim's torso vs the last successful ArUco pose.
        # The anchor runs BEFORE divergence is computed, so this measures
        # residual gap from anchoring (typically encoder/PnP noise + any
        # accumulation since the last successful detection).
        torso_dx = torso_dy = torso_dz = torso_dxy = torso_dyaw_deg = 0.0
        torso_pre_dxy = torso_pre_dyaw_deg = 0.0
        pose_locked = self._last_pose is not None
        if pose_locked:
            div = measure_divergence(self._env, self._last_pose)
            torso_dx = div["dx_m"]
            torso_dy = div["dy_m"]
            torso_dz = div["dz_m"]
            torso_dxy = div["rms_xy_m"]
            torso_dyaw_deg = div["dyaw_deg"]
            # Pre-anchor gap: what the drift would have looked like had
            # we *not* written the ArUco-derived pose this tick.
            real_pos = np.asarray(
                self._last_pose["torso_world_xyz_m"], dtype=np.float64
            )
            real_yaw = float(self._last_pose["yaw_rad"])
            pre_dx = float(self._pre_anchor_pos[0] - real_pos[0])
            pre_dy = float(self._pre_anchor_pos[1] - real_pos[1])
            torso_pre_dxy = float(math.sqrt(pre_dx * pre_dx + pre_dy * pre_dy))
            dyaw = math.atan2(
                math.sin(self._pre_anchor_yaw - real_yaw),
                math.cos(self._pre_anchor_yaw - real_yaw),
            )
            torso_pre_dyaw_deg = float(math.degrees(dyaw))

        return FusedAnchorStats(
            t_s=float(t_s),
            joint_rms_mrad=joint_rms_mrad,
            joint_n=joint_n,
            torso_dx_m=torso_dx,
            torso_dy_m=torso_dy,
            torso_dz_m=torso_dz,
            torso_dxy_m=torso_dxy,
            torso_dyaw_deg=torso_dyaw_deg,
            torso_pre_dxy_m=torso_pre_dxy,
            torso_pre_dyaw_deg=torso_pre_dyaw_deg,
            aruco_ids_seen=list(aruco_ids_seen or []),
            aruco_pose_locked=pose_locked,
        )
