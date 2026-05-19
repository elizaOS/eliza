"""Object detection using YOLO11.

Detects COCO objects with bounding boxes, class labels, and confidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass
class ObjectDetection:
    """A single detected object."""
    bbox: np.ndarray       # (4,) x1, y1, x2, y2
    class_id: int
    class_name: str
    confidence: float


# Common COCO class names for filtering
PERSON_CLASS = "person"
FURNITURE_CLASSES = {"chair", "couch", "bed", "dining table", "toilet"}


class ObjectDetector:
    """YOLO11 object detector.

    Falls back to a stub if ultralytics is unavailable.
    """

    def __init__(
        self,
        confidence_threshold: float = 0.5,
        model_name: str = "yolo11n.pt",
        classes: list[int] | None = None,
    ) -> None:
        self._threshold = confidence_threshold
        self._classes = classes
        self._model: Any = None
        self._class_names: dict[int, str] = {}

        try:
            from ultralytics import YOLO
            self._model = YOLO(model_name)
            self._class_names = self._model.names or {}
        except ImportError:
            self._model = None
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "YOLO init failed", exc_info=True,
            )
            self._model = None

    def detect(self, frame: np.ndarray) -> list[ObjectDetection]:
        """Detect objects in a BGR frame."""
        if self._model is None:
            return []
        results = self._model(frame, verbose=False, conf=self._threshold, classes=self._classes)
        detections = []
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                conf = float(box.conf[0])
                cls_id = int(box.cls[0])
                cls_name = self._class_names.get(cls_id, f"class_{cls_id}")
                detections.append(ObjectDetection(
                    bbox=box.xyxy[0].cpu().numpy().astype(np.float32),
                    class_id=cls_id,
                    class_name=cls_name,
                    confidence=conf,
                ))
        return detections

    @property
    def is_available(self) -> bool:
        return self._model is not None

    @property
    def class_names(self) -> dict[int, str]:
        return dict(self._class_names)
