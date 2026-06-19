"""Tests for DualCameraSource and FusedWorldState."""
import time
import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics, ExtrinsicCalibrator


class TestCameraExtrinsics:
    def test_identity_transform(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.zeros(3),
        )
        point = np.array([1.0, 2.0, 3.0])
        result = ext.transform_point(point)
        np.testing.assert_allclose(result, point)

    def test_translation_only(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.array([10.0, 0.0, 0.0]),
        )
        point = np.array([1.0, 0.0, 0.0])
        result = ext.transform_point(point)
        np.testing.assert_allclose(result, [11.0, 0.0, 0.0])

    def test_inverse_transform(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.array([5.0, 3.0, 1.0]),
        )
        world_point = np.array([10.0, 3.0, 1.0])
        camera_point = ext.inverse_transform_point(world_point)
        np.testing.assert_allclose(camera_point, [5.0, 0.0, 0.0])

    def test_batch_transform(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.array([1.0, 2.0, 3.0]),
        )
        points = np.array([[0, 0, 0], [1, 1, 1]], dtype=np.float64)
        result = ext.transform_points(points)
        assert result.shape == (2, 3)
        np.testing.assert_allclose(result[0], [1, 2, 3])
        np.testing.assert_allclose(result[1], [2, 3, 4])

    def test_homogeneous_matrices(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.array([1, 2, 3]),
        )
        T = ext.T_camera_to_world
        assert T.shape == (4, 4)
        np.testing.assert_allclose(T[:3, 3], [1, 2, 3])

        T_inv = ext.T_world_to_camera
        # T @ T_inv should be identity
        np.testing.assert_allclose(T @ T_inv, np.eye(4), atol=1e-10)


class TestExtrinsicCalibrator:
    def test_init(self):
        cal = ExtrinsicCalibrator(
            marker_world_positions={
                0: np.array([0, 0, 0]),
                1: np.array([1, 0, 0]),
            },
            marker_size_m=0.05,
        )
        assert cal._marker_size_m == 0.05

    def test_calibrate_no_detections(self):
        cal = ExtrinsicCalibrator(
            marker_world_positions={0: np.array([0, 0, 0])},
        )
        result = cal.calibrate_from_detections(
            [], CameraIntrinsics(), "test"
        )
        assert result is None

    def test_marker_corners_world(self):
        cal = ExtrinsicCalibrator(
            marker_world_positions={5: np.array([1.0, 2.0, 0.0])},
            marker_size_m=0.1,
        )
        corners = cal._marker_corners_world(5)
        assert corners is not None
        assert corners.shape == (4, 3)
        # All corners should be at z=0
        np.testing.assert_allclose(corners[:, 2], 0.0)
        # Center should be at (1.0, 2.0, 0.0)
        center = corners.mean(axis=0)
        np.testing.assert_allclose(center, [1.0, 2.0, 0.0])

    def test_unknown_marker_returns_none(self):
        cal = ExtrinsicCalibrator(
            marker_world_positions={0: np.array([0, 0, 0])},
        )
        assert cal._marker_corners_world(99) is None


class TestDualCameraSource:
    def test_synced_frame_properties(self):
        from eliza_robot.perception.multicam.dual_camera import SyncedFrame

        frame = SyncedFrame(
            ego_frame=np.zeros((480, 640, 3), dtype=np.uint8),
            external_frame=np.zeros((720, 1280, 3), dtype=np.uint8),
            timestamp=time.time(),
            ego_timestamp=time.time(),
            external_timestamp=time.time() + 0.01,
        )
        assert frame.has_ego
        assert frame.has_external
        assert frame.has_both
        assert frame.time_diff_ms is not None
        assert frame.time_diff_ms < 20  # 10ms diff

    def test_synced_frame_missing_external(self):
        from eliza_robot.perception.multicam.dual_camera import SyncedFrame

        frame = SyncedFrame(
            ego_frame=np.zeros((480, 640, 3), dtype=np.uint8),
            external_frame=None,
            timestamp=time.time(),
            ego_timestamp=time.time(),
            external_timestamp=None,
        )
        assert frame.has_ego
        assert not frame.has_external
        assert not frame.has_both
        assert frame.time_diff_ms is None
