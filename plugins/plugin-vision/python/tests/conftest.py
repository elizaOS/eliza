"""Pytest configuration and fixtures for vision plugin tests."""

from __future__ import annotations

from typing import Any

import pytest

from elizaos_vision.types import (
    BoundingBox,
    CameraInfo,
    DetectedObject,
    EntityAppearance,
    EntityAttributes,
    Keypoint,
    OCRBlock,
    OCRResult,
    PersonInfo,
    Point2D,
    SceneDescription,
    TrackedEntity,
    VisionConfig,
)


@pytest.fixture
def vision_config() -> VisionConfig:
    """Create a default vision configuration."""
    return VisionConfig()


@pytest.fixture
def sample_bounding_box() -> BoundingBox:
    """Create a sample bounding box."""
    return BoundingBox(x=100, y=100, width=200, height=300)


@pytest.fixture
def sample_point() -> Point2D:
    """Create a sample 2D point."""
    return Point2D(x=150, y=200)


@pytest.fixture
def sample_camera_info() -> CameraInfo:
    """Create sample camera info."""
    return CameraInfo(id="cam-001", name="Test Camera", connected=True)


@pytest.fixture
def sample_keypoint() -> Keypoint:
    """Create a sample keypoint."""
    return Keypoint(part="nose", position=Point2D(x=100, y=50), score=0.95)


@pytest.fixture
def sample_detected_object(sample_bounding_box: BoundingBox) -> DetectedObject:
    """Create a sample detected object."""
    return DetectedObject(
        id="obj-001",
        type="laptop",
        confidence=0.92,
        bounding_box=sample_bounding_box,
    )


@pytest.fixture
def sample_person_info(sample_bounding_box: BoundingBox, sample_keypoint: Keypoint) -> PersonInfo:
    """Create sample person info."""
    return PersonInfo(
        id="person-001",
        pose="standing",
        facing="camera",
        confidence=0.88,
        bounding_box=sample_bounding_box,
        keypoints=[sample_keypoint],
    )


@pytest.fixture
def sample_scene_description(
    sample_detected_object: DetectedObject,
    sample_person_info: PersonInfo,
) -> SceneDescription:
    """Create a sample scene description."""
    return SceneDescription(
        timestamp=1704067200000,
        description="A person standing in front of a laptop.",
        objects=[sample_detected_object],
        people=[sample_person_info],
        scene_changed=False,
        change_percentage=5.0,
        audio_transcription=None,
    )


@pytest.fixture
def sample_ocr_result() -> OCRResult:
    """Create a sample OCR result."""
    return OCRResult(
        text="Hello World",
        blocks=[
            OCRBlock(
                text="Hello World",
                bbox=BoundingBox(x=10, y=10, width=100, height=20),
                confidence=0.95,
                words=[],
            )
        ],
        full_text="Hello World",
    )


@pytest.fixture
def sample_entity_attributes() -> EntityAttributes:
    """Create sample entity attributes."""
    return EntityAttributes(
        name="Test Person",
        clothing=["blue shirt", "jeans"],
        hair_color="brown",
        description="A person wearing casual clothes",
        tags=["person", "standing"],
    )


@pytest.fixture
def sample_tracked_entity(
    sample_bounding_box: BoundingBox,
    sample_entity_attributes: EntityAttributes,
) -> TrackedEntity:
    """Create a sample tracked entity."""
    return TrackedEntity(
        id="entity-001",
        entity_type="person",
        first_seen=1704067200000,
        last_seen=1704067260000,
        last_position=sample_bounding_box,
        appearances=[
            EntityAppearance(
                timestamp=1704067200000,
                bounding_box=sample_bounding_box,
                confidence=0.95,
                embedding=None,
                keypoints=[],
            )
        ],
        attributes=sample_entity_attributes,
        world_id="world-001",
        room_id="room-001",
    )


class MockRuntime:
    """Mock runtime for testing actions."""

    def __init__(self) -> None:
        self.agent_id = "test-agent-001"
        self._services: dict[str, Any] = {}
        self._memories: list[dict[str, Any]] = []

    def get_service(self, name: str) -> Any:
        """Get a service by name."""
        return self._services.get(name)

    def register_service(self, name: str, service: Any) -> None:
        """Register a service."""
        self._services[name] = service

    async def create_memory(self, memory: dict[str, Any], table: str) -> None:
        """Create a memory record."""
        self._memories.append({"memory": memory, "table": table})


class MockMessage:
    """Mock message for testing actions."""

    def __init__(
        self,
        text: str = "",
        room_id: str | None = "room-001",
        world_id: str | None = "world-001",
    ) -> None:
        self.room_id = room_id
        self.world_id = world_id
        self.content: dict[str, Any] = {"text": text}


@pytest.fixture
def mock_runtime() -> MockRuntime:
    """Create a mock runtime."""
    return MockRuntime()


@pytest.fixture
def mock_message() -> MockMessage:
    """Create a mock message."""
    return MockMessage()
