"""Runtime calibration for the tracking visualizer.

Handles floor-marker extrinsic calibration, robot body marker offset,
and camera intrinsic calibration with save/load persistence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from eliza_robot.perception.calibration import CameraCalibrator, CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetection, ArucoDetector
from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics, ExtrinsicCalibrator

logger = logging.getLogger(__name__)

try:
    import yaml

    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False


# ------------------------------------------------------------------
# Robot marker offset
# ------------------------------------------------------------------

@dataclass
class RobotMarkerOffset:
    """Offset from body ArUco marker to robot center (robot-local frame).

    Convention (robot local frame):
        X = forward, Y = left, Z = up

    The body marker sits on the back-right shoulder, so a positive X
    pushes the centre estimate forward and a positive Y pushes it left.
    """

    x: float = 0.05
    y: float = 0.04
    z: float = 0.0
    heading_offset_deg: float = 0.0

    @property
    def vector(self) -> np.ndarray:
        return np.array([self.x, self.y, self.z], dtype=np.float64)

    def apply(
        self,
        marker_position: np.ndarray,
        marker_rotation: np.ndarray,
    ) -> np.ndarray:
        """Transform marker world-position to estimated robot centre."""
        world_offset = marker_rotation @ self.vector
        return np.asarray(marker_position, dtype=np.float64) + world_offset


# ------------------------------------------------------------------
# Calibration state
# ------------------------------------------------------------------

@dataclass
class CalibrationState:
    is_active: bool = False
    mode: str = "idle"  # idle | floor | intrinsic
    captured_frames: int = 0
    message: str = ""
    extrinsics: CameraExtrinsics | None = None
    intrinsics: CameraIntrinsics | None = None
    reprojection_error: float = 0.0


# ------------------------------------------------------------------
# RuntimeCalibrator
# ------------------------------------------------------------------

class RuntimeCalibrator:
    """Manages calibration state, persistence, and robot offset."""

    def __init__(
        self,
        world_markers: dict[int, list[float]],
        marker_size_m: float = 0.0508,
        save_dir: Path | None = None,
    ) -> None:
        self._world_markers = {
            mid: np.array(pos, dtype=np.float64)
            for mid, pos in world_markers.items()
        }
        self._marker_size_m = marker_size_m
        self._save_dir = save_dir or Path("calibration_data")
        self._save_dir.mkdir(parents=True, exist_ok=True)

        self._state = CalibrationState()
        self._ext_calibrator = ExtrinsicCalibrator(
            marker_world_positions=self._world_markers,
            marker_size_m=marker_size_m,
        )
        self._int_calibrator: CameraCalibrator | None = None
        self._collected_frames: list[np.ndarray] = []
        self._robot_offset = RobotMarkerOffset()

        self._load_saved()

    # -- properties --

    @property
    def state(self) -> CalibrationState:
        return self._state

    @property
    def robot_offset(self) -> RobotMarkerOffset:
        return self._robot_offset

    def set_robot_offset(self, x: float, y: float, z: float, heading_offset_deg: float = 0.0) -> None:
        self._robot_offset = RobotMarkerOffset(x=x, y=y, z=z, heading_offset_deg=heading_offset_deg)
        self._save_robot_offset()

    # -- floor (extrinsic) calibration --

    def start_floor_calibration(self) -> str:
        self._state = CalibrationState(
            is_active=True,
            mode="floor",
            message="Point USB camera at floor markers. Press Capture for each view.",
        )
        self._collected_frames = []
        return self._state.message

    def capture_frame(self, frame: np.ndarray) -> str:
        if not self._state.is_active:
            return "No calibration in progress"
        self._collected_frames.append(frame.copy())
        self._state.captured_frames = len(self._collected_frames)
        self._state.message = (
            f"Captured {self._state.captured_frames} frame(s). Need >= 1."
        )
        return self._state.message

    def finish_floor_calibration(
        self,
        intrinsics: CameraIntrinsics,
        aruco_detector: ArucoDetector,
        camera_id: str = "external",
    ) -> tuple[CameraExtrinsics | None, str]:
        if not self._collected_frames:
            msg = "No frames captured"
            self._state.message = msg
            return None, msg

        result = self._ext_calibrator.calibrate_from_frames(
            frames=self._collected_frames,
            intrinsics=intrinsics,
            aruco_detector=aruco_detector,
            camera_id=camera_id,
        )
        if result is None:
            msg = "Calibration failed -- not enough floor markers detected"
            self._state = CalibrationState(message=msg)
            return None, msg

        self._state.extrinsics = result
        self._state.reprojection_error = result.reprojection_error
        self._state.is_active = False
        self._state.mode = "idle"
        msg = f"Calibration OK! Reprojection error: {result.reprojection_error:.3f}px"
        self._state.message = msg

        out = self._save_dir / f"{camera_id}_extrinsics.yaml"
        result.save_yaml(out)
        logger.info("Saved extrinsics to %s", out)

        return result, msg

    def quick_calibrate(
        self,
        detections: list[ArucoDetection],
        intrinsics: CameraIntrinsics,
        camera_id: str = "external",
    ) -> CameraExtrinsics | None:
        """Single-frame extrinsic calibration from current ArUco detections."""
        result = self._ext_calibrator.calibrate_from_detections(
            detections=detections,
            intrinsics=intrinsics,
            camera_id=camera_id,
        )
        if result is not None:
            self._state.extrinsics = result
            self._state.reprojection_error = result.reprojection_error
        return result

    # -- intrinsic calibration --

    def start_intrinsic_calibration(
        self,
        board_size: tuple[int, int] = (8, 6),
        square_size_mm: float = 14.3,
    ) -> str:
        self._int_calibrator = CameraCalibrator(
            board_size=board_size,
            square_size_mm=square_size_mm,
        )
        self._state = CalibrationState(
            is_active=True,
            mode="intrinsic",
            message="Show checkerboard. Press Capture for each pose.",
        )
        return self._state.message

    def capture_intrinsic_frame(self, frame: np.ndarray) -> str:
        if self._int_calibrator is None:
            return "No intrinsic calibration in progress"
        found = self._int_calibrator.add_image(frame)
        n = self._int_calibrator.num_images
        if found:
            msg = f"Corners found! Total: {n} frame(s)"
        else:
            msg = "No checkerboard found in this frame"
        self._state.captured_frames = n
        self._state.message = msg
        return msg

    def finish_intrinsic_calibration(
        self,
    ) -> tuple[CameraIntrinsics | None, str]:
        if (
            self._int_calibrator is None
            or self._int_calibrator.num_images < 3
        ):
            msg = "Need >= 3 frames with detected checkerboard"
            self._state.message = msg
            return None, msg

        intrinsics, error = self._int_calibrator.calibrate()
        self._state.intrinsics = intrinsics
        self._state.reprojection_error = error
        self._state.is_active = False
        self._state.mode = "idle"
        msg = (
            f"Calibrated! Error: {error:.3f}px, "
            f"fx={intrinsics.fx:.1f}, fy={intrinsics.fy:.1f}"
        )
        self._state.message = msg

        intrinsics.save_yaml(self._save_dir / "intrinsics.yaml")
        logger.info("Saved intrinsics")
        return intrinsics, msg

    # -- persistence helpers --

    def _save_robot_offset(self) -> None:
        if not _HAS_YAML:
            return
        data = {
            "x": float(self._robot_offset.x),
            "y": float(self._robot_offset.y),
            "z": float(self._robot_offset.z),
            "heading_offset_deg": float(self._robot_offset.heading_offset_deg),
        }
        with open(self._save_dir / "robot_offset.yaml", "w") as f:
            yaml.safe_dump(data, f)

    def _load_saved(self) -> None:
        ext_path = self._save_dir / "external_extrinsics.yaml"
        if ext_path.exists():
            try:
                self._state.extrinsics = CameraExtrinsics.load_yaml(ext_path)
                logger.info("Loaded saved extrinsics from %s", ext_path)
            except Exception as e:
                logger.warning("Failed to load extrinsics: %s", e)

        int_path = self._save_dir / "intrinsics.yaml"
        if int_path.exists():
            try:
                self._state.intrinsics = CameraIntrinsics.load_yaml(int_path)
                logger.info("Loaded saved intrinsics from %s", int_path)
            except Exception as e:
                logger.warning("Failed to load intrinsics: %s", e)

        offset_path = self._save_dir / "robot_offset.yaml"
        if offset_path.exists() and _HAS_YAML:
            try:
                with open(offset_path) as f:
                    data = yaml.safe_load(f)
                self._robot_offset = RobotMarkerOffset(
                    x=float(data.get("x", 0.05)),
                    y=float(data.get("y", 0.04)),
                    z=float(data.get("z", 0.0)),
                    heading_offset_deg=float(data.get("heading_offset_deg", 0.0)),
                )
                logger.info("Loaded robot offset: %s", self._robot_offset)
            except Exception as e:
                logger.warning("Failed to load robot offset: %s", e)
