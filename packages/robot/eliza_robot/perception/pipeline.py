"""Main perception pipeline orchestrator.

Runs all detectors on each frame, updates the world model,
and produces entity slots for the RL policy.
"""

from __future__ import annotations

import collections
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.config import PipelineConfig
from eliza_robot.perception.detectors.aruco_detector import ArucoDetector
from eliza_robot.perception.detectors.depth_estimator import DepthEstimator, DepthResult
from eliza_robot.perception.detectors.face_detector import FaceDetector
from eliza_robot.perception.detectors.face_recognizer import FaceRecognizer
from eliza_robot.perception.detectors.face_tracker import FaceTracker
from eliza_robot.perception.detectors.object_detector import ObjectDetector
from eliza_robot.perception.detectors.object_tracker import ObjectTracker
from eliza_robot.perception.detectors.skeleton_estimator import SkeletonEstimator
from eliza_robot.perception.entity_slots.slot_encoder import encode_entity_slots
from eliza_robot.perception.frame_source import FrameSource
from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics, ExtrinsicCalibrator
from eliza_robot.perception.world_model.entity import EntityType, PersistentEntity
from eliza_robot.perception.world_model.world_state import WorldState

logger = logging.getLogger(__name__)


@dataclass
class PipelineResult:
    """Output of a single pipeline step."""
    entity_slots: np.ndarray          # (152,) flat
    entities: list[Any]               # PersistentEntity list
    depth: DepthResult | None = None
    frame_timestamp: float = 0.0
    processing_ms: float = 0.0


