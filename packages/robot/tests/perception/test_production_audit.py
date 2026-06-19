"""Production audit validation tests.

Tests focused on:
1. Fixes from the 2026-03-02 audit (world_state timing, gallery cap, etc.)
2. Sim-real slot encoding parity
3. Edge cases in entity scene randomization
4. Coordinate transform numerical checks
"""

from __future__ import annotations

import time

import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.face_detector import FaceDetection
from eliza_robot.perception.detectors.face_recognizer import FaceRecognizer
from eliza_robot.perception.detectors.face_tracker import FaceTracker
from eliza_robot.perception.detectors.utils import bbox_iou, cosine_similarity
from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    MAX_DISTANCE,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    RECENCY_OFFSET,
    SIZE_OFFSET,
    SLOT_DIM,
    TYPE_OFFSET,
    VELOCITY_OFFSET,
    EntityType,
)
from eliza_robot.perception.entity_slots.slot_encoder import encode_entity_slots
from eliza_robot.perception.world_model.entity import PersistentEntity, classify_entity_type
from eliza_robot.perception.world_model.world_state import WorldState


# ---------------------------------------------------------------------------
# Section 1: NUM_ENTITY_TYPES derived from enum
# ---------------------------------------------------------------------------

class TestSlotConfigDerivation:
    def test_num_entity_types_matches_enum(self):
        assert NUM_ENTITY_TYPES == len(EntityType)

    def test_all_entity_types_have_valid_index(self):
        for et in EntityType:
            assert 0 <= int(et) < NUM_ENTITY_TYPES


# ---------------------------------------------------------------------------
# Section 2: World state per-entity dt fix
# ---------------------------------------------------------------------------

class TestWorldStateTimingFix:
    """Verify the per-entity dt fix prevents velocity spikes."""

    def test_same_frame_face_and_object_no_velocity_spike(self):
        """When faces and objects are updated in the same frame,
        velocity should NOT spike from near-zero dt."""
        ws = WorldState()

        # Create a face track
        from eliza_robot.perception.detectors.face_tracker import FaceTrack
        face = FaceTrack(
            track_id="face_0",
            identity_id="person_0",
            bbox=np.array([100, 100, 200, 200], dtype=np.float32),
            embedding=None,
            confidence=0.9,
            last_seen=time.monotonic(),
        )

        from eliza_robot.perception.detectors.object_tracker import TrackedObject
        obj = TrackedObject(
            track_id=1,
            bbox=np.array([300, 100, 400, 200], dtype=np.float32),
            class_id=56,
            class_name="chair",
            confidence=0.8,
        )

        # First update to establish entities
        ws.update_from_faces([face])
        ws.update_from_objects([obj])

        # Now update both in the same frame (the bug scenario)
        time.sleep(0.05)  # small dt
        face.bbox = np.array([105, 100, 205, 200], dtype=np.float32)
        obj.bbox = np.array([305, 100, 405, 200], dtype=np.float32)

        ws.update_from_faces([face])
        ws.update_from_objects([obj])

        # Check velocities are reasonable (not inf/huge)
        for entity in ws.entity_list:
            vel_mag = np.linalg.norm(entity.velocity)
            assert vel_mag < 50.0, (
                f"Velocity spike detected: {vel_mag:.1f} m/s for {entity.entity_id}"
            )

    def test_first_update_uses_default_dt(self):
        """First entity update should use default dt (0.033), not 0."""
        ws = WorldState()
        from eliza_robot.perception.detectors.face_tracker import FaceTrack
        face = FaceTrack(
            track_id="face_0",
            identity_id="p0",
            bbox=np.array([100, 100, 200, 200], dtype=np.float32),
            embedding=None,
            confidence=0.9,
            last_seen=time.monotonic(),
        )
        ws.update_from_faces([face])
        entity = ws.entities.get("person_p0")
        assert entity is not None
        # First update: velocity should be zero (no prior position)
        assert np.linalg.norm(entity.velocity) < 1e-6


