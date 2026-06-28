"""Tests for skeleton estimator module."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.detectors.skeleton_estimator import Skeleton, SkeletonEstimator


class TestSkeleton:
    def test_keypoint_shape(self):
        kps = np.random.randn(17, 2).astype(np.float32)
        scores = np.ones(17, dtype=np.float32)
        skel = Skeleton(
            keypoints=kps,
            scores=scores,
            bbox=np.array([10, 20, 100, 200], dtype=np.float32),
        )
        assert skel.keypoints.shape == (17, 2)
        assert skel.scores.shape == (17,)

    def test_center_computation(self):
        skel = Skeleton(
            keypoints=np.zeros((17, 2), dtype=np.float32),
            scores=np.ones(17, dtype=np.float32),
            bbox=np.array([100, 100, 200, 300], dtype=np.float32),
        )
        center = skel.center
        assert center.shape == (2,)
        np.testing.assert_allclose(center, [150.0, 200.0])

    def test_height_pixels(self):
        skel = Skeleton(
            keypoints=np.zeros((17, 2), dtype=np.float32),
            scores=np.ones(17, dtype=np.float32),
            bbox=np.array([0, 50, 100, 250], dtype=np.float32),
        )
        assert skel.height_pixels == 200.0

    def test_torso_center_with_visible_joints(self):
        kps = np.zeros((17, 2), dtype=np.float32)
        kps[5] = [100, 100]   # left shoulder
        kps[6] = [200, 100]   # right shoulder
        kps[11] = [100, 200]  # left hip
        kps[12] = [200, 200]  # right hip
        scores = np.ones(17, dtype=np.float32)
        skel = Skeleton(keypoints=kps, scores=scores, bbox=np.array([0, 0, 300, 300], dtype=np.float32))
        tc = skel.get_torso_center()
        assert tc is not None
        np.testing.assert_allclose(tc, [150.0, 150.0])

    def test_torso_center_none_with_low_scores(self):
        kps = np.zeros((17, 2), dtype=np.float32)
        scores = np.zeros(17, dtype=np.float32)  # all low
        skel = Skeleton(keypoints=kps, scores=scores, bbox=np.array([0, 0, 300, 300], dtype=np.float32))
        assert skel.get_torso_center() is None


class TestSkeletonEstimator:
    def test_empty_on_unavailable(self, sample_frame: np.ndarray):
        estimator = SkeletonEstimator()
        if not estimator.is_available:
            result = estimator.estimate(sample_frame)
            assert result == []
