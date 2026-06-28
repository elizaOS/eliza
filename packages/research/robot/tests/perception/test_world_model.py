"""Tests for world model module."""

from __future__ import annotations

import time

import numpy as np
import pytest

from eliza_robot.perception.calibration import CameraIntrinsics
from eliza_robot.perception.detectors.depth_estimator import DepthResult
from eliza_robot.perception.detectors.face_tracker import FaceTrack
from eliza_robot.perception.detectors.object_tracker import TrackedObject
from eliza_robot.perception.detectors.skeleton_estimator import Skeleton
from eliza_robot.perception.entity_slots.slot_config import EntityType
from eliza_robot.perception.world_model.entity import PersistentEntity, classify_entity_type
from eliza_robot.perception.world_model.world_state import WorldState


class TestPersistentEntity:
    def test_default_position(self):
        e = PersistentEntity(entity_id="test_0")
        np.testing.assert_array_equal(e.position, [0, 0, 0])

    def test_update_position_sets_velocity(self):
        e = PersistentEntity(entity_id="test_0")
        e.last_seen = time.monotonic()
        e.frames_seen = 1
        new_pos = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        e.update_position(new_pos, dt=1.0)
        assert e.velocity[0] > 0.0

    def test_distance(self):
        e = PersistentEntity(entity_id="test_0")
        e.position = np.array([3.0, 4.0, 0.0], dtype=np.float32)
        assert abs(e.distance - 5.0) < 0.01

    def test_bearing(self):
        e = PersistentEntity(entity_id="test_0")
        e.position = np.array([1.0, 1.0, 0.0], dtype=np.float32)
        bearing = e.bearing_rad
        assert abs(bearing - np.pi / 4) < 0.01


class TestClassifyEntityType:
    def test_person(self):
        assert classify_entity_type("person") == EntityType.PERSON

    def test_chair_is_furniture(self):
        assert classify_entity_type("chair") == EntityType.FURNITURE

    def test_door(self):
        assert classify_entity_type("door") == EntityType.DOOR

    def test_unknown(self):
        assert classify_entity_type("unknown") == EntityType.UNKNOWN

    def test_cup_is_object(self):
        assert classify_entity_type("cup") == EntityType.OBJECT


class TestWorldState:
    def test_empty_initial(self):
        ws = WorldState()
        assert len(ws.entities) == 0
        assert ws.person_count == 0

    def test_face_creates_person_entity(self):
        ws = WorldState()
        track = FaceTrack(
            track_id="face_0",
            identity_id="person_0",
            bbox=np.array([100, 100, 200, 200], dtype=np.float32),
            embedding=np.random.randn(512).astype(np.float32),
            confidence=0.9,
            last_seen=time.monotonic(),
        )
        ws.update_from_faces([track])
        assert ws.person_count == 1

    def test_object_creates_entity(self):
        ws = WorldState()
        obj = TrackedObject(
            track_id=1,
            bbox=np.array([200, 200, 300, 400], dtype=np.float32),
            class_id=56,
            class_name="chair",
            confidence=0.8,
        )
        ws.update_from_objects([obj])
        assert ws.object_count >= 1
        # Check type
        entity = list(ws.entities.values())[0]
        assert entity.entity_type == EntityType.FURNITURE

    def test_stale_pruning(self):
        ws = WorldState(stale_timeout_sec=0.01)
        e = PersistentEntity(
            entity_id="stale_0",
            entity_type=EntityType.OBJECT,
            last_seen=time.monotonic() - 1.0,  # 1 sec ago
        )
        ws._entities["stale_0"] = e
        removed = ws.prune_stale()
        assert removed == 1
        assert len(ws.entities) == 0

    def test_camera_to_world_identity(self):
        ws = WorldState()
        # Default transform (identity rotation, offset)
        cam_pt = np.array([0, 0, 1], dtype=np.float32)
        robot_pt = ws.camera_to_robot(cam_pt)
        assert robot_pt.shape == (3,)

    def test_face_skeleton_association(self):
        ws = WorldState()
        # Add a person via face
        track = FaceTrack(
            track_id="face_0",
            identity_id="person_0",
            bbox=np.array([100, 100, 200, 300], dtype=np.float32),
            embedding=None,
            confidence=0.9,
            last_seen=time.monotonic(),
        )
        ws.update_from_faces([track])

        # Add overlapping skeleton
        skel = Skeleton(
            keypoints=np.zeros((17, 2), dtype=np.float32),
            scores=np.ones(17, dtype=np.float32),
            bbox=np.array([110, 110, 190, 290], dtype=np.float32),
        )
        # Set torso keypoints for center computation
        skel.keypoints[5] = [140, 150]  # left shoulder
        skel.keypoints[6] = [160, 150]  # right shoulder
        skel.keypoints[11] = [140, 250] # left hip
        skel.keypoints[12] = [160, 250] # right hip

        depth = DepthResult(
            depth_map=np.ones((480, 640), dtype=np.float32) * 2.0,
            confidence=0.9,
        )
        ws.update_from_skeletons([skel], depth)
        # Should still be 1 person (skeleton merged with face)
        assert ws.person_count == 1
