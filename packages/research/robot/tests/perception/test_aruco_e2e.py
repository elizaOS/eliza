"""End-to-end ArUco detection test using synthetically rendered markers.

No physical camera needed — renders ArUco markers into synthetic images
and verifies the full pipeline: detect → calibrate → transform → entity.
"""
import numpy as np
import pytest
import cv2

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.aruco_detector import ArucoDetector, ArucoDetection
from eliza_robot.perception.multicam.extrinsics import ExtrinsicCalibrator, CameraExtrinsics


def _render_marker_in_image(
    width: int,
    height: int,
    marker_id: int,
    marker_px: int = 150,
    center_x: int | None = None,
    center_y: int | None = None,
) -> np.ndarray:
    """Paste an ArUco marker into a synthetic image at a given pixel position.

    Uses direct pixel placement (no perspective warp) to guarantee the marker
    is detectable. The 3D pose estimation from solvePnP still works because
    the marker is fronto-parallel.
    """
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_250)
    marker_img = np.zeros((marker_px, marker_px), dtype=np.uint8)
    cv2.aruco.generateImageMarker(dictionary, marker_id, marker_px, marker_img, 1)

    frame = np.ones((height, width), dtype=np.uint8) * 200
    cx = center_x if center_x is not None else width // 2
    cy = center_y if center_y is not None else height // 2
    x0 = max(0, cx - marker_px // 2)
    y0 = max(0, cy - marker_px // 2)
    x1 = min(width, x0 + marker_px)
    y1 = min(height, y0 + marker_px)
    mx0 = x0 - (cx - marker_px // 2)
    my0 = y0 - (cy - marker_px // 2)
    frame[y0:y1, x0:x1] = marker_img[my0:my0 + (y1 - y0), mx0:mx0 + (x1 - x0)]

    return cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)


class TestArucoEndToEnd:
    """End-to-end tests for ArUco detection + pose estimation."""

    def test_detect_single_marker(self):
        """Render marker #6, verify detection and pose estimation."""
        intrinsics = CameraIntrinsics(width=640, height=480, fx=500, fy=500, cx=320, cy=240)
        detector = ArucoDetector(intrinsics, marker_size_m=0.05)

        frame = _render_marker_in_image(640, 480, marker_id=6, marker_px=150)
        detections = detector.detect(frame)

        assert len(detections) >= 1, f"Expected >=1, got {len(detections)}"
        det = next(d for d in detections if d.marker_id == 6)
        assert det.marker_id == 6
        assert det.confidence > 0
        assert det.distance > 0
        assert det.corners.shape == (4, 2)
        assert det.rvec.shape == (3,)
        assert det.tvec.shape == (3,)

    def test_detect_multiple_markers(self):
        """Render markers #2 and #6 side by side."""
        intrinsics = CameraIntrinsics(width=640, height=480, fx=500, fy=500, cx=320, cy=240)
        detector = ArucoDetector(intrinsics, marker_size_m=0.05)

        frame1 = _render_marker_in_image(640, 480, marker_id=2, marker_px=120, center_x=200)
        frame2 = _render_marker_in_image(640, 480, marker_id=6, marker_px=120, center_x=440)
        frame = np.minimum(frame1, frame2)  # darker wins (markers are black on white)

        detections = detector.detect(frame)
        ids = {d.marker_id for d in detections}
        assert 2 in ids and 6 in ids, f"Expected markers 2 and 6, got {ids}"

    def test_extrinsic_calibration_from_rendered_markers(self):
        """Render ground marker, calibrate camera, verify extrinsics."""
        intrinsics = CameraIntrinsics(width=640, height=480, fx=500, fy=500, cx=320, cy=240)
        detector = ArucoDetector(intrinsics, marker_size_m=0.05)

        frame = _render_marker_in_image(640, 480, marker_id=2, marker_px=150)
        detections = detector.detect(frame)

        if not detections:
            pytest.skip("Marker not detected")

        calibrator = ExtrinsicCalibrator(
            marker_world_positions={2: np.array([0.0, 0.0, 0.0])},
            marker_size_m=0.05,
        )
        ext = calibrator.calibrate_from_detections(detections, intrinsics, "test")

        assert ext is not None, "Calibration failed"
        assert ext.camera_id == "test"
        assert ext.R.shape == (3, 3)
        assert ext.t.shape == (3,)
        assert ext.reprojection_error < 5.0

    def test_full_pipeline_detect_to_entity(self):
        """Full chain: render marker → detect → WorldState entity."""
        from eliza_robot.perception.world_model.world_state import WorldState

        intrinsics = CameraIntrinsics(width=640, height=480, fx=500, fy=500, cx=320, cy=240)
        detector = ArucoDetector(intrinsics, marker_size_m=0.05)

        frame = _render_marker_in_image(640, 480, marker_id=6, marker_px=150)
        detections = detector.detect(frame)

        if not detections:
            pytest.skip("Marker not detected")

        ws = WorldState(intrinsics=intrinsics, stale_timeout_sec=5.0)
        ws.update_from_aruco(
            detections,
            object_markers={6: "red_ball"},
            robot_marker_ids=[0],
            robot_head_marker_id=1,
        )

        entities = ws.entity_list
        assert len(entities) == 1
        assert entities[0].label == "red_ball"
        assert entities[0].marker_id == 6
        assert entities[0].source == "aruco"
        # Entity should have a non-zero position
        assert np.linalg.norm(entities[0].position) > 0
