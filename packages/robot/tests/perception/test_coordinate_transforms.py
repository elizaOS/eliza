"""Tests for coordinate transforms — camera-to-robot, head pose, depth positioning."""

from __future__ import annotations

import math

import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.world_model.world_state import WorldState


class TestCameraToRobotTransform:
    """Verify the camera->robot axis conversion is correct.

    Camera frame: X-right, Y-down, Z-forward
    Robot frame:  X-forward, Y-left, Z-up
    """

    def setup_method(self):
        self.ws = WorldState()
        self.ws.set_head_pose(0.0, 0.0)

    def test_forward_maps_to_robot_x(self):
        """Camera Z (forward) -> Robot X (forward)."""
        pt = self.ws.camera_to_robot(np.array([0, 0, 1]))
        assert pt[0] > 0.9   # x ≈ 1 (plus offset)
        assert abs(pt[1]) < 0.1  # y ≈ 0
        assert abs(pt[2] - 0.3) < 0.1  # z ≈ head height

    def test_right_maps_to_negative_robot_y(self):
        """Camera X (right) -> Robot -Y (right in robot frame)."""
        pt = self.ws.camera_to_robot(np.array([1, 0, 0]))
        assert abs(pt[0] - 0.03) < 0.1  # x ≈ offset only
        assert pt[1] < -0.9  # y ≈ -1 (right)

    def test_down_maps_to_negative_robot_z(self):
        """Camera Y (down) -> Robot -Z (down)."""
        pt = self.ws.camera_to_robot(np.array([0, 1, 0]))
        assert abs(pt[0] - 0.03) < 0.1
        assert abs(pt[1]) < 0.1
        assert pt[2] < -0.5  # z < 0 (down from head height)


class TestHeadPanTilt:
    def test_pan_90_rotates_forward_to_left(self):
        """Pan=90deg: camera forward -> robot +Y (left)."""
        ws = WorldState()
        ws.set_head_pose(math.pi / 2, 0.0)
        pt = ws.camera_to_robot(np.array([0, 0, 1]))
        assert abs(pt[0] - 0.03) < 0.2  # x ≈ offset
        assert pt[1] > 0.8  # y ≈ 1 (left)

    def test_pan_negative_90_rotates_forward_to_right(self):
        """Pan=-90deg: camera forward -> robot -Y (right)."""
        ws = WorldState()
        ws.set_head_pose(-math.pi / 2, 0.0)
        pt = ws.camera_to_robot(np.array([0, 0, 1]))
        assert pt[1] < -0.8  # y ≈ -1 (right)

    def test_tilt_down_looks_at_ground(self):
        """Tilt down: camera forward -> robot forward+down."""
        ws = WorldState()
        ws.set_head_pose(0.0, -math.pi / 4)  # tilt down 45 deg
        pt = ws.camera_to_robot(np.array([0, 0, 1]))
        assert pt[0] > 0.5   # still some forward
        assert pt[2] < 0.3   # lower z than head height


class TestDepthBasedPositioning:
    def test_center_pixel_at_2m_depth(self):
        """Center pixel at 2m depth should be ~2m forward from camera."""
        ws = WorldState()
        ws.set_head_pose(0.0, 0.0)
        intrinsics = CameraIntrinsics()
        cam_pt = intrinsics.pixel_to_3d(320.0, 240.0, 2.0)
        robot_pt = ws.camera_to_robot(cam_pt)
        # Should be approximately 2m forward, 0 lateral, head height
        assert abs(robot_pt[0] - 2.03) < 0.1  # ~2m + offset
        assert abs(robot_pt[1]) < 0.1
        assert abs(robot_pt[2] - 0.3) < 0.1

    def test_left_pixel_maps_to_robot_left(self):
        """Left side of image -> robot +Y (left)."""
        ws = WorldState()
        ws.set_head_pose(0.0, 0.0)
        intrinsics = CameraIntrinsics()
        cam_pt = intrinsics.pixel_to_3d(0.0, 240.0, 2.0)  # left edge
        robot_pt = ws.camera_to_robot(cam_pt)
        assert robot_pt[1] > 0  # left in robot frame

    def test_right_pixel_maps_to_robot_right(self):
        """Right side of image -> robot -Y (right)."""
        ws = WorldState()
        ws.set_head_pose(0.0, 0.0)
        intrinsics = CameraIntrinsics()
        cam_pt = intrinsics.pixel_to_3d(640.0, 240.0, 2.0)  # right edge
        robot_pt = ws.camera_to_robot(cam_pt)
        assert robot_pt[1] < 0  # right in robot frame
