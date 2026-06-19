"""Camera calibration: intrinsics, undistortion, and calibration routine.

Supports loading/saving intrinsics as YAML, undistorting frames,
and running OpenCV checkerboard calibration.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False


@dataclass
class CameraIntrinsics:
    """Camera intrinsic parameters."""
    fx: float = 533.0
    fy: float = 533.0
    cx: float = 320.0
    cy: float = 240.0
    dist_coeffs: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0, 0.0)
    width: int = 640
    height: int = 480

    @property
    def camera_matrix(self) -> np.ndarray:
        return np.array([
            [self.fx, 0.0, self.cx],
            [0.0, self.fy, self.cy],
            [0.0, 0.0, 1.0],
        ], dtype=np.float64)

    @property
    def dist_array(self) -> np.ndarray:
        return np.array(self.dist_coeffs, dtype=np.float64)

    @property
    def hfov_deg(self) -> float:
        """Horizontal field of view in degrees."""
        return 2.0 * math.degrees(math.atan2(self.width / 2.0, self.fx))

    @property
    def vfov_deg(self) -> float:
        """Vertical field of view in degrees."""
        return 2.0 * math.degrees(math.atan2(self.height / 2.0, self.fy))

    def save_yaml(self, path: Path) -> None:
        """Save intrinsics to YAML file."""
        import yaml
        data = {
            "fx": self.fx,
            "fy": self.fy,
            "cx": self.cx,
            "cy": self.cy,
            "dist_coeffs": list(self.dist_coeffs),
            "width": self.width,
            "height": self.height,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            yaml.safe_dump(data, f, default_flow_style=False)

    @classmethod
    def load_yaml(cls, path: Path) -> CameraIntrinsics:
        """Load intrinsics from YAML file."""
        import yaml
        with open(path) as f:
            data = yaml.safe_load(f)
        return cls(
            fx=float(data["fx"]),
            fy=float(data["fy"]),
            cx=float(data["cx"]),
            cy=float(data["cy"]),
            dist_coeffs=tuple(float(x) for x in data.get("dist_coeffs", [0.0] * 5)),
            width=int(data.get("width", 640)),
            height=int(data.get("height", 480)),
        )

    def pixel_to_ray(self, u: float, v: float) -> np.ndarray:
        """Convert pixel coordinate to unit ray in camera frame."""
        x = (u - self.cx) / self.fx
        y = (v - self.cy) / self.fy
        ray = np.array([x, y, 1.0], dtype=np.float64)
        return ray / np.linalg.norm(ray)

    def pixel_to_3d(self, u: float, v: float, depth: float) -> np.ndarray:
        """Convert pixel + depth to 3D point in camera frame."""
        x = (u - self.cx) / self.fx * depth
        y = (v - self.cy) / self.fy * depth
        return np.array([x, y, depth], dtype=np.float64)


class FrameUndistorter:
    """Undistorts camera frames using precomputed maps."""

    def __init__(self, intrinsics: CameraIntrinsics) -> None:
        if not _HAS_CV2:
            raise RuntimeError("OpenCV required for FrameUndistorter")
        self._intrinsics = intrinsics
        new_mtx, _ = cv2.getOptimalNewCameraMatrix(
            intrinsics.camera_matrix,
            intrinsics.dist_array,
            (intrinsics.width, intrinsics.height),
            alpha=1.0,
        )
        self._map1, self._map2 = cv2.initUndistortRectifyMap(
            intrinsics.camera_matrix,
            intrinsics.dist_array,
            None,
            new_mtx,
            (intrinsics.width, intrinsics.height),
            cv2.CV_16SC2,
        )
        self._new_mtx = new_mtx

    def undistort(self, frame: np.ndarray) -> np.ndarray:
        """Apply undistortion to a frame."""
        return cv2.remap(frame, self._map1, self._map2, cv2.INTER_LINEAR)


class CameraCalibrator:
    """Checkerboard-based camera calibration using OpenCV."""

    def __init__(
        self,
        board_size: tuple[int, int] = (8, 6),
        square_size_mm: float = 14.3,
    ) -> None:
        if not _HAS_CV2:
            raise RuntimeError("OpenCV required for CameraCalibrator")
        self._board_size = board_size
        self._square_size = square_size_mm
        self._obj_points: list[np.ndarray] = []
        self._img_points: list[np.ndarray] = []
        self._img_shape: tuple[int, int] | None = None

        # Prepare object points grid
        self._objp = np.zeros(
            (board_size[0] * board_size[1], 3), dtype=np.float32
        )
        self._objp[:, :2] = np.mgrid[
            0 : board_size[0], 0 : board_size[1]
        ].T.reshape(-1, 2) * square_size_mm

    def add_image(self, image: np.ndarray) -> bool:
        """Add a calibration image. Returns True if corners were found."""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        self._img_shape = gray.shape[::-1]  # (w, h)
        found, corners = cv2.findChessboardCorners(gray, self._board_size, None)
        if found:
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
            corners_refined = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)
            self._obj_points.append(self._objp)
            self._img_points.append(corners_refined)
        return found

    def calibrate(self) -> tuple[CameraIntrinsics, float]:
        """Run calibration. Returns (intrinsics, reprojection_error)."""
        if not self._obj_points:
            raise ValueError("No calibration images with detected corners")
        if self._img_shape is None:
            raise ValueError("No images processed")

        ret, mtx, dist, rvecs, tvecs = cv2.calibrateCamera(
            self._obj_points, self._img_points, self._img_shape, None, None
        )
        w, h = self._img_shape
        intrinsics = CameraIntrinsics(
            fx=float(mtx[0, 0]),
            fy=float(mtx[1, 1]),
            cx=float(mtx[0, 2]),
            cy=float(mtx[1, 2]),
            dist_coeffs=tuple(float(x) for x in dist[0, :5]),
            width=w,
            height=h,
        )
        return intrinsics, float(ret)

    @property
    def num_images(self) -> int:
        return len(self._obj_points)
