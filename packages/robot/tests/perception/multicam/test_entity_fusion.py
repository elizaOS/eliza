"""Tests for multi-camera entity fusion."""

from __future__ import annotations

import time

import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.multicam.extrinsics import CameraExtrinsics
from eliza_robot.perception.multicam.entity_fusion import FusedWorldState, _linear_sum_assignment
from eliza_robot.perception.world_model.entity import EntityType, PersistentEntity


def _make_entity(
    entity_id: str = "e1",
    position: tuple[float, float, float] = (1.0, 0.0, 0.0),
    entity_type: EntityType = EntityType.OBJECT,
    confidence: float = 0.8,
) -> PersistentEntity:
    return PersistentEntity(
        entity_id=entity_id,
        entity_type=entity_type,
        position=np.array(position, dtype=np.float32),
        velocity=np.zeros(3, dtype=np.float32),
        size=np.array([0.1, 0.1, 0.1], dtype=np.float32),
        confidence=confidence,
        last_seen=time.monotonic(),
        source="object",
    )


class TestFusedWorldStateInit:
    def test_no_robot_pose_initially(self):
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        assert state.robot_world_pose is None
        assert state.robot_world_position is None


class TestEgoUpdate:
    def test_single_entity_preserves_position(self):
        """Ego entity without robot world pose stays in robot frame."""
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        entity = _make_entity("e1", (2.0, 1.0, 0.0))
        state.update_from_ego([entity], robot_head_pose=(0.0, 0.0))
        fused = state.fuse()

        assert len(fused) == 1
        np.testing.assert_allclose(fused[0].position, [2.0, 1.0, 0.0], atol=1e-5)

    def test_multiple_entities(self):
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        e1 = _make_entity("a", (1.0, 0.0, 0.0))
        e2 = _make_entity("b", (3.0, 0.0, 0.0))
        state.update_from_ego([e1, e2], robot_head_pose=(0.0, 0.0))
        fused = state.fuse()
        assert len(fused) == 2


class TestMaxEntitiesLimit:
    def test_single_source_enforces_limit(self):
        """max_entities must be enforced even with a single camera source."""
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics(), max_entities=3)
        entities = [_make_entity(f"e{i}", (float(i), 0, 0), confidence=0.1 * i) for i in range(10)]
        state.update_from_ego(entities, robot_head_pose=(0.0, 0.0))
        fused = state.fuse()
        assert len(fused) == 3
        # Highest confidence entities should be kept
        confs = [e.confidence for e in fused]
        assert min(confs) >= 0.7  # e7, e8, e9 have conf 0.7, 0.8, 0.9


class TestEntitySlots:
    def test_slot_vector_shape(self):
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        entity = _make_entity("e1", (1.0, 0.5, 0.0))
        state.update_from_ego([entity], robot_head_pose=(0.0, 0.0))
        state.fuse()
        slots = state.get_entity_slots()
        assert slots.shape == (152,)

    def test_empty_state_returns_zeros(self):
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        state.fuse()
        slots = state.get_entity_slots()
        assert slots.shape == (152,)
        assert np.all(slots == 0.0)

    def test_position_encoded_relative_to_robot(self):
        """When robot pose is set, entity positions in slots should be relative."""
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        # Set robot at world position (5, 0, 0)
        robot_pose = np.eye(4, dtype=np.float64)
        robot_pose[0, 3] = 5.0
        state._robot_world_pose = robot_pose

        # Entity at world position (7, 0, 0) → relative (2, 0, 0)
        entity = _make_entity("e1", (7.0, 0.0, 0.0))
        state._ego_entities = {}  # bypass update_from_ego transform
        state._fused_entities = {entity.entity_id: entity}

        slots = state.get_entity_slots()
        # Position is at offsets 6,7,8 in the first slot (after 6-dim type one-hot)
        # Normalized by MAX_DISTANCE (5.0): 2.0/5.0 = 0.4
        assert abs(slots[6] - 0.4) < 0.01


class TestSnapshot:
    def test_snapshot_has_required_fields(self):
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        entity = _make_entity("e1", (1.0, 0.0, 0.0))
        state.update_from_ego([entity], robot_head_pose=(0.0, 0.0))
        state.fuse()

        snap = state.snapshot()
        assert snap["frame"] == "world"
        assert snap["entity_count"] == 1
        assert len(snap["entities"]) == 1
        assert snap["entities"][0]["type"] == "OBJECT"
        assert snap["robot_world_pose"] is None  # no robot pose set
        assert len(snap["entity_slots"]) == 152

    def test_snapshot_with_robot_pose(self):
        state = FusedWorldState(ego_intrinsics=CameraIntrinsics())
        robot_pose = np.eye(4, dtype=np.float64)
        robot_pose[0, 3] = 1.0
        state._robot_world_pose = robot_pose
        state._robot_pose_timestamp = 100.0

        entity = _make_entity("e1", (2.0, 0.0, 0.0))
        state.update_from_ego([entity], robot_head_pose=(0.0, 0.0))
        state.fuse()

        snap = state.snapshot()
        assert snap["robot_world_pose"] is not None
        assert snap["robot_world_pose"]["position"][0] == 1.0


class TestGreedyAssignment:
    def test_simple_assignment(self):
        cost = np.array([
            [1.0, 10.0],
            [10.0, 2.0],
        ])
        rows, cols = _linear_sum_assignment(cost)
        # Optimal: (0,0) cost=1 + (1,1) cost=2 = 3
        assignments = set(zip(rows.tolist(), cols.tolist()))
        assert (0, 0) in assignments
        assert (1, 1) in assignments

    def test_rectangular_matrix(self):
        cost = np.array([
            [1.0, 5.0, 9.0],
            [3.0, 2.0, 8.0],
        ])
        rows, cols = _linear_sum_assignment(cost)
        assert len(rows) == 2  # min(2, 3)
