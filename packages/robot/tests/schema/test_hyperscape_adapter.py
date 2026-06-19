"""Tests for eliza_robot.schema.hyperscape_adapter."""

from __future__ import annotations

import math
import pytest

from eliza_robot.schema.hyperscape_adapter import (
    HYPERSCAPE_TYPE_MAP,
    _GAME_TYPE_TO_GENERIC,
    adapt_hyperscape_entities,
    coordinate_game_to_robot,
    map_entity_type,
    normalize_hyperscape_snapshot,
    transform_game_position,
)
from eliza_robot.schema.embodied_context import ContextEntity


# ---------------------------------------------------------------------------
# Entity type mapping
# ---------------------------------------------------------------------------

class TestEntityTypeMapping:
    """Verify that all game types map to valid generic types."""

    VALID_GENERIC_TYPES = {"person", "object", "landmark", "door", "furniture", "unknown"}

    def test_all_mapped_types_are_valid(self) -> None:
        """Every value in the mapping must be one of the known generic types."""
        for game_type, generic_type in _GAME_TYPE_TO_GENERIC.items():
            assert generic_type in self.VALID_GENERIC_TYPES, (
                f"Game type '{game_type}' maps to invalid generic type '{generic_type}'"
            )

    def test_hyperscape_type_map_alias_is_consistent(self) -> None:
        """HYPERSCAPE_TYPE_MAP (if exposed) should be the same dict."""
        # The module exposes both _GAME_TYPE_TO_GENERIC and HYPERSCAPE_TYPE_MAP
        # via the public interface. Verify the public map has valid values.
        if HYPERSCAPE_TYPE_MAP:
            for game_type, generic_type in HYPERSCAPE_TYPE_MAP.items():
                assert generic_type in self.VALID_GENERIC_TYPES

    def test_person_types(self) -> None:
        assert map_entity_type("player") == "person"
        assert map_entity_type("npc") == "person"
        assert map_entity_type("merchant") == "person"
        assert map_entity_type("guard") == "person"
        assert map_entity_type("monster") == "person"
        assert map_entity_type("goblin") == "person"

    def test_object_types(self) -> None:
        assert map_entity_type("resource") == "object"
        assert map_entity_type("item") == "object"
        assert map_entity_type("chest") == "object"
        assert map_entity_type("ore") == "object"
        assert map_entity_type("herb") == "object"
        assert map_entity_type("fish") == "object"

    def test_landmark_types(self) -> None:
        assert map_entity_type("bank") == "landmark"
        assert map_entity_type("shop") == "landmark"
        assert map_entity_type("tavern") == "landmark"
        assert map_entity_type("building") == "landmark"
        assert map_entity_type("tree") == "landmark"
        assert map_entity_type("rock") == "landmark"

    def test_door_types(self) -> None:
        assert map_entity_type("door") == "door"
        assert map_entity_type("gate") == "door"
        assert map_entity_type("portal") == "door"

    def test_unknown_types_map_to_unknown(self) -> None:
        assert map_entity_type("xyzzy") == "unknown"
        assert map_entity_type("") == "unknown"
        assert map_entity_type("NONEXISTENT_TYPE") == "unknown"
        assert map_entity_type("dragon") == "unknown"

    def test_case_insensitive(self) -> None:
        assert map_entity_type("Player") == "person"
        assert map_entity_type("TREE") == "landmark"
        assert map_entity_type("Door") == "door"


# ---------------------------------------------------------------------------
# Coordinate transform
# ---------------------------------------------------------------------------

