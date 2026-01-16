import pytest
from google.protobuf import struct_pb2

from elizaos.types import (
    DEFAULT_UUID,
    Character,
    Content,
    Entity,
    Memory,
    Plugin,
    Room,
    State,
    Task,
    TaskStatus,
    World,
    as_uuid,
)


class TestUUID:
    def test_valid_uuid(self) -> None:
        valid_uuid = "12345678-1234-1234-1234-123456789012"
        result = as_uuid(valid_uuid)
        assert result == valid_uuid

    def test_invalid_uuid_format(self) -> None:
        with pytest.raises(ValueError, match="Invalid UUID format"):
            as_uuid("not-a-uuid")

    def test_empty_uuid(self) -> None:
        with pytest.raises(ValueError, match="Invalid UUID format"):
            as_uuid("")

    def test_uuid_case_insensitive(self) -> None:
        lower = "12345678-1234-1234-1234-123456789012"
        upper = "12345678-1234-1234-1234-123456789012".upper()
        assert as_uuid(lower) == lower
        assert as_uuid(upper) == upper

    def test_default_uuid(self) -> None:
        assert DEFAULT_UUID == "00000000-0000-0000-0000-000000000000"
        assert as_uuid(DEFAULT_UUID) == DEFAULT_UUID

    def test_default_uuid_can_be_used_in_memory(self) -> None:
        memory = Memory(
            entity_id=as_uuid("12345678-1234-1234-1234-123456789012"),
            room_id=DEFAULT_UUID,
            content=Content(text="Hello"),
        )
        assert memory.room_id == DEFAULT_UUID


class TestContent:
    def test_minimal_content(self) -> None:
        content = Content(text="Hello world")
        assert content.text == "Hello world"
        assert content.thought is None
        assert content.actions == []

    def test_full_content(self) -> None:
        content = Content(
            text="Hello world",
            thought="Thinking about response",
            actions=["RESPOND", "SEARCH"],
            providers=["KNOWLEDGE"],
            source="cli",
            target="user",
        )
        assert content.text == "Hello world"
        assert content.thought == "Thinking about response"
        assert content.actions == ["RESPOND", "SEARCH"]
        assert content.providers == ["KNOWLEDGE"]


class TestMemory:
    def test_minimal_memory(self) -> None:
        memory = Memory(
            entity_id=as_uuid("12345678-1234-1234-1234-123456789012"),
            room_id=as_uuid("12345678-1234-1234-1234-123456789013"),
            content=Content(text="Hello"),
        )
        assert memory.entity_id == "12345678-1234-1234-1234-123456789012"
        assert memory.content.text == "Hello"

    def test_memory_with_embedding(self) -> None:
        embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
        memory = Memory(
            entity_id=as_uuid("12345678-1234-1234-1234-123456789012"),
            room_id=as_uuid("12345678-1234-1234-1234-123456789013"),
            content=Content(text="Hello"),
            embedding=embedding,
        )
        assert memory.embedding == embedding


class TestCharacter:
    def test_minimal_character(self) -> None:
        character = Character(
            name="TestAgent",
            bio=["A test agent for testing."],
        )
        assert character.name == "TestAgent"
        assert character.bio == ["A test agent for testing."]

    def test_full_character(self) -> None:
        character = Character(
            name="TestAgent",
            username="testagent",
            bio=["Line 1", "Line 2"],
            system="You are a test agent.",
            topics=["testing", "automation"],
            adjectives=["helpful", "precise"],
            plugins=["@elizaos/plugin-sql"],
            settings=None,
            secrets={"API_KEY": "secret"},
        )
        assert character.name == "TestAgent"
        assert character.username == "testagent"
        assert character.bio == ["Line 1", "Line 2"]
        assert character.topics == ["testing", "automation"]


class TestEntity:
    def test_minimal_entity(self) -> None:
        entity = Entity(
            names=["TestUser"],
            agent_id=as_uuid("12345678-1234-1234-1234-123456789012"),
        )
        assert entity.names == ["TestUser"]
        assert entity.metadata is not None

    def test_entity_with_metadata(self) -> None:
        metadata = struct_pb2.Struct()
        metadata.update({"email": "test@example.com"})
        entity = Entity(
            names=["TestUser"],
            agent_id=as_uuid("12345678-1234-1234-1234-123456789012"),
            metadata=metadata,
        )
        assert entity.metadata is not None


class TestRoom:
    def test_room_creation(self) -> None:
        room = Room(
            id=as_uuid("12345678-1234-1234-1234-123456789012"),
            source="cli",
            type="DM",
        )
        assert room.type == "DM"
        assert room.source == "cli"

    def test_room_with_world(self) -> None:
        room = Room(
            id=as_uuid("12345678-1234-1234-1234-123456789012"),
            source="discord",
            type="GROUP",
            world_id=as_uuid("12345678-1234-1234-1234-123456789013"),
            name="general",
        )
        assert room.name == "general"
        assert room.world_id == "12345678-1234-1234-1234-123456789013"


class TestWorld:
    def test_world_creation(self) -> None:
        world = World(
            id=as_uuid("12345678-1234-1234-1234-123456789012"),
            agent_id=as_uuid("12345678-1234-1234-1234-123456789013"),
            name="Test World",
        )
        assert world.name == "Test World"


class TestPlugin:
    def test_minimal_plugin(self) -> None:
        plugin = Plugin(
            name="test-plugin",
            description="A test plugin",
        )
        assert plugin.name == "test-plugin"
        assert plugin.description == "A test plugin"

    def test_plugin_with_dependencies(self) -> None:
        plugin = Plugin(
            name="test-plugin",
            description="A test plugin",
            dependencies=["core-plugin", "util-plugin"],
        )
        assert plugin.dependencies == ["core-plugin", "util-plugin"]


class TestState:
    def test_empty_state(self) -> None:
        state = State()
        assert state.values is not None
        assert state.text == ""

    def test_state_with_data(self) -> None:
        state = State(text="State context")
        assert state.text == "State context"


class TestTask:
    def test_task_creation(self) -> None:
        task = Task(
            name="test-task",
            description="A test task",
        )
        assert task.name == "test-task"
        assert task.status == TaskStatus.PENDING

    def test_task_with_metadata(self) -> None:
        task = Task(
            name="scheduled-task",
            status=TaskStatus.IN_PROGRESS,
            tags=["important", "daily"],
        )
        assert task.status == TaskStatus.IN_PROGRESS
        assert "important" in (task.tags or [])