# ---------------------------------------------------------------------------
# Section 3: Face recognizer gallery cap & embedding normalization
# ---------------------------------------------------------------------------

class TestFaceRecognizerFixes:
    def test_gallery_cap_enforced(self):
        """Gallery should not grow beyond MAX_GALLERY_SIZE."""
        rec = FaceRecognizer(recognition_threshold=0.99)  # very high threshold → always enroll
        for i in range(FaceRecognizer.MAX_GALLERY_SIZE + 50):
            emb = np.random.randn(512).astype(np.float32)
            emb = emb / np.linalg.norm(emb)  # unit vector
            det = FaceDetection(
                bbox=np.array([0, 0, 100, 100], dtype=np.float32),
                confidence=0.9,
                landmarks=np.zeros((5, 2), dtype=np.float32),
                embedding=emb,
            )
            rec.recognize(det)
        assert rec.gallery_size <= FaceRecognizer.MAX_GALLERY_SIZE

    def test_embedding_stays_normalized_after_updates(self):
        """Running mean embedding should stay approximately unit length."""
        rec = FaceRecognizer(recognition_threshold=0.3)
        base_emb = np.random.randn(512).astype(np.float32)
        base_emb = base_emb / np.linalg.norm(base_emb)

        # First enrollment
        det = FaceDetection(
            bbox=np.array([0, 0, 100, 100], dtype=np.float32),
            confidence=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
            embedding=base_emb.copy(),
        )
        identity_id, _ = rec.recognize(det)

        # 100 updates with slightly noisy embeddings
        for _ in range(100):
            noisy = base_emb + np.random.randn(512).astype(np.float32) * 0.05
            det2 = FaceDetection(
                bbox=np.array([0, 0, 100, 100], dtype=np.float32),
                confidence=0.9,
                landmarks=np.zeros((5, 2), dtype=np.float32),
                embedding=noisy,
            )
            rec.recognize(det2)

        # Check gallery embedding is still ~unit length
        identity = rec.get_identity(identity_id)
        norm = np.linalg.norm(identity.embedding)
        assert 0.95 < norm < 1.05, f"Embedding drift: norm={norm:.4f}"

    def test_null_embedding_no_gallery_entry(self):
        """Detection without embedding should NOT create gallery entries."""
        rec = FaceRecognizer()
        det = FaceDetection(
            bbox=np.array([0, 0, 100, 100], dtype=np.float32),
            confidence=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
            embedding=None,
        )
        identity_id, score = rec.recognize(det)
        assert identity_id == ""
        assert rec.gallery_size == 0


# ---------------------------------------------------------------------------
# Section 4: Face tracker ghost prediction
# ---------------------------------------------------------------------------

class TestFaceTrackerGhostPrediction:
    def test_ghost_bbox_shifts_by_velocity(self):
        """Ghost tracks should predict position using velocity."""
        tracker = FaceTracker(
            max_ghost_frames=10,
            iou_weight=1.0,
            embedding_weight=0.0,
        )
        # First detection at (100, 100, 200, 200)
        det1 = FaceDetection(
            bbox=np.array([100, 100, 200, 200], dtype=np.float32),
            confidence=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
        )
        tracks = tracker.update([det1])
        tid = tracks[0].track_id

        # Second detection shifted right by 20px
        det2 = FaceDetection(
            bbox=np.array([120, 100, 220, 200], dtype=np.float32),
            confidence=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
        )
        tracks = tracker.update([det2])
        track = [t for t in tracker.all_tracks if t.track_id == tid][0]
        assert track.velocity[0] == pytest.approx(20.0, abs=1.0)

        # Now the face disappears — ghost should predict shifted bbox
        tracker.update([])  # empty frame
        ghost = [t for t in tracker.all_tracks if t.track_id == tid]
        assert len(ghost) == 1
        # Ghost bbox center should be shifted by velocity
        ghost_cx = (ghost[0].bbox[0] + ghost[0].bbox[2]) / 2
        # After 2nd detection, center was at 170. After 1 ghost frame, should be ~190
        assert ghost_cx > 180, f"Ghost center should shift right, got {ghost_cx}"

    def test_ghost_confidence_decays(self):
        """Ghost tracks should have decaying confidence."""
        tracker = FaceTracker(max_ghost_frames=10, iou_weight=1.0, embedding_weight=0.0)
        det = FaceDetection(
            bbox=np.array([100, 100, 200, 200], dtype=np.float32),
            confidence=0.9,
            landmarks=np.zeros((5, 2), dtype=np.float32),
        )
        tracker.update([det])
        tid = tracker.all_tracks[0].track_id
        initial_conf = tracker.all_tracks[0].confidence

        # 5 missed frames
        for _ in range(5):
            tracker.update([])
        ghost = [t for t in tracker.all_tracks if t.track_id == tid]
        assert len(ghost) == 1
        assert ghost[0].confidence < initial_conf


