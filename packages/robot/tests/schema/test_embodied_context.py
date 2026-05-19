"""Tests for the canonical EmbodiedContext schema.

Covers:
- ContextEntity creation with all fields
- EmbodiedContext.to_dict() produces TrajectoryDB-compatible output
- EmbodiedContext.to_llm_prompt() produces readable text
- from_hyperscape_snapshot with sample game data
- Entity slots extraction
- Serialisation roundtrip (to_dict -> from_dict)
"""

from __future__ import annotations

import math
import json

import numpy as np
import pytest

from eliza_robot.schema.embodied_context import (
    ContextEntity,
    EmbodiedContext,
    _entity_type_to_slot_index,
    _label_to_entity_type,
    ENTITY_TYPE_STRINGS,
)
from eliza_robot.schema.hyperscape_adapter import (
    adapt_hyperscape_entities,
    extract_properties,
    map_entity_type,
    transform_game_position,
)
from eliza_robot.perception.entity_slots.slot_config import (
    BEARING_OFFSET,
    CONFIDENCE_OFFSET,
    NUM_ENTITY_SLOTS,
    NUM_ENTITY_TYPES,
    POSITION_OFFSET,
    SIZE_OFFSET,
    SLOT_DIM,
    TOTAL_ENTITY_DIMS,
    TYPE_OFFSET,
    VELOCITY_OFFSET,
)


# ── ContextEntity ────────────────────────────────────────────────────────

class TestContextEntity:
    """Test ContextEntity creation and helpers."""

    def test_create_with_all_fields(self) -> None:
        e = ContextEntity(
            entity_id="ball_1",
            entity_type="object",
            label="red_ball",
            position=(1.5, 0.0, 0.3),
            velocity=(0.1, 0.0, 0.0),
            size=(0.1, 0.1, 0.1),
            confidence=0.95,
            distance_to_agent=1.53,
            bearing_to_agent=0.0,
            source="ego_camera",
            properties={"color": "red"},
        )
        assert e.entity_id == "ball_1"
        assert e.entity_type == "object"
        assert e.label == "red_ball"
        assert e.position == (1.5, 0.0, 0.3)
        assert e.velocity == (0.1, 0.0, 0.0)
        assert e.size == (0.1, 0.1, 0.1)
        assert e.confidence == pytest.approx(0.95)
        assert e.distance_to_agent == pytest.approx(1.53)
        assert e.bearing_to_agent == pytest.approx(0.0)
        assert e.source == "ego_camera"
        assert e.properties == {"color": "red"}

    def test_defaults(self) -> None:
        e = ContextEntity(entity_id="x", entity_type="unknown", label="x")
        assert e.position == (0.0, 0.0, 0.0)
        assert e.velocity == (0.0, 0.0, 0.0)
        assert e.size == (0.0, 0.0, 0.0)
        assert e.confidence == 0.0
        assert e.properties == {}

    def test_frozen(self) -> None:
        e = ContextEntity(entity_id="x", entity_type="unknown", label="x")
        with pytest.raises(AttributeError):
            e.entity_id = "y"  # type: ignore[misc]

    def test_bearing_description_ahead(self) -> None:
        e = ContextEntity(entity_id="a", entity_type="object", label="a", bearing_to_agent=0.0)
        assert "ahead" in e.bearing_description()

    def test_bearing_description_left(self) -> None:
        e = ContextEntity(entity_id="a", entity_type="object", label="a",
                          bearing_to_agent=math.radians(45))
        desc = e.bearing_description()
        assert "left" in desc

    def test_bearing_description_right(self) -> None:
        e = ContextEntity(entity_id="a", entity_type="object", label="a",
                          bearing_to_agent=math.radians(-60))
        desc = e.bearing_description()
        assert "right" in desc

    def test_to_dict(self) -> None:
        e = ContextEntity(
            entity_id="ball_1",
            entity_type="object",
            label="red_ball",
            position=(1.0, 2.0, 3.0),
            velocity=(0.1, 0.2, 0.3),
            size=(0.5, 0.5, 0.5),
            confidence=0.8,
            distance_to_agent=1.0,
            bearing_to_agent=0.1,
            source="simulation",
            properties={"mass": 0.5},
        )
        d = e.to_dict()
        assert isinstance(d["position"], list)
        assert isinstance(d["velocity"], list)
        assert isinstance(d["size"], list)
        assert d["entity_id"] == "ball_1"
        assert d["properties"]["mass"] == 0.5

    def test_from_dict_roundtrip(self) -> None:
        e = ContextEntity(
            entity_id="table_1",
            entity_type="furniture",
            label="dining_table",
            position=(2.0, -1.0, 0.0),
            velocity=(0.0, 0.0, 0.0),
            size=(1.2, 0.75, 0.8),
            confidence=0.9,
            distance_to_agent=2.24,
            bearing_to_agent=-0.46,
            source="ego_camera",
            properties={"material": "wood"},
        )
        d = e.to_dict()
        e2 = ContextEntity.from_dict(d)
        assert e2.entity_id == e.entity_id
        assert e2.entity_type == e.entity_type
        assert e2.label == e.label
        assert e2.confidence == pytest.approx(e.confidence)
        assert tuple(e2.position) == pytest.approx(e.position)
        assert e2.properties == e.properties


