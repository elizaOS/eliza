"""Tests for depth estimator module."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.depth_estimator import DepthEstimator, DepthResult


class TestDepthResult:
    def test_depth_at(self, sample_depth_map: np.ndarray):
        result = DepthResult(depth_map=sample_depth_map, confidence=0.9)
        # Center of closer region
        assert result.depth_at(320, 240) == 1.0
        # Background
        assert result.depth_at(0, 0) == 2.0

    def test_point_3d_center(self, sample_depth_map: np.ndarray, default_intrinsics: CameraIntrinsics):
        result = DepthResult(depth_map=sample_depth_map, confidence=0.9)
        pt = result.point_3d(320, 240, default_intrinsics)
        assert pt.shape == (3,)
        # Center pixel: x,y ≈ 0, z = depth at that pixel
        assert abs(pt[0]) < 0.01
        assert abs(pt[1]) < 0.01

    def test_roi_depth(self, sample_depth_map: np.ndarray):
        result = DepthResult(depth_map=sample_depth_map, confidence=0.9)
        bbox = np.array([280, 200, 360, 280], dtype=np.float32)
        d = result.roi_depth(bbox)
        assert d > 0
        assert d <= 1.0  # Close region is 1.0m

    def test_roi_depth_empty(self):
        depth = np.ones((480, 640), dtype=np.float32)
        result = DepthResult(depth_map=depth, confidence=0.5)
        bbox = np.array([700, 500, 800, 600], dtype=np.float32)  # out of bounds
        d = result.roi_depth(bbox)
        assert d >= 0

    def test_output_shape_matches_input(self, sample_frame: np.ndarray):
        result = DepthResult(depth_map=np.ones((480, 640), dtype=np.float32), confidence=0.5)
        assert result.depth_map.shape == (sample_frame.shape[0], sample_frame.shape[1])

    def test_all_positive(self, sample_depth_map: np.ndarray):
        result = DepthResult(depth_map=sample_depth_map, confidence=0.9)
        assert np.all(result.depth_map > 0)


class TestDepthEstimator:
    def test_fallback_produces_valid_depth(self, sample_frame: np.ndarray):
        estimator = DepthEstimator()
        if not estimator.is_available:
            result = estimator.estimate(sample_frame)
            assert result.depth_map.shape == (480, 640)
            assert np.all(result.depth_map > 0)
            assert result.confidence < 0.5  # low confidence for fallback