# ---------------------------------------------------------------------------
# Section 5: Shared utility functions
# ---------------------------------------------------------------------------

class TestSharedUtils:
    def test_cosine_similarity_unit_vectors(self):
        a = np.array([1, 0, 0], dtype=np.float32)
        b = np.array([0, 1, 0], dtype=np.float32)
        assert cosine_similarity(a, b) == pytest.approx(0.0, abs=1e-6)

    def test_cosine_similarity_same_vector(self):
        v = np.random.randn(512).astype(np.float32)
        assert cosine_similarity(v, v) == pytest.approx(1.0, abs=1e-4)

    def test_cosine_similarity_none_inputs(self):
        v = np.random.randn(512).astype(np.float32)
        assert cosine_similarity(None, v) == 0.0
        assert cosine_similarity(v, None) == 0.0
        assert cosine_similarity(None, None) == 0.0

    def test_bbox_iou_identical(self):
        box = np.array([0, 0, 100, 100], dtype=np.float32)
        assert bbox_iou(box, box) == pytest.approx(1.0, abs=1e-6)

    def test_bbox_iou_no_overlap(self):
        a = np.array([0, 0, 50, 50], dtype=np.float32)
        b = np.array([100, 100, 200, 200], dtype=np.float32)
        assert bbox_iou(a, b) == 0.0

    def test_bbox_iou_partial(self):
        a = np.array([0, 0, 100, 100], dtype=np.float32)
        b = np.array([50, 50, 150, 150], dtype=np.float32)
        expected = 2500.0 / 17500.0
        assert bbox_iou(a, b) == pytest.approx(expected, abs=1e-4)


# ---------------------------------------------------------------------------
# Section 6: Coordinate transform numerical validation
# ---------------------------------------------------------------------------

class TestCoordinateTransformNumerical:
    """Verify camera-to-robot transform with specific points."""

    def test_camera_forward_maps_to_robot_forward(self):
        """Camera Z (forward) → Robot X (forward)."""
        ws = WorldState()
        cam_point = np.array([0.0, 0.0, 2.0])  # 2m forward in cam
        robot_point = ws.camera_to_robot(cam_point)
        # Should map to +X in robot frame (plus head offset)
        assert robot_point[0] > 1.5, f"Expected +X, got {robot_point}"
        assert abs(robot_point[1]) < 0.1  # ~centered in Y

    def test_camera_right_maps_to_robot_neg_y(self):
        """Camera X (right) → Robot -Y (right)."""
        ws = WorldState()
        cam_point = np.array([1.0, 0.0, 2.0])  # 1m right, 2m forward
        robot_point = ws.camera_to_robot(cam_point)
        assert robot_point[1] < -0.5, f"Expected -Y (right), got {robot_point}"

    def test_camera_down_maps_to_robot_neg_z(self):
        """Camera Y (down) → Robot -Z (below)."""
        ws = WorldState()
        cam_point = np.array([0.0, 1.0, 2.0])  # 1m down, 2m forward
        robot_point = ws.camera_to_robot(cam_point)
        # Should map to -Z relative to head, but head is 0.3m up
        assert robot_point[2] < 0.3, f"Expected below head, got {robot_point}"

    def test_pan_90_rotates_forward_to_left(self):
        """90° pan (look left): camera forward → robot left (+Y)."""
        ws = WorldState()
        ws.set_head_pose(pan=np.pi / 2, tilt=0.0)
        cam_point = np.array([0.0, 0.0, 2.0])  # 2m forward in cam
        robot_point = ws.camera_to_robot(cam_point)
        assert robot_point[1] > 1.5, f"Expected +Y (left), got {robot_point}"

    def test_identity_transform_at_zero_pose(self):
        """Zero pan/tilt: (0,0,Z) in cam → (+X,0,+Z) in robot (approx)."""
        ws = WorldState()
        cam_point = np.array([0.0, 0.0, 3.0])
        robot_point = ws.camera_to_robot(cam_point)
        np.testing.assert_allclose(robot_point[0], 3.0 + 0.03, atol=0.01)
        np.testing.assert_allclose(robot_point[1], 0.0, atol=0.01)
        np.testing.assert_allclose(robot_point[2], 0.30, atol=0.01)


