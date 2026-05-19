"""Camera extrinsic calibration using ArUco markers.

Computes the 6-DOF pose of a camera in world coordinates from
observations of ArUco markers at known world positions.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetection

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    cv2 = None  # type: ignore[assignment]
    _HAS_CV2 = False

logger = logging.getLogger(__name__)


@dataclass
class CameraExtrinsics:
    """Extrinsic calibration: rigid transform from camera frame to world frame.

    Convention:
        - R is 3x3 rotation matrix (camera -> world).
        - t is 3x1 translation = camera origin expressed in world frame.
        - A point P_world = R @ P_camera + t.
    """

    camera_id: str
    R: np.ndarray  # 3x3 rotation matrix (camera -> world)
    t: np.ndarray  # 3x1 translation (camera origin in world frame)
    timestamp: float = 0.0
    reprojection_error: float = 0.0

    def __post_init__(self) -> None:
        self.R = np.asarray(self.R, dtype=np.float64).reshape(3, 3)
        self.t = np.asarray(self.t, dtype=np.float64).reshape(3)

    @property
    def T_camera_to_world(self) -> np.ndarray:
        """4x4 homogeneous transform from camera frame to world frame."""
        T = np.eye(4, dtype=np.float64)
        T[:3, :3] = self.R
        T[:3, 3] = self.t
        return T

    @property
    def T_world_to_camera(self) -> np.ndarray:
        """4x4 inverse transform: world frame to camera frame."""
        R_inv = self.R.T
        t_inv = -R_inv @ self.t
        T = np.eye(4, dtype=np.float64)
        T[:3, :3] = R_inv
        T[:3, 3] = t_inv
        return T

    def transform_point(self, point_camera: np.ndarray) -> np.ndarray:
        """Transform a 3D point from camera frame to world frame.

        Parameters
        ----------
        point_camera : np.ndarray
            (3,) point in camera coordinates.

        Returns
        -------
        np.ndarray
            (3,) point in world coordinates.
        """
        p = np.asarray(point_camera, dtype=np.float64).ravel()[:3]
        return (self.R @ p) + self.t

    def transform_points(self, points_camera: np.ndarray) -> np.ndarray:
        """Transform an array of 3D points from camera frame to world frame.

        Parameters
        ----------
        points_camera : np.ndarray
            (N, 3) points in camera coordinates.

        Returns
        -------
        np.ndarray
            (N, 3) points in world coordinates.
        """
        pts = np.asarray(points_camera, dtype=np.float64)
        if pts.ndim == 1:
            pts = pts.reshape(1, 3)
        return (self.R @ pts.T).T + self.t

    def inverse_transform_point(self, point_world: np.ndarray) -> np.ndarray:
        """Transform a 3D point from world frame to camera frame."""
        p = np.asarray(point_world, dtype=np.float64).ravel()[:3]
        return self.R.T @ (p - self.t)

    def save_yaml(self, path: str | Path) -> None:
        """Save extrinsics to a YAML file."""
        import yaml

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "camera_id": self.camera_id,
            "R": self.R.tolist(),
            "t": self.t.tolist(),
            "timestamp": self.timestamp,
            "reprojection_error": self.reprojection_error,
        }
        with open(path, "w") as f:
            yaml.safe_dump(data, f, default_flow_style=False)

    @classmethod
    def load_yaml(cls, path: str | Path) -> CameraExtrinsics:
        """Load extrinsics from a YAML file."""
        import yaml

        with open(path) as f:
            data = yaml.safe_load(f)
        return cls(
            camera_id=data["camera_id"],
            R=np.array(data["R"], dtype=np.float64),
            t=np.array(data["t"], dtype=np.float64),
            timestamp=float(data.get("timestamp", 0.0)),
            reprojection_error=float(data.get("reprojection_error", 0.0)),
        )


class ExtrinsicCalibrator:
    """Calibrate camera extrinsics using ArUco markers with known world positions.

    Given a set of ArUco markers whose 3D positions in world frame are known,
    this class uses solvePnP on the detected marker corners to compute
    the camera's pose in world frame.
    """

    def __init__(
        self,
        marker_world_positions: dict[int, np.ndarray],
        marker_size_m: float = 0.0508,
    ) -> None:
        """
        Parameters
        ----------
        marker_world_positions : dict[int, np.ndarray]
            Maps marker_id -> [x, y, z] center position in world frame (meters).
        marker_size_m : float
            Physical marker side length in meters.
        """
        if not _HAS_CV2:
            raise RuntimeError("OpenCV required for ExtrinsicCalibrator")

        self._marker_world_positions = {
            mid: np.asarray(pos, dtype=np.float64).ravel()[:3]
            for mid, pos in marker_world_positions.items()
        }
        self._marker_size_m = marker_size_m

    def _marker_corners_world(self, marker_id: int) -> np.ndarray | None:
        """Get the 4 corner positions in world frame for a marker.

        Assumes markers are oriented with Z-axis pointing away from the
        surface they are attached to, and the marker lies in its local
        XY-plane. Without orientation information, we assume the marker
        lies in the world XY-plane (Z = marker center Z for all corners).

        Returns (4, 3) array or None if marker_id is unknown.
        """
        center = self._marker_world_positions.get(marker_id)
        if center is None:
            return None
        half = self._marker_size_m / 2.0
        # Marker corners in world XY plane, centered at the marker position
        # Order matches ArUco corner order: TL, TR, BR, BL
        return np.array(
            [
                [center[0] - half, center[1] + half, center[2]],
                [center[0] + half, center[1] + half, center[2]],
                [center[0] + half, center[1] - half, center[2]],
                [center[0] - half, center[1] - half, center[2]],
            ],
            dtype=np.float64,
        )

    def calibrate_from_detections(
        self,
        detections: list[ArucoDetection],
        intrinsics: CameraIntrinsics,
        camera_id: str = "external",
    ) -> CameraExtrinsics | None:
        """Compute camera extrinsics from detected markers with known world positions.

        Uses solvePnP with all visible marker corners that have known
        world positions.

        Parameters
        ----------
        detections : list[ArucoDetection]
            Detected ArUco markers (from ArucoDetector.detect).
        intrinsics : CameraIntrinsics
            Camera intrinsic parameters.
        camera_id : str
            Identifier for this camera.

        Returns
        -------
        CameraExtrinsics or None
            Computed extrinsics, or None if not enough markers are visible.
        """
        if not _HAS_CV2:
            return None

        # Collect world-frame 3D points and corresponding image points
        obj_points: list[np.ndarray] = []
        img_points: list[np.ndarray] = []

        for det in detections:
            world_corners = self._marker_corners_world(det.marker_id)
            if world_corners is None:
                continue
            obj_points.append(world_corners)
            img_points.append(det.corners.astype(np.float64))

        if len(obj_points) == 0:
            logger.debug("No markers with known world positions detected")
            return None

        # Stack all points
        all_obj = np.vstack(obj_points)  # (N*4, 3)
        all_img = np.vstack(img_points)  # (N*4, 2)

        camera_matrix = intrinsics.camera_matrix
        dist_coeffs = intrinsics.dist_array

        # Use solvePnP to find camera pose in world frame
        # solvePnP returns rvec, tvec such that:
        #   P_camera = R_cv @ P_world + t_cv
        # We want T_camera_to_world, so we invert.
        if len(all_obj) >= 4:
            # With 4+ points, SOLVEPNP_ITERATIVE works well
            flags = cv2.SOLVEPNP_ITERATIVE
        else:
            flags = cv2.SOLVEPNP_P3P if len(all_obj) == 3 else cv2.SOLVEPNP_ITERATIVE

        success, rvec, tvec = cv2.solvePnP(
            all_obj,
            all_img,
            camera_matrix,
            dist_coeffs,
            flags=flags,
        )

        if not success:
            logger.warning("solvePnP failed for extrinsic calibration")
            return None

        # Compute reprojection error
        projected, _ = cv2.projectPoints(
            all_obj, rvec, tvec, camera_matrix, dist_coeffs
        )
        projected = projected.reshape(-1, 2)
        reproj_error = float(np.sqrt(np.mean((projected - all_img) ** 2)))

        # Convert from solvePnP output (world-to-camera) to camera-to-world
        R_world_to_cam, _ = cv2.Rodrigues(rvec)
        # T_world_to_cam: P_cam = R_w2c @ P_world + t_w2c
        # T_cam_to_world: P_world = R_w2c^T @ P_cam - R_w2c^T @ t_w2c
        R_cam_to_world = R_world_to_cam.T
        t_cam_to_world = -R_cam_to_world @ tvec.ravel()

        return CameraExtrinsics(
            camera_id=camera_id,
            R=R_cam_to_world,
            t=t_cam_to_world,
            timestamp=time.time(),
            reprojection_error=reproj_error,
        )

    def calibrate_from_frames(
        self,
        frames: list[np.ndarray],
        intrinsics: CameraIntrinsics,
        aruco_detector: Any,
        camera_id: str = "external",
    ) -> CameraExtrinsics | None:
        """Calibrate from multiple frames, averaging the results.

        Parameters
        ----------
        frames : list[np.ndarray]
            BGR images with visible ArUco markers.
        intrinsics : CameraIntrinsics
            Camera intrinsic parameters.
        aruco_detector : ArucoDetector
            Configured ArUco detector instance.
        camera_id : str
            Identifier for this camera.

        Returns
        -------
        CameraExtrinsics or None
            Averaged extrinsics, or None if calibration failed.
        """
        all_R: list[np.ndarray] = []
        all_t: list[np.ndarray] = []
        all_err: list[float] = []

        for frame in frames:
            detections = aruco_detector.detect(frame)
            result = self.calibrate_from_detections(
                detections, intrinsics, camera_id
            )
            if result is not None:
                all_R.append(result.R)
                all_t.append(result.t)
                all_err.append(result.reprojection_error)

        if not all_R:
            return None

        # Average translations
        avg_t = np.mean(all_t, axis=0)

        # Average rotations via SVD (approximate but good for small spread)
        R_sum = np.sum(all_R, axis=0)
        U, _, Vt = np.linalg.svd(R_sum)
        avg_R = U @ Vt
        # Ensure proper rotation (det = +1)
        if np.linalg.det(avg_R) < 0:
            U[:, -1] *= -1
            avg_R = U @ Vt

        avg_err = float(np.mean(all_err))

        return CameraExtrinsics(
            camera_id=camera_id,
            R=avg_R,
            t=avg_t,
            timestamp=time.time(),
            reprojection_error=avg_err,
        )
