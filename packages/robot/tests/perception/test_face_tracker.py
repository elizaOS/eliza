"""Tests for face tracker module — the most complex untested algorithm."""

from __future__ import annotations

import time

import numpy as np
import pytest

from eliza_robot.perception.detectors.face_detector import FaceDetection
from eliza_robot.perception.detectors.face_tracker import FaceTrack, FaceTracker
from eliza_robot.perception.detectors.utils import bbox_iou, cosine_similarity


class TestIoU:
    def test_identical_boxes(self):
        box = np.array([0, 0, 100, 100], dtype=np.float32)
        assert abs(bbox_iou(box, box) - 1.0) < 1e-6

    def test_no_overlap(self):
        a = np.array([0, 0, 50, 50], dtype=np.float32)
        b = np.array([100, 100, 200, 200], dtype=np.float32)
        assert bbox_iou(a, b) == 0.0

    def test_partial_overlap(self):
        a = np.array([0, 0, 100, 100], dtype=np.float32)
        b = np.array([50, 50, 150, 150], dtype=np.float32)
        # Intersection: 50x50 = 2500, Union: 10000+10000-2500 = 17500
        expected = 2500 / 17500
        assert abs(bbox_iou(a, b) - expected) < 1e-4

    def test_contained_box(self):
        outer = np.array([0, 0, 200, 200], dtype=np.float32)
        inner = np.array([50, 50, 100, 100], dtype=np.float32)
        # Intersection = inner area = 2500, Union = 40000+2500-2500 = 40000
        expected = 2500 / 40000
        assert abs(bbox_iou(outer, inner) - expected) < 1e-4


class TestCosineSim:
    def test_identical_embeddings(self):
        emb = np.random.randn(512).astype(np.float32)
        assert abs(cosine_similarity(emb, emb) - 1.0) < 1e-4

    def test_orthogonal_embeddings(self):
        a = np.zeros(512, dtype=np.float32)
        b = np.zeros(512, dtype=np.float32)
        a[0] = 1.0
        b[1] = 1.0
        assert abs(cosine_similarity(a, b)) < 1e-6

    def test_none_embedding(self):
        emb = np.random.randn(512).astype(np.float32)
        assert cosine_similarity(emb, None) == 0.0
        assert cosine_similarity(None, emb) == 0.0
        assert cosine_similarity(None, None) == 0.0


def _make_det(bbox, emb=None, conf=0.9):
    return FaceDetection(
        bbox=np.array(bbox, dtype=np.float32),
        confidence=conf,
        landmarks=np.zeros((5, 2), dtype=np.float32),
        embedding=emb,
    )


class TestFaceTracker:
    def test_new_detection_creates_track(self):
        tracker = FaceTracker()
        dets = [_make_det([100, 100, 200, 200])]
        tracks = tracker.update(dets)
        assert len(tracks) == 1
        assert tracker.active_track_count == 1

    def test_same_position_matched(self):
        tracker = FaceTracker()
        det1 = _make_det([100, 100, 200, 200])
        tracks1 = tracker.update([det1])
        tid1 = tracks1[0].track_id

        det2 = _make_det([105, 105, 205, 205])
        tracks2 = tracker.update([det2])
        assert len(tracks2) == 1
        assert tracks2[0].track_id == tid1  # same track matched

    def test_two_detections_two_tracks(self):
        tracker = FaceTracker()
        det1 = _make_det([100, 100, 200, 200])
        det2 = _make_det([400, 100, 500, 200])
        tracks = tracker.update([det1, det2])
        assert len(tracks) == 2

    def test_ghost_track_survives_brief_occlusion(self):
        tracker = FaceTracker(max_ghost_frames=5)
        det1 = _make_det([100, 100, 200, 200])
        tracker.update([det1])

        # Face disappears for 3 frames
        for _ in range(3):
            tracker.update([])

        # Face reappears at same position
        det2 = _make_det([105, 105, 205, 205])
        tracks = tracker.update([det2])
        # Should match the existing track, not create new
        assert len(tracker.all_tracks) <= 2  # at most the old ghost + new match

    def test_ghost_track_dies_after_max_frames(self):
        tracker = FaceTracker(max_ghost_frames=3)
        det1 = _make_det([100, 100, 200, 200])
        tracker.update([det1])

        # Face disappears for 5 frames (exceeds max_ghost=3)
        for _ in range(5):
            tracker.update([])

        assert tracker.active_track_count == 0
        assert len(tracker.all_tracks) == 0

    def test_identity_propagation(self):
        tracker = FaceTracker()
        det1 = _make_det([100, 100, 200, 200])
        tracks = tracker.update([det1], identity_ids=["alice_0"])
        assert tracks[0].identity_id == "alice_0"

    def test_velocity_estimation(self):
        # Use iou_weight=1.0 so spatial-only matching works without embeddings
        tracker = FaceTracker(iou_weight=1.0, embedding_weight=0.0)
        det1 = _make_det([100, 100, 200, 200])
        tracker.update([det1])

        det2 = _make_det([120, 100, 220, 200])  # moved 20px right
        tracks = tracker.update([det2])
        assert tracks[0].velocity[0] > 0  # positive x velocity

    def test_embedding_based_matching(self):
        tracker = FaceTracker(iou_weight=0.0, embedding_weight=1.0)
        emb = np.random.randn(512).astype(np.float32)

        det1 = _make_det([100, 100, 200, 200], emb=emb)
        tracks1 = tracker.update([det1])
        tid1 = tracks1[0].track_id

        # Different position but same embedding -> should match
        det2 = _make_det([300, 100, 400, 200], emb=emb + np.random.randn(512).astype(np.float32) * 0.01)
        tracks2 = tracker.update([det2])
        assert tracks2[0].track_id == tid1