# ---------------------------------------------------------------------------
# Section 7: Sim-real slot parity
# ---------------------------------------------------------------------------

class TestSimRealSlotParity:
    """Verify sim and real encoders produce matching slot format."""

    def test_slot_format_matches(self):
        """An entity at (2, 1, 0.5) should encode the same way in both paths."""
        import jax.numpy as jp

        # Real path: create entity and encode
        entity = PersistentEntity(
            entity_id="test_0",
            entity_type=EntityType.PERSON,
            position=np.array([2.0, 1.0, 0.5], dtype=np.float32),
            velocity=np.zeros(3, dtype=np.float32),
            size=np.array([0.5, 1.7, 0.3], dtype=np.float32),
            confidence=1.0,
            last_seen=time.monotonic(),
        )
        real_slots = encode_entity_slots([entity])

        # Sim path: encode same entity
        from eliza_robot.perception.entity_slots.sim_provider import sim_entity_slots_jax
        sim_slots = sim_entity_slots_jax(
            robot_pos=jp.array([0.0, 0.0, 0.0]),
            robot_yaw=jp.float32(0.0),
            entity_positions=jp.array([[2.0, 1.0, 0.5]]),
            entity_types=jp.array([int(EntityType.PERSON)]),
            entity_sizes=jp.array([[0.5, 1.7, 0.3]]),
        )
        sim_slots = np.array(sim_slots)

        # First slot should match (both have 1 entity at same position)
        real_slot = real_slots[:SLOT_DIM]
        sim_slot = sim_slots[:SLOT_DIM]

        # Type one-hot should match
        np.testing.assert_allclose(
            real_slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES],
            sim_slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES],
            atol=1e-4,
        )
        # Position should match
        np.testing.assert_allclose(
            real_slot[POSITION_OFFSET:POSITION_OFFSET + 3],
            sim_slot[POSITION_OFFSET:POSITION_OFFSET + 3],
            atol=1e-4,
        )
        # Size should match
        np.testing.assert_allclose(
            real_slot[SIZE_OFFSET:SIZE_OFFSET + 3],
            sim_slot[SIZE_OFFSET:SIZE_OFFSET + 3],
            atol=1e-4,
        )
        # Bearing should match
        np.testing.assert_allclose(
            real_slot[BEARING_OFFSET:BEARING_OFFSET + 2],
            sim_slot[BEARING_OFFSET:BEARING_OFFSET + 2],
            atol=1e-4,
        )

    def test_person_priority_matches(self):
        """Both paths should sort persons before objects."""
        import jax.numpy as jp
        from eliza_robot.perception.entity_slots.sim_provider import sim_entity_slots_jax

        # Real: person at 3m, object at 1m — person should still be first
        person = PersistentEntity(
            entity_id="p0", entity_type=EntityType.PERSON,
            position=np.array([3.0, 0.0, 0.0], dtype=np.float32),
            size=np.array([0.5, 1.7, 0.3], dtype=np.float32),
            confidence=0.9, last_seen=time.monotonic(),
        )
        obj = PersistentEntity(
            entity_id="o0", entity_type=EntityType.OBJECT,
            position=np.array([1.0, 0.0, 0.0], dtype=np.float32),
            size=np.array([0.3, 0.3, 0.3], dtype=np.float32),
            confidence=0.9, last_seen=time.monotonic(),
        )
        real_slots = encode_entity_slots([obj, person])  # note: object first in list

        # First slot should be person (type one-hot index 1)
        slot0_type = real_slots[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert slot0_type[int(EntityType.PERSON)] > 0.5, "First slot should be PERSON"

        # Sim path
        sim_slots = sim_entity_slots_jax(
            robot_pos=jp.array([0.0, 0.0, 0.0]),
            robot_yaw=jp.float32(0.0),
            entity_positions=jp.array([[1.0, 0.0, 0.0], [3.0, 0.0, 0.0]]),
            entity_types=jp.array([int(EntityType.OBJECT), int(EntityType.PERSON)]),
            entity_sizes=jp.array([[0.3, 0.3, 0.3], [0.5, 1.7, 0.3]]),
        )
        sim_slots = np.array(sim_slots)
        sim_slot0_type = sim_slots[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert sim_slot0_type[int(EntityType.PERSON)] > 0.5, "Sim first slot should be PERSON"


# ---------------------------------------------------------------------------
# Section 8: Walkable map vectorized correctness
# ---------------------------------------------------------------------------

class TestWalkableMapVectorized:
    """Verify vectorized update matches expected behavior."""

    def test_floor_points_decrease_occupancy(self):
        from eliza_robot.perception.world_model.walkable_map import WalkableMapBuilder
        builder = WalkableMapBuilder(grid_size=2.0, resolution=0.1)
        # Floor point at origin
        pts = np.array([[0.0, 0.0, 0.0]], dtype=np.float32)
        builder.update(pts)
        grid = builder.get_grid()
        row, col = grid.world_to_cell(0.0, 0.0)
        assert grid.grid[row, col] < 0.5  # decreased from 0.5 (unknown)

    def test_obstacle_points_increase_occupancy(self):
        from eliza_robot.perception.world_model.walkable_map import WalkableMapBuilder
        builder = WalkableMapBuilder(grid_size=2.0, resolution=0.1)
        # Obstacle at height 0.1m
        pts = np.array([[0.0, 0.0, 0.1]], dtype=np.float32)
        builder.update(pts)
        grid = builder.get_grid()
        row, col = grid.world_to_cell(0.0, 0.0)
        assert grid.grid[row, col] > 0.5  # increased from 0.5

    def test_many_points_vectorized_no_error(self):
        from eliza_robot.perception.world_model.walkable_map import WalkableMapBuilder
        builder = WalkableMapBuilder(grid_size=4.0, resolution=0.05)
        # 10000 random points
        pts = np.random.randn(10000, 3).astype(np.float32) * 1.5
        pts[:, 2] = np.abs(pts[:, 2]) * 0.3  # z in [0, 0.3]
        builder.update(pts)
        grid = builder.get_grid()
        assert np.all(grid.grid >= 0.0)
        assert np.all(grid.grid <= 1.0)

    def test_out_of_bounds_points_ignored(self):
        from eliza_robot.perception.world_model.walkable_map import WalkableMapBuilder
        builder = WalkableMapBuilder(grid_size=2.0, resolution=0.1)
        # Point way outside grid
        pts = np.array([[100.0, 100.0, 0.0]], dtype=np.float32)
        builder.update(pts)  # should not crash
        grid = builder.get_grid()
        # All cells should still be at 0.5 (unknown)
        assert np.allclose(grid.grid, 0.5)


# ---------------------------------------------------------------------------
# Section 9: Config YAML loading with field validation
# ---------------------------------------------------------------------------

class TestConfigFieldValidation:
    def test_invalid_detector_field_ignored(self):
        """Unknown fields in YAML should be silently ignored."""
        import tempfile
        from pathlib import Path
        from eliza_robot.perception.config import load_config

        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            f.write("detector:\n  face_confidence: 0.7\n  nonexistent_field: 42\n")
            f.flush()
            cfg = load_config(Path(f.name))
            assert cfg.detector.face_confidence == 0.7
            assert not hasattr(cfg.detector, 'nonexistent_field')

    def test_camera_defaults_from_intrinsics(self):
        """CameraConfig defaults should match CameraIntrinsics defaults."""
        from eliza_robot.perception.config import CameraConfig
        cc = CameraConfig()
        ci = CameraIntrinsics()
        assert cc.fx == ci.fx
        assert cc.fy == ci.fy
        assert cc.cx == ci.cx
        assert cc.cy == ci.cy
        assert cc.width == ci.width
        assert cc.height == ci.height


# ---------------------------------------------------------------------------
# Section 10: Depth estimator fallback behavior
# ---------------------------------------------------------------------------

class TestDepthEstimatorFallback:
    def test_fallback_produces_valid_depth(self):
        from eliza_robot.perception.detectors.depth_estimator import DepthEstimator
        de = DepthEstimator()  # Will use fallback (no weights)
        if not de.is_available:
            frame = np.zeros((480, 640, 3), dtype=np.uint8)
            result = de.estimate(frame)
            assert result.depth_map.shape == (480, 640)
            assert result.confidence == 0.1  # low confidence for fallback
            assert np.all(result.depth_map == 2.0)

    def test_roi_depth_handles_empty_roi(self):
        from eliza_robot.perception.detectors.depth_estimator import DepthResult
        depth_map = np.ones((100, 100), dtype=np.float32)
        result = DepthResult(depth_map=depth_map, confidence=0.9)
        # Zero-area bbox
        val = result.roi_depth(np.array([50, 50, 50, 50]))
        assert val == 0.0

    def test_roi_depth_uses_lower_quantile(self):
        from eliza_robot.perception.detectors.depth_estimator import DepthResult
        depth_map = np.ones((100, 100), dtype=np.float32)
        # Create a gradient: foreground at 1m, background at 5m
        depth_map[40:60, 40:60] = 1.0
        depth_map[60:80, 40:60] = 5.0
        result = DepthResult(depth_map=depth_map, confidence=0.9)
        roi = np.array([40, 40, 60, 80])  # spans both 1m and 5m
        val = result.roi_depth(roi, quantile=0.3)
        assert val < 3.0, "Lower quantile should prefer closer depth"


# ---------------------------------------------------------------------------
# Section 11: Entity type classification completeness
# ---------------------------------------------------------------------------

class TestEntityTypeClassification:
    def test_person(self):
        assert classify_entity_type("person") == EntityType.PERSON

    def test_furniture_variants(self):
        for label in ["chair", "couch", "bed", "dining table", "toilet", "bench", "desk"]:
            assert classify_entity_type(label) == EntityType.FURNITURE, f"Failed for {label}"

    def test_door(self):
        assert classify_entity_type("door") == EntityType.DOOR

    def test_landmarks(self):
        for label in ["wall", "floor", "ceiling", "pillar", "column"]:
            assert classify_entity_type(label) == EntityType.LANDMARK, f"Failed for {label}"

    def test_unknown(self):
        assert classify_entity_type("unknown") == EntityType.UNKNOWN

    def test_generic_object(self):
        assert classify_entity_type("cup") == EntityType.OBJECT
        assert classify_entity_type("bottle") == EntityType.OBJECT

    def test_case_insensitive(self):
        assert classify_entity_type("PERSON") == EntityType.PERSON
        assert classify_entity_type("Chair") == EntityType.FURNITURE
