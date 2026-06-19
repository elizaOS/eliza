"""Tests for face recognizer module."""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import pytest

from eliza_robot.perception.detectors.face_detector import FaceDetection
from eliza_robot.perception.detectors.face_recognizer import FaceRecognizer


def _make_detection(embedding: np.ndarray | None = None) -> FaceDetection:
    return FaceDetection(
        bbox=np.array([10, 20, 100, 150], dtype=np.float32),
        confidence=0.9,
        landmarks=np.zeros((5, 2), dtype=np.float32),
        embedding=embedding,
    )


class TestFaceRecognizer:
    def test_empty_gallery_assigns_new_id(self):
        rec = FaceRecognizer(recognition_threshold=0.4)
        emb = np.random.randn(512).astype(np.float32)
        det = _make_detection(emb)
        identity_id, score = rec.recognize(det)
        assert identity_id != ""
        assert rec.gallery_size == 1

    def test_known_face_matches(self):
        rec = FaceRecognizer(recognition_threshold=0.4)
        emb = np.random.randn(512).astype(np.float32)
        det1 = _make_detection(emb)
        id1, _ = rec.recognize(det1)
        # Same embedding should match
        det2 = _make_detection(emb + np.random.randn(512).astype(np.float32) * 0.01)
        id2, score = rec.recognize(det2)
        assert id2 == id1
        assert score > 0.9

    def test_different_person_new_id(self):
        rec = FaceRecognizer(recognition_threshold=0.4)
        emb1 = np.random.randn(512).astype(np.float32)
        emb2 = np.random.randn(512).astype(np.float32)
        # Make them sufficiently different
        emb2 = emb2 / np.linalg.norm(emb2)
        emb1 = emb1 / np.linalg.norm(emb1)
        det1 = _make_detection(emb1)
        det2 = _make_detection(emb2)
        id1, _ = rec.recognize(det1)
        id2, _ = rec.recognize(det2)
        # With random 512-d embeddings, cosine sim ≈ 0, so should be different
        assert id1 != id2
        assert rec.gallery_size == 2

    def test_no_embedding_returns_empty(self):
        rec = FaceRecognizer()
        det = _make_detection(None)
        identity_id, score = rec.recognize(det)
        # No embedding → can't identify, returns empty
        assert identity_id == ""
        assert score == 0.0
        assert rec.gallery_size == 0  # no useless gallery entry created

    def test_manual_enroll(self):
        rec = FaceRecognizer()
        emb = np.random.randn(512).astype(np.float32)
        identity_id = rec.enroll("Alice", emb)
        identity = rec.get_identity(identity_id)
        assert identity is not None
        assert identity.name == "Alice"

    def test_gallery_persistence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gallery_dir = Path(tmpdir) / "gallery"
            rec1 = FaceRecognizer(gallery_dir=gallery_dir)
            emb = np.random.randn(512).astype(np.float32)
            rec1.enroll("Bob", emb, identity_id="bob_0")
            rec1.save_gallery()

            rec2 = FaceRecognizer(gallery_dir=gallery_dir)
            assert rec2.gallery_size == 1
            identity = rec2.get_identity("bob_0")
            assert identity is not None
            assert identity.name == "Bob"
            assert np.allclose(identity.embedding, emb)
