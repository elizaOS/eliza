"""Face detection using InsightFace SCRFD.

Detects faces with bounding boxes, landmarks, and confidence scores.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class FaceDetection:
    """A single detected face."""
    bbox: np.ndarray         # (4,) x1, y1, x2, y2
    confidence: float
    landmarks: np.ndarray    # (5, 2) five facial landmarks
    embedding: np.ndarray | None = None  # (512,) filled by recognizer


class FaceDetector:
    """Face detector using InsightFace SCRFD model.

    Falls back to OpenCV Haar cascades if InsightFace is unavailable.
    """

    def __init__(
        self,
        confidence_threshold: float = 0.5,
        model_name: str = "buffalo_l",
        providers: list[str] | None = None,
    ) -> None:
        self._threshold = confidence_threshold
        self._fallback = False
        self._app = None
        self._cascade = None

        try:
            import insightface
            self._app = insightface.app.FaceAnalysis(
                name=model_name,
                providers=providers or ["CUDAExecutionProvider", "CPUExecutionProvider"],
            )
            self._app.prepare(ctx_id=0, det_size=(640, 640))
        except ImportError:
            self._app = None
            self._fallback = True
            try:
                import cv2
                self._cascade = cv2.CascadeClassifier(
                    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
                )
            except ImportError:
                self._cascade = None
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "InsightFace init failed", exc_info=True,
            )
            self._app = None
            self._fallback = True
            self._cascade = None

    def detect(self, frame: np.ndarray) -> list[FaceDetection]:
        """Detect faces in a BGR frame. Returns list of FaceDetection."""
        if self._app is not None:
            return self._detect_insightface(frame)
        if self._cascade is not None:
            return self._detect_haar(frame)
        return []

    def _detect_insightface(self, frame: np.ndarray) -> list[FaceDetection]:
        faces = self._app.get(frame)
        results = []
        for face in faces:
            conf = float(face.det_score)
            if conf < self._threshold:
                continue
            results.append(FaceDetection(
                bbox=np.array(face.bbox, dtype=np.float32),
                confidence=conf,
                landmarks=np.array(face.kps, dtype=np.float32) if face.kps is not None else np.zeros((5, 2)),
                embedding=np.array(face.normed_embedding, dtype=np.float32) if hasattr(face, "normed_embedding") and face.normed_embedding is not None else None,
            ))
        return results

    def _detect_haar(self, frame: np.ndarray) -> list[FaceDetection]:
        import cv2
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
        rects = self._cascade.detectMultiScale(gray, 1.3, 5)
        results = []
        for (x, y, w, h) in rects:
            # Haar has no confidence score; use a conservative fixed value
            results.append(FaceDetection(
                bbox=np.array([x, y, x + w, y + h], dtype=np.float32),
                confidence=0.5,
                landmarks=np.zeros((5, 2), dtype=np.float32),
            ))
        return results

    @property
    def is_available(self) -> bool:
        return self._app is not None or self._cascade is not None

    @property
    def is_using_fallback(self) -> bool:
        return self._fallback
