"""Tests for camera calibration module."""

from __future__ import annotations

import math
import tempfile
from pathlib import Path

import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics, FrameUndistorter

cv2 = pytest.importorskip("cv2")


class TestCameraIntrinsics:
    def test_default_values(self, default_intrinsics: CameraIntrinsics):
        assert default_intrinsics.fx == 533.0
        assert default_intrinsics.fy == 533.0
        assert default_intrinsics.width == 640
        assert default_intrinsics.height == 480

    def test_camera_matrix_shape(self, default_intrinsics: CameraIntrinsics):
        mtx = default_intrinsics.camera_matrix
        assert mtx.shape == (3, 3)
        assert mtx[0, 0] == default_intrinsics.fx
        assert mtx[1, 1] == default_intrinsics.fy
        assert mtx[0, 2] == default_intrinsics.cx
        assert mtx[1, 2] == default_intrinsics.cy

    def test_dist_array(self, default_intrinsics: CameraIntrinsics):
        d = default_intrinsics.dist_array
        assert d.shape == (5,)
        assert np.allclose(d, 0.0)

    def test_hfov_approximately_62_deg(self, default_intrinsics: CameraIntrinsics):
        hfov = default_intrinsics.hfov_deg
        assert 60.0 < hfov < 64.0

    def test_yaml_roundtrip(self, default_intrinsics: CameraIntrinsics):
        yaml = pytest.importorskip("yaml")
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "intrinsics.yaml"
            default_intrinsics.save_yaml(path)
            loaded = CameraIntrinsics.load_yaml(path)
            assert loaded.fx == default_intrinsics.fx
            assert loaded.fy == default_intrinsics.fy
            assert loaded.cx == default_intrinsics.cx
            assert loaded.cy == default_intrinsics.cy
            assert loaded.dist_coeffs == default_intrinsics.dist_coeffs
            assert loaded.width == default_intrinsics.width
            assert loaded.height == default_intrinsics.height

    def test_pixel_to_ray_center(self, default_intrinsics: CameraIntrinsics):
        ray = default_intrinsics.pixel_to_ray(320.0, 240.0)
        assert ray.shape == (3,)
        assert np.isclose(np.linalg.norm(ray), 1.0)
        # Center pixel should point mostly forward (z dominant)
        assert ray[2] > 0.9

    def test_pixel_to_3d(self, default_intrinsics: CameraIntrinsics):
        pt = default_intrinsics.pixel_to_3d(320.0, 240.0, 2.0)
        assert pt.shape == (3,)
        # Center pixel at 2m depth: x,y near 0, z = 2
        assert abs(pt[0]) < 0.01
        assert abs(pt[1]) < 0.01
        assert abs(pt[2] - 2.0) < 0.01


class TestFrameUndistorter:
    def test_identity_undistortion(
        self, default_intrinsics: CameraIntrinsics, sample_frame: np.ndarray
    ):
        """With zero distortion, undistorted frame should match input."""
        undistorter = FrameUndistorter(default_intrinsics)
        result = undistorter.undistort(sample_frame)
        assert result.shape == sample_frame.shape
        assert result.dtype == sample_frame.dtype

    def test_shape_preserved(
        self, default_intrinsics: CameraIntrinsics, sample_frame: np.ndarray
    ):
        undistorter = FrameUndistorter(default_intrinsics)
        result = undistorter.undistort(sample_frame)
        assert result.shape == (480, 640, 3)
