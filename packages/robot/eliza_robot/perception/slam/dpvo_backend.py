"""DPVO SLAM backend.

Deep Patch Visual Odometry — fast (50 FPS) monocular visual odometry.
Requires DPVO to be installed separately (pip install dpvo or clone+build).
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from eliza_robot.perception.slam.slam_interface import SLAMBackend, SLAMMap, SLAMPose

logger = logging.getLogger(__name__)


class DPVOBackend(SLAMBackend):
    """DPVO visual odometry backend.

    Provides fast monocular VO at ~50 FPS. Does not produce dense maps.
    For metric scale, combine with Depth Anything V2 per keyframe.
    """

    def __init__(self, config_path: str | None = None, weights_path: str | None = None) -> None:
        self._config_path = config_path
        self._weights_path = weights_path
        self._slam: Any = None
        self._initialized = False
        self._poses: list[SLAMPose] = []
        self._intrinsics: np.ndarray | None = None

    def initialize(self, intrinsics: np.ndarray) -> None:
        """Initialize DPVO with camera intrinsics."""
        self._intrinsics = intrinsics
        try:
            from dpvo.dpvo import DPVO
            self._slam = DPVO(
                cfg=self._config_path,
                network=self._weights_path,
                ht=480,
                wd=640,
            )
            self._initialized = True
            logger.info("DPVO initialized successfully")
        except ImportError:
            logger.warning("DPVO not installed. SLAM will be unavailable.")
            self._initialized = False
        except Exception as e:
            logger.warning("DPVO init failed: %s", e)
            self._initialized = False

    def process_frame(self, frame: np.ndarray, timestamp: float) -> SLAMPose:
        """Process frame through DPVO."""
        if not self._initialized or self._slam is None:
            return SLAMPose(timestamp=timestamp)

        try:
            self._slam(timestamp, frame, self._intrinsics)
            # Get latest pose
            poses = self._slam.poses()
            if len(poses) > 0:
                pose_mat = np.eye(4, dtype=np.float64)
                pose_mat[:3, :4] = poses[-1].reshape(3, 4)
                slam_pose = SLAMPose(
                    timestamp=timestamp,
                    transform=pose_mat,
                    confidence=0.8,
                    is_tracking=True,
                )
                self._poses.append(slam_pose)
                return slam_pose
        except Exception as e:
            logger.debug("DPVO frame processing error: %s", e)

        return SLAMPose(timestamp=timestamp)

    def get_map(self) -> SLAMMap:
        """Get sparse point cloud from DPVO patches."""
        if not self._initialized or self._slam is None:
            return SLAMMap()
        try:
            points, _ = self._slam.points()
            return SLAMMap(
                points=points.astype(np.float32),
                colors=np.zeros((len(points), 3), dtype=np.uint8),
                confidences=np.ones(len(points), dtype=np.float32),
            )
        except Exception:
            return SLAMMap()

    def reset(self) -> None:
        self._poses.clear()
        if self._slam is not None and self._intrinsics is not None:
            self.initialize(self._intrinsics)

    @property
    def is_initialized(self) -> bool:
        return self._initialized