# ── EmbodiedContext ──────────────────────────────────────────────────────

def _sample_context() -> EmbodiedContext:
    """Helper to create a populated EmbodiedContext."""
    ball = ContextEntity(
        entity_id="ball_1",
        entity_type="object",
        label="red_ball",
        position=(1.5, 0.0, 0.3),
        confidence=0.95,
        distance_to_agent=1.53,
        bearing_to_agent=0.0,
        source="ego_camera",
    )
    table = ContextEntity(
        entity_id="table_1",
        entity_type="furniture",
        label="table",
        position=(0.0, 2.0, 0.0),
        confidence=0.88,
        distance_to_agent=2.0,
        bearing_to_agent=math.pi / 2,
        source="ego_camera",
    )
    return EmbodiedContext(
        schema_version="1.0",
        source="real_robot",
        timestamp=1000.0,
        agent_position=(0.0, 0.0, 0.0),
        agent_orientation=(0.0, 0.0, 0.0, 1.0),
        agent_yaw=0.0,
        imu_roll=0.01,
        imu_pitch=-0.02,
        is_walking=True,
        battery_mv=11800,
        entities=(ball, table),
        task_description="Pick up the red ball",
        language_instruction="go to the red ball and pick it up",
    )


class TestEmbodiedContext:
    """Test EmbodiedContext serialisation and prompt generation."""

    def test_to_dict_is_json_serialisable(self) -> None:
        ctx = _sample_context()
        d = ctx.to_dict()
        # Must not raise
        json_str = json.dumps(d)
        assert isinstance(json_str, str)

    def test_to_dict_structure(self) -> None:
        ctx = _sample_context()
        d = ctx.to_dict()
        assert d["schema_version"] == "1.0"
        assert d["source"] == "real_robot"
        assert d["timestamp"] == 1000.0
        assert isinstance(d["agent_position"], list)
        assert len(d["agent_position"]) == 3
        assert isinstance(d["agent_orientation"], list)
        assert len(d["agent_orientation"]) == 4
        assert d["is_walking"] is True
        assert d["battery_mv"] == 11800
        assert len(d["entities"]) == 2
        assert d["entities"][0]["entity_id"] == "ball_1"
        assert d["task_description"] == "Pick up the red ball"

    def test_to_dict_trajectorydb_compatible(self) -> None:
        """Verify the dict has the keys expected by TrajectoryDB."""
        ctx = _sample_context()
        d = ctx.to_dict()
        # TrajectoryDB EmbodiedContext expects at minimum:
        # timestamp, entities (list of dicts), source, task_description
        assert "timestamp" in d
        assert "entities" in d
        assert isinstance(d["entities"], list)
        assert "source" in d
        assert "task_description" in d
        # Each entity should be a plain dict
        for ent in d["entities"]:
            assert isinstance(ent, dict)
            assert "entity_id" in ent
            assert "position" in ent
            assert isinstance(ent["position"], list)

    def test_from_dict_roundtrip(self) -> None:
        ctx = _sample_context()
        d = ctx.to_dict()
        ctx2 = EmbodiedContext.from_dict(d)
        assert ctx2.schema_version == ctx.schema_version
        assert ctx2.source == ctx.source
        assert ctx2.timestamp == ctx.timestamp
        assert tuple(ctx2.agent_position) == pytest.approx(ctx.agent_position)
        assert tuple(ctx2.agent_orientation) == pytest.approx(ctx.agent_orientation)
        assert ctx2.is_walking == ctx.is_walking
        assert ctx2.battery_mv == ctx.battery_mv
        assert len(ctx2.entities) == len(ctx.entities)
        assert ctx2.entities[0].entity_id == ctx.entities[0].entity_id
        assert ctx2.entities[1].label == ctx.entities[1].label
        assert ctx2.task_description == ctx.task_description
        assert ctx2.language_instruction == ctx.language_instruction

    def test_from_dict_json_roundtrip(self) -> None:
        """Full JSON serialisation roundtrip."""
        ctx = _sample_context()
        json_str = json.dumps(ctx.to_dict())
        d = json.loads(json_str)
        ctx2 = EmbodiedContext.from_dict(d)
        assert ctx2.source == ctx.source
        assert len(ctx2.entities) == 2
        assert ctx2.entities[0].entity_type == "object"

    def test_to_llm_prompt_contains_entities(self) -> None:
        ctx = _sample_context()
        prompt = ctx.to_llm_prompt()
        assert "humanoid robot" in prompt
        assert "red_ball" in prompt
        assert "object" in prompt
        assert "table" in prompt
        assert "furniture" in prompt
        assert "walking" in prompt

    def test_to_llm_prompt_standing_still(self) -> None:
        ctx = EmbodiedContext(is_walking=False)
        prompt = ctx.to_llm_prompt()
        assert "standing still" in prompt

    def test_to_llm_prompt_includes_battery(self) -> None:
        ctx = _sample_context()
        prompt = ctx.to_llm_prompt()
        assert "11800mV" in prompt

    def test_to_llm_prompt_includes_task(self) -> None:
        ctx = _sample_context()
        prompt = ctx.to_llm_prompt()
        assert "Pick up the red ball" in prompt
        assert "go to the red ball" in prompt

    def test_to_llm_prompt_empty_context(self) -> None:
        ctx = EmbodiedContext()
        prompt = ctx.to_llm_prompt()
        assert "humanoid robot" in prompt
        assert "standing still" in prompt

    def test_defaults(self) -> None:
        ctx = EmbodiedContext()
        assert ctx.schema_version == "1.0"
        assert ctx.source == ""
        assert ctx.entities == ()
        assert ctx.entity_slots == ()
        assert ctx.joint_positions == ()


