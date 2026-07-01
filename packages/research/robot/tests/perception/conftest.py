"""Shared fixtures for perception tests."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics


@pytest.fixture
def default_intrinsics() -> CameraIntrinsics:
    """Default camera intrinsics (62 deg HFOV at 640x480)."""
    return CameraIntrinsics()


@pytest.fixture
def sample_frame() -> np.ndarray:
    """A synthetic 640x480 BGR test frame."""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    # Add some visual features
    frame[200:280, 280:360] = [255, 200, 150]  # blue-ish rectangle (face-like)
    frame[100:150, 400:500] = [0, 255, 0]      # green rectangle
    frame[300:400, 50:150] = [0, 0, 255]       # red rectangle
    return frame


@pytest.fixture
def sample_gray_frame(sample_frame: np.ndarray) -> np.ndarray:
    """Grayscale version of sample_frame."""
    import cv2
    return cv2.cvtColor(sample_frame, cv2.COLOR_BGR2GRAY)


@pytest.fixture
def sample_depth_map() -> np.ndarray:
    """A synthetic depth map (480x640, float32, meters)."""
    depth = np.ones((480, 640), dtype=np.float32) * 2.0  # 2m background
    depth[200:280, 280:360] = 1.0  # closer region
    depth[300:400, 50:150] = 3.0   # farther region
    return depth