class PerceptionPipeline:
    """Main perception pipeline: frame → detections → world model → entity slots.

    Initializes all detectors and runs them per-frame. Non-available detectors
    are silently skipped.
    """

    def __init__(self, config: PipelineConfig | None = None) -> None:
        self._config = config or PipelineConfig()
        self._intrinsics = CameraIntrinsics(
            fx=self._config.camera.fx,
            fy=self._config.camera.fy,
            cx=self._config.camera.cx,
            cy=self._config.camera.cy,
            dist_coeffs=self._config.camera.dist_coeffs,
            width=self._config.camera.width,
            height=self._config.camera.height,
        )
        # Detectors
        self._face_detector = FaceDetector(
            confidence_threshold=self._config.detector.face_confidence,
        )
        self._face_recognizer = FaceRecognizer(
            recognition_threshold=self._config.detector.face_recognition_threshold,
            gallery_dir=self._config.data_dir / "face_gallery",
        )
        self._face_tracker = FaceTracker()
        self._object_detector = ObjectDetector(
            confidence_threshold=self._config.detector.object_confidence,
        )
        # Share YOLO model between detector and tracker to avoid double GPU memory
        self._object_tracker = ObjectTracker(
            confidence_threshold=self._config.detector.object_confidence,
            model=self._object_detector._model if self._object_detector.is_available else None,
        )
        self._skeleton_estimator = SkeletonEstimator(
            confidence_threshold=self._config.detector.skeleton_confidence,
        )
        self._depth_estimator = DepthEstimator() if self._config.detector.depth_enabled else None

        # ArUco detector (for object markers in ego camera)
        self._aruco_detector: ArucoDetector | None = None
        if self._config.markers.object_markers:
            try:
                self._aruco_detector = ArucoDetector(
                    intrinsics=self._intrinsics,
                    marker_size_m=self._config.markers.marker_size_m,
                )
                logger.info(
                    "ArUco detector enabled for %d object markers",
                    len(self._config.markers.object_markers),
                )
            except Exception as e:
                logger.warning("ArUco detector init failed: %s", e)

        # External camera ArUco detector (separate intrinsics)
        self._ext_aruco_detector: ArucoDetector | None = None
        self._ext_intrinsics: CameraIntrinsics | None = None
        self._ext_extrinsics: CameraExtrinsics | None = None
        self._ext_calibrator: ExtrinsicCalibrator | None = None
        if self._config.external_camera.enabled and self._config.markers.world_markers:
            ext = self._config.external_camera
            self._ext_intrinsics = CameraIntrinsics(
                fx=ext.fx, fy=ext.fy, cx=ext.cx, cy=ext.cy,
                dist_coeffs=ext.dist_coeffs,
                width=ext.width, height=ext.height,
            )
            try:
                self._ext_aruco_detector = ArucoDetector(
                    intrinsics=self._ext_intrinsics,
                    marker_size_m=self._config.markers.marker_size_m,
                )
                self._ext_calibrator = ExtrinsicCalibrator(
                    marker_world_positions={
                        mid: __import__("numpy").array(pos)
                        for mid, pos in self._config.markers.world_markers.items()
                    },
                    marker_size_m=self._config.markers.marker_size_m,
                )
                logger.info("External camera ArUco pipeline enabled")
            except Exception as e:
                logger.warning("External camera ArUco init failed: %s", e)

        # World model
        self._world = WorldState(
            intrinsics=self._intrinsics,
            stale_timeout_sec=self._config.stale_timeout_sec,
        )

        # Latency tracking: ring buffer of last 30 processing times (ms)
        self._frame_times: collections.deque[float] = collections.deque(maxlen=30)

        # Callbacks
        self._callbacks: list[Callable[[PipelineResult], None]] = []

    def add_callback(self, callback: Callable[[PipelineResult], None]) -> None:
        """Register a callback invoked after each pipeline step."""
        self._callbacks.append(callback)

    def connect_aggregator(self, aggregator: Any) -> None:
        """Connect pipeline output to a PerceptionAggregator.

        Registers a callback that feeds entity slots and tracked entities
        into the aggregator on every frame, closing the bridge integration gap.
        """
        def _feed_aggregator(result: PipelineResult) -> None:
            # Update entity slots
            aggregator.update_entity_slots(tuple(result.entity_slots.tolist()))
            # Also update entities batch for the scene_summary / Eliza path
            entities_batch = []
            for e in result.entities:
                entry = {
                    "entity_id": e.entity_id,
                    "label": e.label,
                    "confidence": e.confidence,
                    "x": float(e.position[0]),
                    "y": float(e.position[1]),
                    "z": float(e.position[2]),
                    "source": e.source,
                }
                if e.marker_id >= 0:
                    entry["marker_id"] = e.marker_id
                entities_batch.append(entry)
            if entities_batch:
                aggregator.update_entities_batch(entities_batch)

        self._callbacks.append(_feed_aggregator)

    def process_frame(self, frame: np.ndarray) -> PipelineResult:
        """Run full pipeline on a single BGR frame."""
        t0 = time.monotonic()

        # Depth estimation
        depth = None
        if self._depth_estimator is not None:
            depth = self._depth_estimator.estimate(frame)

        # Face detection → recognition → tracking
        face_dets = self._face_detector.detect(frame)
        identity_ids = []
        for det in face_dets:
            if det.embedding is not None:
                identity_id, _ = self._face_recognizer.recognize(det)
                identity_ids.append(identity_id)
            else:
                identity_ids.append("")
        face_tracks = self._face_tracker.update(face_dets, identity_ids)
        self._world.update_from_faces(face_tracks, depth)

        # Object detection + tracking
        if self._object_tracker.is_available:
            tracked_objs = self._object_tracker.track(frame)
            self._world.update_from_objects(tracked_objs, depth)
        elif self._object_detector.is_available:
            obj_dets = self._object_detector.detect(frame)
            self._world.update_from_objects(obj_dets, depth)

        # Skeleton estimation
        skeletons = self._skeleton_estimator.estimate(frame)
        if skeletons:
            self._world.update_from_skeletons(skeletons, depth)

        # ArUco marker detection (ego camera)
        if self._aruco_detector is not None:
            aruco_dets = self._aruco_detector.detect(frame)
            if aruco_dets:
                self._world.update_from_aruco(
                    aruco_dets,
                    object_markers=self._config.markers.object_markers,
                    robot_marker_ids=self._config.markers.robot_marker_ids,
                    robot_head_marker_id=self._config.markers.robot_head_marker_id,
                )

        # Prune stale
        self._world.prune_stale()

        # Encode entity slots
        entity_slots = encode_entity_slots(self._world.entity_list)

        t1 = time.monotonic()
        processing_ms = (t1 - t0) * 1000
        result = PipelineResult(
            entity_slots=entity_slots,
            entities=self._world.entity_list,
            depth=depth,
            frame_timestamp=t0,
            processing_ms=processing_ms,
        )

        # Track latency in ring buffer
        self._frame_times.append(processing_ms)

        for cb in self._callbacks:
            try:
                cb(result)
            except Exception as e:
                logger.warning("Pipeline callback error: %s", e)

        return result

    def process_external_frame(self, frame: np.ndarray) -> None:
        """Process a frame from the external camera.

        Detects ArUco markers to:
        1. Calibrate the external camera's world-frame extrinsics (from ground markers)
        2. Locate the robot in world frame (from robot body marker)
        3. Locate objects in world frame (from object markers)

        Detected objects are injected into the world model as PersistentEntity
        instances with source="aruco_external".
        """
        if self._ext_aruco_detector is None or self._ext_intrinsics is None:
            return

        detections = self._ext_aruco_detector.detect(frame)
        if not detections:
            return

        # Calibrate extrinsics from ground-plane markers (if visible)
        if self._ext_calibrator is not None:
            ground_dets = [d for d in detections if d.marker_id in self._config.markers.world_markers]
            if len(ground_dets) >= 2:
                ext = self._ext_calibrator.calibrate_from_detections(
                    detections, self._ext_intrinsics, "external",
                )
                if ext is not None:
                    self._ext_extrinsics = ext

        if self._ext_extrinsics is None:
            return

        now = time.monotonic()
        markers = self._config.markers

        for det in detections:
            # Skip ground markers and robot markers
            if det.marker_id in markers.world_markers:
                continue
            if det.marker_id in markers.robot_marker_ids:
                continue
            if det.marker_id == markers.robot_head_marker_id:
                continue

            # Object markers → world-frame entities
            if det.marker_id in markers.object_markers:
                world_pos = self._ext_extrinsics.transform_point(det.tvec)
                label = markers.object_markers[det.marker_id]
                eid = f"ext_aruco_{det.marker_id}_{label}"

                entity = self._world.entities.get(eid)
                if entity is None:
                    entity = PersistentEntity(
                        entity_id=eid,
                        entity_type=EntityType.OBJECT,
                        label=label,
                        source="aruco_external",
                        marker_id=det.marker_id,
                    )
                    self._world.add_or_update_entity(eid, entity)

                dt = now - entity.last_seen if entity.last_seen > 0 else 0.033
                entity.update_position(world_pos.astype(np.float32), dt)
                entity.confidence = det.confidence

    def process_dual_frame(
        self, ego_frame: np.ndarray, external_frame: np.ndarray,
    ) -> PipelineResult:
        """Process synchronized ego + external camera frames.

        Runs full ego pipeline and external ArUco detection, then
        produces a unified entity slot encoding from both views.
        """
        self.process_external_frame(external_frame)
        return self.process_frame(ego_frame)

    def run(self, source: FrameSource) -> None:
        """Run pipeline continuously on a frame source."""
        with source:
            for frame in source:
                self.process_frame(frame)

    @property
    def world_state(self) -> WorldState:
        return self._world

    @property
    def intrinsics(self) -> CameraIntrinsics:
        return self._intrinsics

    @property
    def external_extrinsics(self) -> CameraExtrinsics | None:
        return self._ext_extrinsics

    @property
    def fps(self) -> float:
        """Return the current effective FPS based on recent processing times."""
        if not self._frame_times:
            return 0.0
        mean_ms = sum(self._frame_times) / len(self._frame_times)
        if mean_ms <= 0:
            return 0.0
        return 1000.0 / mean_ms

    @property
    def is_healthy(self) -> bool:
        """Return True if the pipeline is processing at >= 5 FPS."""
        return self.fps >= 5.0

    def get_latency_stats(self) -> dict[str, float | bool]:
        """Return latency statistics for the perception pipeline.

        Returns:
            Dictionary with fps, mean_ms, max_ms, and healthy flag.
        """
        if not self._frame_times:
            return {
                "fps": 0.0,
                "mean_ms": 0.0,
                "max_ms": 0.0,
                "healthy": False,
            }
        times = list(self._frame_times)
        mean_ms = sum(times) / len(times)
        max_ms = max(times)
        current_fps = 1000.0 / mean_ms if mean_ms > 0 else 0.0
        return {
            "fps": current_fps,
            "mean_ms": mean_ms,
            "max_ms": max_ms,
            "healthy": current_fps >= 5.0,
        }
