"""Tests for object detector module."""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.perception.detectors.object_detector import (
    FURNITURE_CLASSES,
    PERSON_CLASS,
    ObjectDetection,
    ObjectDetector,
)


class TestObjectDetection:
    def test_bbox_format(self):
        det = ObjectDetection(
            bbox=np.array([10, 20, 100, 150], dtype=np.float32),
            class_id=0,
            class_name="person",
            confidence=0.9,
        )
        assert det.bbox.shape == (4,)
        assert det.bbox[2] > det.bbox[0]  # x2 > x1
        assert det.bbox[3] > det.bbox[1]  # y2 > y1

    def test_confidence_range(self):
        det = ObjectDetection(
            bbox=np.array([0, 0, 50, 50], dtype=np.float32),
            class_id=56,
            class_name="chair",
            confidence=0.75,
        )
        assert 0.0 <= det.confidence <= 1.0

    def test_class_constants(self):
        assert PERSON_CLASS == "person"
        assert "chair" in FURNITURE_CLASSES
        assert "couch" in FURNITURE_CLASSES


class TestObjectDetector:
    def test_returns_list(self, sample_frame: np.ndarray):
        detector = ObjectDetector(confidence_threshold=0.5)
        if detector.is_available:
            dets = detector.detect(sample_frame)
            assert isinstance(dets, list)

    def test_unavailable_returns_empty(self):
        """When model can't load, returns empty."""
        detector = ObjectDetector(model_name="nonexistent_model_xyz.pt")
        if not detector.is_available:
            blank = np.zeros((480, 640, 3), dtype=np.uint8)
            assert detector.detect(blank) == []
