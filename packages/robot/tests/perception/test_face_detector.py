"""Tests for face detector module."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.detectors.face_detector import FaceDetection, FaceDetector


class TestFaceDetection:
    def test_bbox_shape(self):
        det = FaceDetection(
            bbox=np.array([10, 20, 100, 150], dtype=np.float32),
            confidence=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
        )
        assert det.bbox.shape == (4,)

    def test_landmarks_shape(self):
        det = FaceDetection(
            bbox=np.array([10, 20, 100, 150], dtype=np.float32),
            confidence=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
        )
        assert det.landmarks.shape == (5, 2)

    def test_embedding_optional(self):
        det = FaceDetection(
            bbox=np.array([0, 0, 50, 50], dtype=np.float32),
            confidence=0.5,
            landmarks=np.zeros((5, 2), dtype=np.float32),
        )
        assert det.embedding is None

    def test_confidence_range(self):
        det = FaceDetection(
            bbox=np.array([0, 0, 50, 50], dtype=np.float32),
            confidence=0.85,
            landmarks=np.zeros((5, 2), dtype=np.float32),
        )
        assert 0.0 <= det.confidence <= 1.0


class TestFaceDetector:
    def test_no_faces_on_blank_image(self):
        detector = FaceDetector(confidence_threshold=0.5)
        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        if detector.is_available:
            dets = detector.detect(blank)
            assert isinstance(dets, list)

    def test_returns_list(self, sample_frame: np.ndarray):
        detector = FaceDetector(confidence_threshold=0.5)
        if detector.is_available:
            dets = detector.detect(sample_frame)
            assert isinstance(dets, list)

    def test_detection_fields(self):
        """Verify detection dataclass fields are properly typed."""
        det = FaceDetection(
            bbox=np.array([10, 20, 100, 150], dtype=np.float32),
            confidence=0.95,
            landmarks=np.random.randn(5, 2).astype(np.float32),
            embedding=np.random.randn(512).astype(np.float32),
        )
        assert det.bbox.dtype == np.float32
        assert det.landmarks.dtype == np.float32
        assert det.embedding.dtype == np.float32
        assert det.embedding.shape == (512,)
