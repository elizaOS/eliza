"""ArUco marker detection with 6-DOF pose estimation.

Detects ArUco markers in camera frames and estimates their 3D pose
using OpenCV's ArUco module. Used for external camera localization
and robot pose estimation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    cv2 = None  # type: ignore[assignment]
    _HAS_CV2 = False

logger = logging.getLogger(__name__)


@dataclass
class ArucoDetection:
    """A single detected ArUco marker with estimated pose."""

    marker_id: int
    corners: np.ndarray  # 4x2 pixel corners (float32)
    rvec: np.ndarray  # 3x1 rotation vector (Rodrigues)
    tvec: np.ndarray  # 3x1 translation vector in camera frame (meters)
    confidence: float  # detection confidence [0, 1]

    @property
    def center_pixel(self) -> np.ndarray:
        """Mean pixel position of the four corners."""
        return self.corners.mean(axis=0)

    @property
    def distance(self) -> float:
        """Distance from camera to marker in meters."""
        return float(np.linalg.norm(self.tvec))

    @property
    def rotation_matrix(self) -> np.ndarray:
        """3x3 rotation matrix from Rodrigues vector."""
        if not _HAS_CV2:
            raise RuntimeError("OpenCV required for rotation_matrix")
        R, _ = cv2.Rodrigues(self.rvec)
        return R


class ArucoDetector:
    """Detects ArUco markers and estimates their 6-DOF pose.

    Uses cv2.aruco.detectMarkers for detection and
    cv2.aruco.estimatePoseSingleMarkers (or solvePnP fallback)
    for pose estimation.
    """

    def __init__(
        self,
        intrinsics: CameraIntrinsics,
        marker_size_m: float = 0.0508,  # 2 inches
        dictionary: int | None = None,
    ) -> None:
        if not _HAS_CV2:
            raise RuntimeError("OpenCV required for ArucoDetector")

        self._intrinsics = intrinsics
        self._marker_size_m = marker_size_m

        # Default to DICT_6X6_250 to match the marker generator
        if dictionary is None:
            dictionary = cv2.aruco.DICT_6X6_250
        self._aruco_dict = cv2.aruco.getPredefinedDictionary(dictionary)
        self._aruco_params = cv2.aruco.DetectorParameters()

        # Try to use the newer ArucoDetector API (OpenCV 4.7+)
        self._detector: Any = None
        try:
            self._detector = cv2.aruco.ArucoDetector(
                self._aruco_dict, self._aruco_params
            )
        except AttributeError:
            # Older OpenCV, fall back to function-based API
            self._detector = None

        # Precompute marker object points (square in marker-local frame)
        half = marker_size_m / 2.0
        self._marker_obj_points = np.array(
            [
                [-half, half, 0.0],
                [half, half, 0.0],
                [half, -half, 0.0],
                [-half, -half, 0.0],
            ],
            dtype=np.float32,
        )

    @property
    def marker_size_m(self) -> float:
        return self._marker_size_m

    @property
    def intrinsics(self) -> CameraIntrinsics:
        return self._intrinsics

    def detect(self, frame: np.ndarray) -> list[ArucoDetection]:
        """Detect ArUco markers and estimate their 6-DOF poses.

        Parameters
        ----------
        frame : np.ndarray
            BGR or grayscale image.

        Returns
        -------
        list[ArucoDetection]
            Detected markers with pose estimates, sorted by marker_id.
        """
        if not _HAS_CV2:
            return []

        # Convert to grayscale if needed
        if len(frame.shape) == 3 and frame.shape[2] == 3:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        else:
            gray = frame

        # Detect markers
        if self._detector is not None:
            corners_list, ids, rejected = self._detector.detectMarkers(gray)
        else:
            corners_list, ids, rejected = cv2.aruco.detectMarkers(
                gray, self._aruco_dict, parameters=self._aruco_params
            )

        if ids is None or len(ids) == 0:
            return []

        camera_matrix = self._intrinsics.camera_matrix
        dist_coeffs = self._intrinsics.dist_array

        detections: list[ArucoDetection] = []
        for i, marker_id_arr in enumerate(ids):
            marker_id = int(marker_id_arr[0]) if marker_id_arr.ndim > 0 else int(marker_id_arr)
            marker_corners = corners_list[i].reshape(4, 2)

            # Estimate pose using solvePnP (more reliable than deprecated
            # estimatePoseSingleMarkers in newer OpenCV)
            success, rvec, tvec = cv2.solvePnP(
                self._marker_obj_points,
                marker_corners.astype(np.float64),
                camera_matrix,
                dist_coeffs,
                flags=cv2.SOLVEPNP_IPPE_SQUARE,
            )
            if not success:
                # Fallback to iterative
                success, rvec, tvec = cv2.solvePnP(
                    self._marker_obj_points,
                    marker_corners.astype(np.float64),
                    camera_matrix,
                    dist_coeffs,
                    flags=cv2.SOLVEPNP_ITERATIVE,
                )
            if not success:
                logger.debug("solvePnP failed for marker %d", marker_id)
                continue

            rvec = rvec.reshape(3)
            tvec = tvec.reshape(3)

            # Confidence based on marker area (larger = closer = more confident)
            # and the quality of the corner detection
            area = cv2.contourArea(marker_corners.astype(np.float32))
            # Normalize: 100 px^2 -> 0.5 confidence, 10000 px^2 -> ~1.0
            confidence = float(np.clip(area / 10000.0, 0.1, 1.0))

            detections.append(
                ArucoDetection(
                    marker_id=marker_id,
                    corners=marker_corners.astype(np.float32),
                    rvec=rvec.astype(np.float64),
                    tvec=tvec.astype(np.float64),
                    confidence=confidence,
                )
            )

        # Sort by marker_id for deterministic ordering
        detections.sort(key=lambda d: d.marker_id)
        return detections

    def draw_detections(
        self,
        frame: np.ndarray,
        detections: list[ArucoDetection],
        axis_length: float | None = None,
    ) -> np.ndarray:
        """Draw detected markers and coordinate axes on frame for debugging.

        Parameters
        ----------
        frame : np.ndarray
            BGR image to draw on (will be copied).
        detections : list[ArucoDetection]
            Detected markers to visualize.
        axis_length : float, optional
            Length of drawn axes in meters. Defaults to marker_size_m.

        Returns
        -------
        np.ndarray
            Annotated BGR image.
        """
        if not _HAS_CV2:
            return frame.copy()

        vis = frame.copy()
        if axis_length is None:
            axis_length = self._marker_size_m

        camera_matrix = self._intrinsics.camera_matrix
        dist_coeffs = self._intrinsics.dist_array

        for det in detections:
            # Draw marker outline
            corners_int = det.corners.astype(np.int32).reshape((-1, 1, 2))
            cv2.polylines(vis, [corners_int], True, (0, 255, 0), 2)

            # Draw coordinate axes
            cv2.drawFrameAxes(
                vis,
                camera_matrix,
                dist_coeffs,
                det.rvec.reshape(3, 1),
                det.tvec.reshape(3, 1),
                axis_length,
            )

            # Draw marker ID and distance
            center = det.center_pixel.astype(int)
            label = f"ID:{det.marker_id} d:{det.distance:.2f}m"
            cv2.putText(
                vis,
                label,
                (center[0] - 40, center[1] - 15),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 255, 255),
                1,
                cv2.LINE_AA,
            )

        return vis