class TestCoordinateTransform:
    """Verify game Y-up to canonical Z-up coordinate transform."""

    def test_transform_game_position_identity(self) -> None:
        """Origin maps to origin."""
        result = transform_game_position([0, 0, 0])
        assert result == (0.0, 0.0, 0.0)

    def test_transform_game_position_y_up_to_z_up(self) -> None:
        """Game Y-up (0, 5, 0) should have the 'up' component in Z."""
        result = transform_game_position([0, 5, 0])
        # X_can = X_game = 0, Y_can = -Z_game = 0, Z_can = Y_game = 5
        assert result == (0.0, 0.0, 5.0)

    def test_transform_game_position_forward(self) -> None:
        """Game Z-forward (0, 0, 3) should map to Y-back."""
        result = transform_game_position([0, 0, 3])
        # X_can = 0, Y_can = -3, Z_can = 0
        assert result == (0.0, -3.0, 0.0)

    def test_transform_game_position_right(self) -> None:
        """Game X-right (2, 0, 0) should map to X."""
        result = transform_game_position([2, 0, 0])
        assert result == (2.0, 0.0, 0.0)

    def test_transform_game_position_dict_input(self) -> None:
        """Accept dict input with x/y/z keys."""
        result = transform_game_position({"x": 1.0, "y": 2.0, "z": 3.0})
        assert result == (1.0, -3.0, 2.0)

    def test_coordinate_game_to_robot_identity(self) -> None:
        """Robot frame: origin maps to origin."""
        result = coordinate_game_to_robot([0, 0, 0])
        assert result == (0.0, 0.0, 0.0)

    def test_coordinate_game_to_robot_forward(self) -> None:
        """Game Z-forward (0, 0, 5) -> robot X-forward (5, 0, 0)."""
        result = coordinate_game_to_robot([0, 0, 5])
        assert result == (5.0, 0.0, 0.0)

    def test_coordinate_game_to_robot_up(self) -> None:
        """Game Y-up (0, 3, 0) -> robot Z-up (0, 0, 3)."""
        result = coordinate_game_to_robot([0, 3, 0])
        assert result == (0.0, 0.0, 3.0)

    def test_coordinate_game_to_robot_right(self) -> None:
        """Game X-right (2, 0, 0) -> robot Y-left (0, -2, 0)."""
        result = coordinate_game_to_robot([2, 0, 0])
        assert result == (0.0, -2.0, 0.0)

    def test_coordinate_game_to_robot_dict_input(self) -> None:
        """Accept dict input."""
        result = coordinate_game_to_robot({"x": 1.0, "y": 2.0, "z": 3.0})
        assert result == (3.0, -1.0, 2.0)

    def test_coordinate_game_to_robot_short_list(self) -> None:
        """Two-element list should be handled gracefully."""
        result = coordinate_game_to_robot([4.0, 5.0])
        # gx=4, gy=0, gz=5 -> (gz=5, -gx=-4, gy=0)
        assert result == (5.0, -4.0, 0.0)

    def test_coordinate_game_to_robot_empty(self) -> None:
        """Empty input should return origin."""
        result = coordinate_game_to_robot([])
        assert result == (0.0, 0.0, 0.0)


# ---------------------------------------------------------------------------
# normalize_hyperscape_snapshot
# ---------------------------------------------------------------------------

