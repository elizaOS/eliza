"""Cross-frame face tracking with embedding + IoU matching.

Maintains persistent face tracks across frames, handles occlusion
with ghost tracks (velocity-predicted positions), and uses greedy
cost-matrix matching.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time

import numpy as np

from eliza_robot.perception.detectors.face_detector import FaceDetection
from eliza_robot.perception.detectors.utils import bbox_iou, cosine_similarity


@dataclass
class FaceTrack:
    """A persistent face track across frames."""
    track_id: str
    identity_id: str
    bbox: np.ndarray           # (4,) latest bbox
    embedding: np.ndarray | None  # (512,) latest embedding
    confidence: float
    last_seen: float           # monotonic timestamp
    frames_seen: int = 1
    frames_missed: int = 0
    velocity: np.ndarray = field(default_factory=lambda: np.zeros(2))  # bbox center velocity (px/frame)


class FaceTracker:
    """Multi-face tracker with embedding-based re-identification.

    Uses a cost matrix combining IoU (spatial) and cosine similarity
    (appearance) for greedy matching. Tracks survive brief
    occlusion via ghost tracks with velocity-based prediction.
    """

    def __init__(
        self,
        max_ghost_frames: int = 15,
        iou_weight: float = 0.4,
        embedding_weight: float = 0.6,
        match_threshold: float = 0.3,
    ) -> None:
        self._tracks: dict[str, FaceTrack] = {}
        self._max_ghost = max_ghost_frames
        self._iou_w = iou_weight
        self._emb_w = embedding_weight
        self._match_thresh = match_threshold
        self._next_id = 0

    def update(
        self,
        detections: list[FaceDetection],
        identity_ids: list[str] | None = None,
    ) -> list[FaceTrack]:
        """Update tracks with new detections. Returns active tracks."""
        now = time.monotonic()
        if identity_ids is None:
            identity_ids = [""] * len(detections)

        active_tracks = list(self._tracks.values())
        if not active_tracks and not detections:
            return []

        # Build cost matrix (lower = better match)
        if active_tracks and detections:
            cost = np.ones((len(active_tracks), len(detections)), dtype=np.float32)
            for i, track in enumerate(active_tracks):
                # Use predicted bbox for ghost tracks
                pred_bbox = self._predict_bbox(track)
                for j, det in enumerate(detections):
                    iou_score = bbox_iou(pred_bbox, det.bbox)
                    emb_score = cosine_similarity(track.embedding, det.embedding)
                    score = self._iou_w * iou_score + self._emb_w * emb_score
                    cost[i, j] = 1.0 - score

            # Greedy matching (best-first by cost)
            matched_tracks: set[int] = set()
            matched_dets: set[int] = set()
            indices = np.argwhere(cost < (1.0 - self._match_thresh))
            if len(indices) > 0:
                costs_at = cost[indices[:, 0], indices[:, 1]]
                order = np.argsort(costs_at)
                for idx in order:
                    ti, di = int(indices[idx, 0]), int(indices[idx, 1])
                    if ti not in matched_tracks and di not in matched_dets:
                        matched_tracks.add(ti)
                        matched_dets.add(di)
                        track = active_tracks[ti]
                        det = detections[di]
                        # Update velocity from center displacement
                        old_center = (track.bbox[:2] + track.bbox[2:]) / 2
                        new_center = (det.bbox[:2] + det.bbox[2:]) / 2
                        track.velocity = new_center - old_center
                        track.bbox = det.bbox.copy()
                        if det.embedding is not None:
                            track.embedding = det.embedding.copy()
                        track.confidence = det.confidence
                        track.last_seen = now
                        track.frames_seen += 1
                        track.frames_missed = 0
                        if identity_ids[di]:
                            track.identity_id = identity_ids[di]
        else:
            matched_tracks = set()
            matched_dets = set()

        # Unmatched detections → new tracks
        for j, det in enumerate(detections):
            if j not in matched_dets:
                tid = f"face_{self._next_id}"
                self._next_id += 1
                self._tracks[tid] = FaceTrack(
                    track_id=tid,
                    identity_id=identity_ids[j] if identity_ids[j] else tid,
                    bbox=det.bbox.copy(),
                    embedding=det.embedding.copy() if det.embedding is not None else None,
                    confidence=det.confidence,
                    last_seen=now,
                )

        # Update ghost counters, apply velocity prediction, and prune dead tracks
        dead_ids = []
        for i, track in enumerate(active_tracks):
            if i not in matched_tracks:
                track.frames_missed += 1
                if track.frames_missed > self._max_ghost:
                    dead_ids.append(track.track_id)
                else:
                    # Predict bbox position using velocity for ghost tracks
                    track.bbox = self._predict_bbox(track)
                    track.confidence *= 0.9  # decay confidence during occlusion
        for tid in dead_ids:
            self._tracks.pop(tid, None)

        return [t for t in self._tracks.values() if t.frames_missed == 0]

    @staticmethod
    def _predict_bbox(track: FaceTrack) -> np.ndarray:
        """Predict bbox position using velocity for ghost frames."""
        if track.frames_missed == 0:
            return track.bbox
        # Shift bbox center by velocity * missed frames
        shift = np.array([
            track.velocity[0], track.velocity[1],
            track.velocity[0], track.velocity[1],
        ])
        return track.bbox + shift

    @property
    def all_tracks(self) -> list[FaceTrack]:
        return list(self._tracks.values())

    @property
    def active_track_count(self) -> int:
        return sum(1 for t in self._tracks.values() if t.frames_missed == 0)
