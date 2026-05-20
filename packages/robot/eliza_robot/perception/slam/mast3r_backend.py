"""MASt3R-SLAM backend.

Dense metric SLAM using MASt3R — slower (15 FPS) but provides metric
scale and dense maps. Optional heavier alternative to DPVO.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from eliza_robot.perception.slam.slam_interface import SLAMBackend, SLAMMap, SLAMPose

logger = logging.getLogger(__name__)


class MASt3RBackend(SLAMBackend):
    """MASt3R-SLAM dense metric SLAM backend.

    Provides metric-scale dense maps at ~15 FPS.
    Requires mast3r to be installed separately.
    """

    def __init__(self, model_path: str | None = None) -> None:
        self._model_path = model_path
        self._slam: Any = None
        self._initialized = False
        self._poses: list[SLAMPose] = []
        self._intrinsics: np.ndarray | None = None

    def initialize(self, intrinsics: np.ndarray) -> None:
        """Initialize MASt3R-SLAM with camera intrinsics."""
        self._intrinsics = intrinsics
        try:
            # MASt3R-SLAM imports
            from mast3r_slam import MASt3RSLAM
            self._slam = MASt3RSLAM(
                model_path=self._model_path,
                intrinsics=intrinsics,
            )
            self._initialized = True
            logger.info("MASt3R-SLAM initialized successfully")
        except ImportError:
            logger.warning("MASt3R-SLAM not installed. Dense SLAM unavailable.")
            self._initialized = False
        except Exception as e:
            logger.warning("MASt3R-SLAM init failed: %s", e)
            self._initialized = False

    def process_frame(self, frame: np.ndarray, timestamp: float) -> SLAMPose:
        """Process frame through MASt3R-SLAM."""
        if not self._initialized or self._slam is None:
            return SLAMPose(timestamp=timestamp)

        try:
            result = self._slam.process(frame, timestamp)
            if result is not None and result.get("pose") is not None:
                pose_mat = np.array(result["pose"], dtype=np.float64).reshape(4, 4)
                slam_pose = SLAMPose(
                    timestamp=timestamp,
                    transform=pose_mat,
                    confidence=float(result.get("confidence", 0.8)),
                    is_tracking=True,
                )
                self._poses.append(slam_pose)
                return slam_pose
        except Exception as e:
            logger.debug("MASt3R frame processing error: %s", e)

        return SLAMPose(timestamp=timestamp)

    def get_map(self) -> SLAMMap:
        """Get dense point cloud from MASt3R."""
        if not self._initialized or self._slam is None:
            return SLAMMap()
        try:
            points = self._slam.get_pointcloud()
            colors = self._slam.get_colors() if hasattr(self._slam, "get_colors") else None
            return SLAMMap(
                points=np.array(points, dtype=np.float32),
                colors=np.array(colors, dtype=np.uint8) if colors is not None else np.zeros((len(points), 3), dtype=np.uint8),
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
