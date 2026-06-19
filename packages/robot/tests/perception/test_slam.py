"""Tests for SLAM interface and backends."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.slam.slam_interface import SLAMBackend, SLAMMap, SLAMPose


class TestSLAMPose:
    def test_default_identity(self):
        pose = SLAMPose(timestamp=0.0)
        np.testing.assert_array_equal(pose.transform, np.eye(4))
        np.testing.assert_array_equal(pose.position, [0, 0, 0])

    def test_position_extraction(self):
        T = np.eye(4, dtype=np.float64)
        T[:3, 3] = [1.0, 2.0, 3.0]
        pose = SLAMPose(timestamp=0.0, transform=T)
        np.testing.assert_array_equal(pose.position, [1.0, 2.0, 3.0])

    def test_yaw_extraction(self):
        T = np.eye(4, dtype=np.float64)
        angle = np.pi / 4
        T[0, 0] = np.cos(angle)
        T[0, 1] = -np.sin(angle)
        T[1, 0] = np.sin(angle)
        T[1, 1] = np.cos(angle)
        pose = SLAMPose(timestamp=0.0, transform=T)
        assert abs(pose.yaw - angle) < 0.01


class TestSLAMMap:
    def test_empty_map(self):
        m = SLAMMap()
        assert m.num_points == 0

    def test_within_radius(self):
        points = np.array([
            [0, 0, 0],
            [1, 0, 0],
            [5, 0, 0],
        ], dtype=np.float32)
        m = SLAMMap(points=points)
        nearby = m.within_radius(np.array([0, 0, 0]), 2.0)
        assert nearby.shape[0] == 2

    def test_within_radius_empty(self):
        m = SLAMMap()
        nearby = m.within_radius(np.array([0, 0, 0]), 1.0)
        assert nearby.shape[0] == 0


class TestSLAMBackendInterface:
    def test_is_abstract(self):
        """SLAMBackend cannot be instantiated directly."""
        with pytest.raises(TypeError):
            SLAMBackend()
