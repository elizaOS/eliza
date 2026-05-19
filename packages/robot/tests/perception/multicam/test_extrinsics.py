"""Tests for camera extrinsic calibration."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics


class TestCameraExtrinsics:
    def test_identity_transform(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.zeros(3),
        )
        p_cam = np.array([1.0, 2.0, 3.0])
        p_world = ext.transform_point(p_cam)
        np.testing.assert_allclose(p_world, p_cam)

    def test_translation_only(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.array([10.0, 0.0, 0.0]),
        )
        p_cam = np.array([1.0, 0.0, 0.0])
        p_world = ext.transform_point(p_cam)
        np.testing.assert_allclose(p_world, [11.0, 0.0, 0.0])

    def test_rotation_90_z(self):
        """90 degree rotation around Z axis."""
        R = np.array([
            [0, -1, 0],
            [1, 0, 0],
            [0, 0, 1],
        ], dtype=np.float64)
        ext = CameraExtrinsics(camera_id="test", R=R, t=np.zeros(3))
        p_cam = np.array([1.0, 0.0, 0.0])
        p_world = ext.transform_point(p_cam)
        np.testing.assert_allclose(p_world, [0.0, 1.0, 0.0], atol=1e-10)

    def test_roundtrip_transform(self):
        """Transform to world and back should return original point."""
        # Use exact rotation (30 degrees around Z)
        c, s = np.cos(np.pi / 6), np.sin(np.pi / 6)
        R = np.array([
            [c, -s, 0],
            [s, c, 0],
            [0, 0, 1],
        ], dtype=np.float64)
        t = np.array([1.0, 2.0, 3.0])
        ext = CameraExtrinsics(camera_id="test", R=R, t=t)

        p_cam = np.array([0.5, -1.2, 0.7])
        p_world = ext.transform_point(p_cam)
        p_back = ext.inverse_transform_point(p_world)
        np.testing.assert_allclose(p_back, p_cam, atol=1e-10)

    def test_T_matrices_inverse(self):
        c, s = np.cos(np.pi / 6), np.sin(np.pi / 6)
        R = np.array([
            [c, -s, 0],
            [s, c, 0],
            [0, 0, 1],
        ], dtype=np.float64)
        t = np.array([1.0, 2.0, 3.0])
        ext = CameraExtrinsics(camera_id="test", R=R, t=t)

        T_c2w = ext.T_camera_to_world
        T_w2c = ext.T_world_to_camera
        product = T_c2w @ T_w2c
        np.testing.assert_allclose(product, np.eye(4), atol=1e-10)

    def test_transform_points_batch(self):
        ext = CameraExtrinsics(
            camera_id="test",
            R=np.eye(3),
            t=np.array([1.0, 2.0, 3.0]),
        )
        pts = np.array([
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
        ])
        result = ext.transform_points(pts)
        expected = np.array([
            [1.0, 2.0, 3.0],
            [2.0, 3.0, 4.0],
        ])
        np.testing.assert_allclose(result, expected)

    def test_save_load_yaml(self, tmp_path):
        c, s = np.cos(np.pi / 6), np.sin(np.pi / 6)
        R = np.array([
            [c, -s, 0],
            [s, c, 0],
            [0, 0, 1],
        ], dtype=np.float64)
        t = np.array([1.0, 2.0, 3.0])
        ext = CameraExtrinsics(
            camera_id="room_cam",
            R=R, t=t,
            timestamp=12345.0,
            reprojection_error=0.42,
        )
        path = tmp_path / "extrinsics.yaml"
        ext.save_yaml(path)

        loaded = CameraExtrinsics.load_yaml(path)
        assert loaded.camera_id == "room_cam"
        np.testing.assert_allclose(loaded.R, R, atol=1e-10)
        np.testing.assert_allclose(loaded.t, t, atol=1e-10)
        assert abs(loaded.reprojection_error - 0.42) < 1e-10