# ── Entity slots extraction ──────────────────────────────────────────────

class TestEntitySlots:
    """Test entity slot encoding and extraction."""

    def test_passthrough_pre_encoded_slots(self) -> None:
        """If entity_slots are already populated, return them directly."""
        slots = tuple([0.5] * TOTAL_ENTITY_DIMS)
        ctx = EmbodiedContext(entity_slots=slots)
        arr = ctx.to_entity_slots_array()
        assert arr.shape == (TOTAL_ENTITY_DIMS,)
        assert arr.dtype == np.float32
        np.testing.assert_array_almost_equal(arr, 0.5)

    def test_encode_from_entities(self) -> None:
        """Build slots from entity list when no pre-encoded slots exist."""
        ball = ContextEntity(
            entity_id="ball",
            entity_type="object",
            label="ball",
            position=(2.0, 0.0, 0.5),
            velocity=(0.1, 0.0, 0.0),
            size=(0.1, 0.1, 0.1),
            confidence=0.9,
            distance_to_agent=2.06,
            bearing_to_agent=0.0,
            source="simulation",
        )
        ctx = EmbodiedContext(entities=(ball,))
        arr = ctx.to_entity_slots_array()
        assert arr.shape == (TOTAL_ENTITY_DIMS,)

        # Check entity type one-hot -- "object" is index 2
        type_slice = arr[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES]
        assert type_slice[2] == 1.0  # OBJECT
        assert type_slice.sum() == 1.0

        # Check position normalised
        from eliza_robot.perception.entity_slots.slot_config import MAX_DISTANCE
        assert arr[POSITION_OFFSET] == pytest.approx(2.0 / MAX_DISTANCE)

        # Check confidence
        assert arr[CONFIDENCE_OFFSET] == pytest.approx(0.9)

        # Check bearing (sin(0), cos(0)) = (0, 1)
        assert arr[BEARING_OFFSET] == pytest.approx(0.0, abs=1e-6)
        assert arr[BEARING_OFFSET + 1] == pytest.approx(1.0, abs=1e-6)

    def test_max_entities_capped(self) -> None:
        """Only the first NUM_ENTITY_SLOTS entities should be encoded."""
        entities = tuple(
            ContextEntity(
                entity_id=f"e_{i}",
                entity_type="object",
                label=f"obj_{i}",
                position=(float(i), 0.0, 0.0),
                confidence=0.5,
                distance_to_agent=float(i),
                bearing_to_agent=0.0,
            )
            for i in range(NUM_ENTITY_SLOTS + 5)
        )
        ctx = EmbodiedContext(entities=entities)
        arr = ctx.to_entity_slots_array()
        assert arr.shape == (TOTAL_ENTITY_DIMS,)

        # Slot 0 should be populated
        assert arr[TYPE_OFFSET:TYPE_OFFSET + NUM_ENTITY_TYPES].sum() == 1.0
        # Slot (NUM_ENTITY_SLOTS - 1) should be populated
        last_slot = (NUM_ENTITY_SLOTS - 1) * SLOT_DIM
        assert arr[last_slot + TYPE_OFFSET:last_slot + TYPE_OFFSET + NUM_ENTITY_TYPES].sum() == 1.0

    def test_empty_entities_yields_zeros(self) -> None:
        ctx = EmbodiedContext()
        arr = ctx.to_entity_slots_array()
        assert arr.shape == (TOTAL_ENTITY_DIMS,)
        np.testing.assert_array_equal(arr, 0.0)

    def test_entity_type_mapping(self) -> None:
        for idx, name in enumerate(ENTITY_TYPE_STRINGS):
            assert _entity_type_to_slot_index(name) == idx
        assert _entity_type_to_slot_index("nonexistent") == 0  # unknown


