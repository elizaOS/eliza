"""End-to-end validation tests — verify real data flows through the full pipeline.

These tests inject synthetic detections at strategic points to validate
the complete data path without requiring ML model libraries.
"""

from __future__ import annotations

import time

import numpy as np
import pytest

from eliza_robot.bridge.openpi_adapter import (
    AINEX_ENTITY_SLOT_DIM,
    AINEX_PROPRIO_DIM,
    AINEX_STATE_DIM,
    build_observation,
)
from eliza_robot.bridge.perception import PerceptionAggregator
from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.depth_estimator import DepthResult
from eliza_robot.perception.detectors.face_tracker import FaceTrack
from eliza_robot.perception.detectors.object_tracker import TrackedObject
from eliza_robot.perception.entity_slots.slot_config import (
    CONFIDENCE_OFFSET,
    EntityType,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    SLOT_DIM,
    TOTAL_ENTITY_DIMS,
    TYPE_OFFSET,
)
from eliza_robot.perception.entity_slots.slot_encoder import encode_entity_slots
from eliza_robot.perception.pipeline import PerceptionPipeline
from eliza_robot.perception.world_model.entity import PersistentEntity
from eliza_robot.perception.world_model.world_state import WorldState


class TestFullDataPath:
    """Trace: WorldState -> entity_slots -> Aggregator -> OpenPI state vector."""

    def test_person_entity_flows_to_openpi_state(self):
        """A detected person should produce non-zero entity slots in the OpenPI state."""
        # 1. Create WorldState and add a face
        ws = WorldState()
        ws.set_head_pose(0.0, 0.0)
        track = FaceTrack(
            track_id="face_0",
            identity_id="person_0",
            bbox=np.array([200, 100, 300, 300], dtype=np.float32),
            embedding=None,
            confidence=0.9,
            last_seen=time.monotonic(),
        )
        depth = DepthResult(
            depth_map=np.ones((480, 640), dtype=np.float32) * 2.0,
            confidence=0.9,
        )
        ws.update_from_faces([track], depth)

        # 2. Encode entity slots
        slots = encode_entity_slots(ws.entity_list)
        assert slots.shape == (TOTAL_ENTITY_DIMS,)
        first_slot = slots[:SLOT_DIM]
        # Should be a PERSON
        type_vec = first_slot[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert type_vec[EntityType.PERSON] == 1.0
        # Should have confidence
        assert first_slot[CONFIDENCE_OFFSET] > 0.5
        # Should have a position
        assert not np.allclose(first_slot[POSITION_OFFSET:POSITION_OFFSET + 3], 0.0)

        # 3. Feed to aggregator
        agg = PerceptionAggregator()
        agg.update_entity_slots(tuple(float(x) for x in slots))

        # 4. Build OpenPI observation
        snap = agg.snapshot()
        obs = build_observation(snap)
        assert len(obs.state) == AINEX_STATE_DIM

        # 5. Verify entity slot values propagated
        entity_part = obs.state[AINEX_PROPRIO_DIM:]
        assert len(entity_part) == AINEX_ENTITY_SLOT_DIM
        non_zero = sum(1 for v in entity_part if abs(v) > 0.001)
        assert non_zero > 0, "Entity slots should be non-zero after person detection"

    def test_multiple_entities_sorted_correctly(self):
        """Multiple entities should sort persons before objects."""
        # Create person at 3m and object at 1m
        person = PersistentEntity(entity_id="p0", entity_type=EntityType.PERSON)
        person.position = np.array([3.0, 0.0, 0.0], dtype=np.float32)
        person.confidence = 0.9
        person.last_seen = time.monotonic()
        person.size = np.array([0.5, 1.7, 0.3], dtype=np.float32)

        obj = PersistentEntity(entity_id="o0", entity_type=EntityType.OBJECT)
        obj.position = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        obj.confidence = 0.8
        obj.last_seen = time.monotonic()
        obj.size = np.array([0.2, 0.2, 0.2], dtype=np.float32)

        # Object first in list, but person should sort first
        slots = encode_entity_slots([obj, person])
        first_type = slots[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert first_type[EntityType.PERSON] == 1.0
        second_type = slots[SLOT_DIM + TYPE_OFFSET:SLOT_DIM + TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert second_type[EntityType.OBJECT] == 1.0

    def test_object_entity_with_depth(self):
        """Object detected with depth creates entity at correct 3D position."""
        ws = WorldState()
        ws.set_head_pose(0.0, 0.0)
        obj = TrackedObject(
            track_id=1,
            bbox=np.array([310, 230, 330, 250], dtype=np.float32),  # near center
            class_id=56,
            class_name="chair",
            confidence=0.8,
        )
        depth = DepthResult(
            depth_map=np.ones((480, 640), dtype=np.float32) * 3.0,  # 3m
            confidence=0.9,
        )
        ws.update_from_objects([obj], depth)
        entities = ws.entity_list
        assert len(entities) == 1
        e = entities[0]
        assert e.entity_type == EntityType.FURNITURE
        # Position should be approximately 3m forward (camera center -> robot X)
        assert e.position[0] > 2.0, f"Expected x > 2m, got {e.position[0]}"

    def test_stale_entities_produce_zero_slots(self):
        """After entities go stale, slots should return to zero."""
        ws = WorldState(stale_timeout_sec=0.01)
        e = PersistentEntity(entity_id="old", entity_type=EntityType.PERSON)
        e.position = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        e.confidence = 0.9
        e.last_seen = time.monotonic() - 1.0  # 1 sec ago
        e.size = np.array([0.5, 1.7, 0.3], dtype=np.float32)
        ws._entities["old"] = e
        ws.prune_stale()
        slots = encode_entity_slots(ws.entity_list)
        assert np.allclose(slots, 0.0)


class TestPipelineAggregatorWiring:
    """Verify that connect_aggregator actually wires the data."""

    def test_connect_aggregator_feeds_slots(self):
        pipeline = PerceptionPipeline()
        agg = PerceptionAggregator()
        pipeline.connect_aggregator(agg)

        # Inject entity directly into world state
        e = PersistentEntity(entity_id="test_0", entity_type=EntityType.PERSON)
        e.position = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        e.confidence = 0.9
        e.last_seen = time.monotonic()
        e.size = np.array([0.5, 1.7, 0.3], dtype=np.float32)
        e.label = "person"
        e.source = "face"
        pipeline.world_state._entities["test_0"] = e

        # Process a frame
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        pipeline.process_frame(frame)

        # Aggregator should now have non-zero entity slots
        snap = agg.snapshot()
        non_zero = sum(1 for v in snap.entity_slots if abs(v) > 0.001)
        assert non_zero > 0, "Entity slots should flow from pipeline to aggregator"

    def test_connect_aggregator_feeds_entities(self):
        pipeline = PerceptionPipeline()
        agg = PerceptionAggregator()
        pipeline.connect_aggregator(agg)

        # Inject entity
        e = PersistentEntity(entity_id="obj_0", entity_type=EntityType.OBJECT)
        e.position = np.array([2.0, 1.0, 0.0], dtype=np.float32)
        e.confidence = 0.8
        e.last_seen = time.monotonic()
        e.size = np.array([0.3, 0.3, 0.3], dtype=np.float32)
        e.label = "cup"
        e.source = "object"
        pipeline.world_state._entities["obj_0"] = e

        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        pipeline.process_frame(frame)

        summary = agg.scene_summary()
        assert summary["entity_count"] >= 1


class TestSimRealEquivalence:
    """Verify sim and real encoders produce equivalent outputs."""

    def test_same_entity_same_encoding(self):
        """Identical entity config should produce matching slots from both encoders."""
        jax = pytest.importorskip("jax")
        import jax.numpy as jp
        from eliza_robot.perception.entity_slots.sim_provider import sim_entity_slots_jax

        # Real encoder
        e = PersistentEntity(entity_id="p0", entity_type=EntityType.PERSON)
        e.position = np.array([2.0, 1.0, 0.5], dtype=np.float32)
        e.velocity = np.zeros(3, dtype=np.float32)
        e.size = np.array([0.5, 1.7, 0.3], dtype=np.float32)
        e.confidence = 1.0  # match sim's GT confidence
        e.last_seen = time.monotonic()
        real = encode_entity_slots([e])

        # Sim encoder
        sim = np.array(sim_entity_slots_jax(
            jp.zeros(3), jp.float32(0.0),
            jp.array([[2.0, 1.0, 0.5]]),
            jp.array([EntityType.PERSON]),
            jp.array([[0.5, 1.7, 0.3]]),
        ))

        # Compare all fields except recency (timing-dependent)
        for i in range(SLOT_DIM):
            if i == 16:  # recency — skip, timing-dependent
                continue
            assert abs(real[i] - sim[i]) < 0.01, \
                f"Mismatch at index {i}: real={real[i]:.4f} sim={sim[i]:.4f}"

    def test_sorting_matches(self):
        """Entity sorting should be identical between real and sim encoders."""
        jax = pytest.importorskip("jax")
        import jax.numpy as jp
        from eliza_robot.perception.entity_slots.sim_provider import sim_entity_slots_jax

        # Two entities: person far, object close
        p = PersistentEntity(entity_id="p0", entity_type=EntityType.PERSON)
        p.position = np.array([3.0, 0.0, 0.0], dtype=np.float32)
        p.confidence = 1.0
        p.last_seen = time.monotonic()
        p.size = np.array([0.5, 1.7, 0.3], dtype=np.float32)

        o = PersistentEntity(entity_id="o0", entity_type=EntityType.OBJECT)
        o.position = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        o.confidence = 1.0
        o.last_seen = time.monotonic()
        o.size = np.array([0.3, 0.3, 0.3], dtype=np.float32)

        real = encode_entity_slots([o, p])
        sim = np.array(sim_entity_slots_jax(
            jp.zeros(3), jp.float32(0.0),
            jp.array([[3.0, 0.0, 0.0], [1.0, 0.0, 0.0]]),
            jp.array([EntityType.PERSON, EntityType.OBJECT]),
            jp.array([[0.5, 1.7, 0.3], [0.3, 0.3, 0.3]]),
        ))

        # Both should have PERSON in slot 0
        real_type = real[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        sim_type = sim[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert real_type[EntityType.PERSON] == 1.0
        assert sim_type[EntityType.PERSON] == 1.0