class TestNormalizeSnapshot:
    """Test full snapshot normalization."""

    def _make_snapshot(self, **overrides: object) -> dict:
        base: dict = {
            "timestamp": 1000.0,
            "player": {
                "position": [1, 2, 3],
                "yaw": 0.5,
                "isWalking": True,
                "health": 100,
                "maxHealth": 100,
                "level": 42,
            },
            "entities": [
                {
                    "id": "goblin-1",
                    "type": "goblin",
                    "name": "Angry Goblin",
                    "position": [5, 0, 10],
                    "health": 30,
                },
                {
                    "id": "tree-1",
                    "type": "tree",
                    "name": "Oak Tree",
                    "position": [3, 0, 7],
                },
                {
                    "id": "door-1",
                    "type": "door",
                    "name": "Wooden Door",
                    "position": [2, 0, 5],
                },
            ],
            "taskDescription": "Kill the goblin",
        }
        base.update(overrides)
        return base

    def test_basic_snapshot(self) -> None:
        snapshot = self._make_snapshot()
        result = normalize_hyperscape_snapshot(snapshot)

        assert result["source"] == "hyperscape"
        assert result["schema_version"] == "1.0"
        assert result["timestamp"] == 1000.0
        assert result["is_walking"] is True
        assert result["task_description"] == "Kill the goblin"
        assert result["battery_mv"] == 0  # game has no battery
        assert result["imu_roll"] == 0.0  # game has no IMU

    def test_entities_are_normalized(self) -> None:
        snapshot = self._make_snapshot()
        result = normalize_hyperscape_snapshot(snapshot)

        entities = result["entities"]
        assert len(entities) == 3

        # Goblin should be mapped to person
        goblin = entities[0]
        assert goblin["entity_type"] == "person"
        assert goblin["label"] == "Angry Goblin"
        assert goblin["source"] == "game"

        # Tree should be mapped to landmark
        tree = entities[1]
        assert tree["entity_type"] == "landmark"

        # Door should be mapped to door
        door = entities[2]
        assert door["entity_type"] == "door"

    def test_agent_position_transformed(self) -> None:
        snapshot = self._make_snapshot()
        result = normalize_hyperscape_snapshot(snapshot)

        # Player position [1, 2, 3] with Y-up -> Z-up transform
        pos = result["agent_position"]
        assert isinstance(pos, list)
        assert len(pos) == 3
        # transform_game_position([1,2,3]) = (1, -3, 2)
        assert pos[0] == 1.0
        assert pos[1] == -3.0
        assert pos[2] == 2.0

    def test_agent_properties_extracted(self) -> None:
        snapshot = self._make_snapshot()
        result = normalize_hyperscape_snapshot(snapshot)

        props = result["agent_properties"]
        assert props["health"] == 100
        assert props["maxHealth"] == 100
        assert props["level"] == 42

    def test_missing_player(self) -> None:
        """Snapshot without player should not crash."""
        snapshot = {"timestamp": 500.0, "entities": []}
        result = normalize_hyperscape_snapshot(snapshot)
        assert result["agent_position"] == [0.0, 0.0, 0.0]
        assert result["is_walking"] is False

    def test_empty_snapshot(self) -> None:
        """Empty dict should produce a valid result."""
        result = normalize_hyperscape_snapshot({})
        assert result["source"] == "hyperscape"
        assert result["entities"] == []
        assert result["agent_position"] == [0.0, 0.0, 0.0]

    def test_malformed_entities_skipped(self) -> None:
        """Non-dict entities should be skipped gracefully."""
        snapshot = self._make_snapshot(entities=["not_a_dict", None, 42])
        result = normalize_hyperscape_snapshot(snapshot)
        assert result["entities"] == []

    def test_entity_without_id_skipped(self) -> None:
        """Entities without an id should be skipped."""
        snapshot = self._make_snapshot(entities=[{"type": "tree", "name": "Oak"}])
        result = normalize_hyperscape_snapshot(snapshot)
        assert result["entities"] == []


# ---------------------------------------------------------------------------
# adapt_hyperscape_entities
# ---------------------------------------------------------------------------

class TestAdaptEntities:
    """Test the entity batch adapter."""

    def test_distance_and_bearing(self) -> None:
        entities = [
            {
                "id": "e1",
                "type": "item",
                "name": "Gold Coin",
                "position": [0, 0, 10],  # game: straight ahead
            }
        ]
        result = adapt_hyperscape_entities(entities, agent_position=(0.0, 0.0, 0.0), agent_yaw=0.0)
        assert len(result) == 1
        coin = result[0]
        assert coin.entity_type == "object"
        assert coin.distance_to_agent > 0

    def test_preserves_game_properties(self) -> None:
        entities = [
            {
                "id": "npc-1",
                "type": "merchant",
                "name": "Shopkeeper",
                "position": [0, 0, 0],
                "health": 200,
                "level": 50,
                "interactable": True,
            }
        ]
        result = adapt_hyperscape_entities(entities, agent_position=(0.0, 0.0, 0.0), agent_yaw=0.0)
        assert len(result) == 1
        npc = result[0]
        assert npc.properties.get("health") == 200
        assert npc.properties.get("level") == 50
        assert npc.properties.get("interactable") is True
