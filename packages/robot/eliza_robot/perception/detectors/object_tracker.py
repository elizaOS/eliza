"""Multi-object tracking using BoT-SORT via Ultralytics.

Wraps YOLO's built-in tracker to provide persistent object IDs across frames.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class TrackedObject:
    """A tracked object with persistent ID."""
    track_id: int
    bbox: np.ndarray       # (4,) x1, y1, x2, y2
    class_id: int
    class_name: str
    confidence: float


class ObjectTracker:
    """BoT-SORT multi-object tracker via Ultralytics.

    Uses YOLO's built-in .track() method for BoT-SORT tracking.
    Can share a YOLO model with ObjectDetector to avoid duplicate GPU memory.
    Falls back to no tracking if unavailable.
    """

    def __init__(
        self,
        confidence_threshold: float = 0.5,
        model_name: str = "yolo11n.pt",
        tracker_config: str = "botsort.yaml",
        model: Any = None,
    ) -> None:
        self._threshold = confidence_threshold
        self._tracker_config = tracker_config
        self._model: Any = None
        self._class_names: dict[int, str] = {}

        if model is not None:
            self._model = model
            self._class_names = model.names or {}
        else:
            try:
                from ultralytics import YOLO
                self._model = YOLO(model_name)
                self._class_names = self._model.names or {}
            except ImportError:
                self._model = None
            except Exception:
                logger.warning("YOLO tracker init failed", exc_info=True)
                self._model = None

    def track(self, frame: np.ndarray) -> list[TrackedObject]:
        """Track objects across frames. Returns list of tracked objects."""
        if self._model is None:
            return []
        try:
            results = self._model.track(
                frame,
                verbose=False,
                conf=self._threshold,
                tracker=self._tracker_config,
                persist=True,
            )
        except Exception:
            logger.warning("Tracking failed for frame", exc_info=True)
            return []

        tracked = []
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                track_id = int(box.id[0]) if box.id is not None else -1
                if track_id < 0:
                    continue
                cls_id = int(box.cls[0])
                tracked.append(TrackedObject(
                    track_id=track_id,
                    bbox=box.xyxy[0].cpu().numpy().astype(np.float32),
                    class_id=cls_id,
                    class_name=self._class_names.get(cls_id, f"class_{cls_id}"),
                    confidence=float(box.conf[0]),
                ))
        return tracked

    @property
    def is_available(self) -> bool:
        return self._model is not None
