"""Abstract SLAM interface for perception system.

Defines the common API for all SLAM backends (DPVO, MASt3R-SLAM, etc.).
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field

import numpy as np


@dataclass
class SLAMPose:
    """Camera pose from SLAM (SE3)."""
    timestamp: float
    # 4x4 transformation matrix (camera to world)
    transform: np.ndarray = field(default_factory=lambda: np.eye(4, dtype=np.float64))
    # Confidence/quality of the pose estimate
    confidence: float = 0.0
    # Tracking state
    is_tracking: bool = False

    @property
    def position(self) -> np.ndarray:
        """Translation vector (3,)."""
        return self.transform[:3, 3].copy()

    @property
    def rotation(self) -> np.ndarray:
        """Rotation matrix (3, 3)."""
        return self.transform[:3, :3].copy()

    @property
    def yaw(self) -> float:
        """Yaw angle from rotation matrix."""
        R = self.rotation
        return float(np.arctan2(R[1, 0], R[0, 0]))


@dataclass
class SLAMMap:
    """Sparse/dense map from SLAM."""
    # 3D points (N, 3)
    points: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.float32))
    # Point colors (N, 3) RGB 0-255
    colors: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.uint8))
    # Per-point confidence
    confidences: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))

    @property
    def num_points(self) -> int:
        return self.points.shape[0]

    def within_radius(self, center: np.ndarray, radius: float) -> np.ndarray:
        """Return points within radius of center. Returns (M, 3)."""
        if self.num_points == 0:
            return np.zeros((0, 3), dtype=np.float32)
        dists = np.linalg.norm(self.points - center[None, :], axis=1)
        mask = dists < radius
        return self.points[mask]


class SLAMBackend(abc.ABC):
    """Abstract SLAM backend interface."""

    @abc.abstractmethod
    def initialize(self, intrinsics: np.ndarray) -> None:
        """Initialize SLAM with camera intrinsics (3x3 matrix)."""

    @abc.abstractmethod
    def process_frame(self, frame: np.ndarray, timestamp: float) -> SLAMPose:
        """Process a new frame and return the estimated pose."""

    @abc.abstractmethod
    def get_map(self) -> SLAMMap:
        """Get the current map."""

    @abc.abstractmethod
    def reset(self) -> None:
        """Reset SLAM state."""

    @property
    @abc.abstractmethod
    def is_initialized(self) -> bool:
        """Whether SLAM has been initialized."""

    @property
    def name(self) -> str:
        return self.__class__.__name__
