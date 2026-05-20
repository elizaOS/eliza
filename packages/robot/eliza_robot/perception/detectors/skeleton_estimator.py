"""Skeleton/pose estimation using rtmlib (RTMW).

Estimates whole-body keypoints for detected persons.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


# Standard body keypoint indices (COCO-WholeBody 133 keypoints)
NOSE = 0
LEFT_SHOULDER = 5
RIGHT_SHOULDER = 6
LEFT_HIP = 11
RIGHT_HIP = 12
LEFT_ANKLE = 15
RIGHT_ANKLE = 16


@dataclass
class Skeleton:
    """Estimated pose skeleton for a person."""
    keypoints: np.ndarray      # (N, 2) or (N, 3) keypoint positions
    scores: np.ndarray         # (N,) per-keypoint confidence
    bbox: np.ndarray           # (4,) x1, y1, x2, y2 of the person

    @property
    def center(self) -> np.ndarray:
        """Bounding box center (x, y)."""
        return (self.bbox[:2] + self.bbox[2:]) / 2

    @property
    def height_pixels(self) -> float:
        return float(self.bbox[3] - self.bbox[1])

    def get_torso_center(self) -> np.ndarray | None:
        """Midpoint of shoulders and hips if visible."""
        if self.keypoints.shape[0] <= RIGHT_HIP:
            return None
        pts = self.keypoints[[LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP]]
        scores = self.scores[[LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP]]
        if np.all(scores > 0.3):
            return pts.mean(axis=0)
        return None


class SkeletonEstimator:
    """Pose estimation using rtmlib RTMW model.

    Falls back to stub if rtmlib is unavailable.
    """

    def __init__(
        self,
        confidence_threshold: float = 0.3,
        model_type: str = "rtmpose-l",
        backend: str = "onnxruntime",
        device: str = "cuda",
    ) -> None:
        self._threshold = confidence_threshold
        self._model: Any = None

        try:
            from rtmlib import Wholebody
            self._model = Wholebody(
                pose=model_type,
                to_openpose=False,
                mode="balanced",
                backend=backend,
                device=device,
            )
        except ImportError:
            self._model = None
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "rtmlib init failed", exc_info=True,
            )
            self._model = None

    def estimate(self, frame: np.ndarray) -> list[Skeleton]:
        """Estimate skeletons for all persons in frame."""
        if self._model is None:
            return []
        try:
            keypoints, scores = self._model(frame)
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Skeleton estimation failed", exc_info=True,
            )
            return []

        skeletons = []
        for i in range(len(keypoints)):
            kps = np.array(keypoints[i], dtype=np.float32)
            sc = np.array(scores[i], dtype=np.float32)

            # Compute bbox from visible keypoints
            visible = sc > self._threshold
            if not np.any(visible):
                continue
            vis_kps = kps[visible]
            x1, y1 = vis_kps.min(axis=0)[:2]
            x2, y2 = vis_kps.max(axis=0)[:2]
            bbox = np.array([x1, y1, x2, y2], dtype=np.float32)

            skeletons.append(Skeleton(
                keypoints=kps,
                scores=sc,
                bbox=bbox,
            ))
        return skeletons

    @property
    def is_available(self) -> bool:
        return self._model is not None