# ── Hyperscape adapter ───────────────────────────────────────────────────

class TestHyperscapeAdapter:
    """Test Hyperscape game snapshot conversion."""

    def test_entity_type_mapping(self) -> None:
        assert map_entity_type("player") == "person"
        assert map_entity_type("npc") == "person"
        assert map_entity_type("resource") == "object"
        assert map_entity_type("item") == "object"
        assert map_entity_type("chest") == "object"
        assert map_entity_type("tree") == "landmark"
        assert map_entity_type("rock") == "landmark"
        assert map_entity_type("building") == "landmark"
        assert map_entity_type("bank") == "landmark"
        assert map_entity_type("shop") == "landmark"
        assert map_entity_type("tavern") == "landmark"
        assert map_entity_type("door") == "door"
        assert map_entity_type("gate") == "door"
        assert map_entity_type("portal") == "door"
        assert map_entity_type("table") == "furniture"
        assert map_entity_type("somethingrandom") == "unknown"

    def test_coordinate_transform_y_up_to_z_up(self) -> None:
        # Game: (1, 5, 3) where Y=5 is up, Z=3 is forward
        result = transform_game_position([1.0, 5.0, 3.0])
        assert result == (1.0, -3.0, 5.0)

    def test_coordinate_transform_dict_input(self) -> None:
        result = transform_game_position({"x": 2.0, "y": 10.0, "z": -1.0})
        assert result == (2.0, 1.0, 10.0)

    def test_coordinate_transform_origin(self) -> None:
        result = transform_game_position([0.0, 0.0, 0.0])
        assert result == (0.0, 0.0, 0.0)

    def test_property_extraction(self) -> None:
        raw = {
            "health": 100,
            "maxHealth": 100,
            "level": 5,
            "rarity": "legendary",
            "internalEngineId": 42,  # should be filtered
            "position": [1, 2, 3],  # should be filtered
        }
        props = extract_properties(raw)
        assert props["health"] == 100
        assert props["maxHealth"] == 100
        assert props["level"] == 5
        assert props["rarity"] == "legendary"
        assert "internalEngineId" not in props
        assert "position" not in props

    def test_adapt_hyperscape_entities_basic(self) -> None:
        raw_entities = [
            {
                "entityId": "npc_1",
                "entityType": "npc",
                "label": "guard_bob",
                "position": [10.0, 0.0, 5.0],
                "velocity": [0.0, 0.0, 0.0],
                "size": [0.5, 1.8, 0.5],
                "health": 100,
                "level": 3,
            },
            {
                "entityId": "chest_1",
                "entityType": "chest",
                "name": "golden_chest",  # uses 'name' instead of 'label'
                "position": [3.0, 0.0, -2.0],
                "health": 50,
            },
        ]
        agent_pos = (0.0, 0.0, 0.0)
        agent_yaw = 0.0
        result = adapt_hyperscape_entities(raw_entities, agent_pos, agent_yaw)

        assert len(result) == 2

        npc = result[0]
        assert npc.entity_id == "npc_1"
        assert npc.entity_type == "person"
        assert npc.label == "guard_bob"
        # Position: game (10, 0, 5) -> canonical (10, -5, 0)
        assert npc.position == (10.0, -5.0, 0.0)
        assert npc.distance_to_agent > 0
        assert npc.properties.get("health") == 100
        assert npc.properties.get("level") == 3

        chest = result[1]
        assert chest.entity_id == "chest_1"
        assert chest.entity_type == "object"
        assert chest.label == "golden_chest"
        # Position: game (3, 0, -2) -> canonical (3, 2, 0)
        assert chest.position == (3.0, 2.0, 0.0)

    def test_adapt_hyperscape_entities_camelcase_keys(self) -> None:
        """Verify camelCase keys from TypeScript side are handled."""
        raw = [
            {
                "id": "door_1",
                "type": "door",
                "name": "tavern_door",
                "pos": [0.0, 2.0, 0.0],
                "isOpen": True,
                "isLocked": False,
            },
        ]
        result = adapt_hyperscape_entities(raw, (0.0, 0.0, 0.0), 0.0)
        assert len(result) == 1
        assert result[0].entity_type == "door"
        assert result[0].label == "tavern_door"
        assert result[0].properties.get("isOpen") is True

    def test_adapt_hyperscape_entities_skips_empty_id(self) -> None:
        raw = [{"entityType": "tree", "position": [1, 2, 3]}]  # no id
        result = adapt_hyperscape_entities(raw, (0.0, 0.0, 0.0), 0.0)
        assert len(result) == 0

    def test_from_hyperscape_snapshot_full(self) -> None:
        snapshot = {
            "timestamp": 42.0,
            "player": {
                "position": [100.0, 0.0, 50.0],
                "orientation": [0.0, 0.0, 0.0, 1.0],
                "yaw": 1.57,
                "isWalking": True,
            },
            "entities": [
                {
                    "entityId": "tree_1",
                    "entityType": "tree",
                    "label": "oak_tree",
                    "position": [105.0, 0.0, 55.0],
                    "size": [2.0, 5.0, 2.0],
                },
                {
                    "entityId": "npc_2",
                    "entityType": "npc",
                    "label": "merchant",
                    "position": [98.0, 0.0, 48.0],
                    "health": 100,
                    "level": 10,
                },
            ],
            "taskDescription": "Gather wood from oak trees",
            "languageInstruction": "chop the nearest tree",
        }
        ctx = EmbodiedContext.from_hyperscape_snapshot(snapshot)

        assert ctx.source == "hyperscape"
        assert ctx.timestamp == 42.0
        assert ctx.is_walking is True
        assert ctx.agent_yaw == pytest.approx(1.57)
        # Agent position: game (100, 0, 50) -> canonical (100, -50, 0)
        assert ctx.agent_position == (100.0, -50.0, 0.0)
        assert len(ctx.entities) == 2
        assert ctx.entities[0].entity_type == "landmark"  # tree -> landmark
        assert ctx.entities[1].entity_type == "person"  # npc -> person
        assert ctx.task_description == "Gather wood from oak trees"
        assert ctx.language_instruction == "chop the nearest tree"

    def test_from_hyperscape_snapshot_alternative_keys(self) -> None:
        """Test snapshot with alternative key names."""
        snapshot = {
            "time": 99.0,
            "agent": {
                "pos": [0.0, 0.0, 0.0],
                "heading": 0.0,
                "isMoving": False,
            },
            "objects": [
                {
                    "id": "item_1",
                    "type": "item",
                    "name": "health_potion",
                    "pos": [1.0, 0.0, 0.0],
                },
            ],
            "task": "Collect potions",
            "instruction": "pick up the health potion",
        }
        ctx = EmbodiedContext.from_hyperscape_snapshot(snapshot)
        assert ctx.timestamp == 99.0
        assert ctx.is_walking is False
        assert len(ctx.entities) == 1
        assert ctx.entities[0].entity_type == "object"
        assert ctx.entities[0].label == "health_potion"
        assert ctx.task_description == "Collect potions"

    def test_from_hyperscape_snapshot_entity_slots_via_method(self) -> None:
        """Entity slots should be buildable from entities after snapshot."""
        snapshot = {
            "timestamp": 1.0,
            "player": {"position": [0, 0, 0]},
            "entities": [
                {
                    "entityId": "obj_1",
                    "entityType": "resource",
                    "label": "gold_ore",
                    "position": [3.0, 0.0, 1.0],
                },
            ],
        }
        ctx = EmbodiedContext.from_hyperscape_snapshot(snapshot)
        arr = ctx.to_entity_slots_array()
        assert arr.shape == (TOTAL_ENTITY_DIMS,)
        # "resource" -> "object" -> slot index 2
        assert arr[TYPE_OFFSET + 2] == 1.0


# ── Label-to-type helper ────────────────────────────────────────────────

class TestLabelToEntityType:
    def test_person_labels(self) -> None:
        assert _label_to_entity_type("person") == "person"
        assert _label_to_entity_type("face") == "person"
        assert _label_to_entity_type("human") == "person"

    def test_furniture_labels(self) -> None:
        assert _label_to_entity_type("chair") == "furniture"
        assert _label_to_entity_type("table") == "furniture"
        assert _label_to_entity_type("bed") == "furniture"

    def test_door_labels(self) -> None:
        assert _label_to_entity_type("door") == "door"
        assert _label_to_entity_type("gate") == "door"

    def test_landmark_labels(self) -> None:
        assert _label_to_entity_type("wall") == "landmark"
        assert _label_to_entity_type("tree") == "landmark"

    def test_unknown(self) -> None:
        assert _label_to_entity_type("unknown") == "unknown"

    def test_fallback_to_object(self) -> None:
        assert _label_to_entity_type("cup") == "object"
        assert _label_to_entity_type("bottle") == "object"
