"""Tests for vision plugin types."""

from __future__ import annotations

from elizaos_vision.types import (
    BoundingBox,
    CameraInfo,
    DetectedObject,
    EntityAttributes,
    Keypoint,
    OCRBlock,
    OCRResult,
    PersonInfo,
    Point2D,
    SceneDescription,
    ScreenCapture,
    ScreenTile,
    TrackedEntity,
    VisionConfig,
    VisionFrame,
    VisionMode,
    WorldState,
)


class TestVisionMode:
    """Tests for VisionMode enum."""

    def test_vision_mode_values(self) -> None:
        """Test all vision mode values exist."""
        assert VisionMode.OFF.value == "OFF"
        assert VisionMode.CAMERA.value == "CAMERA"
        assert VisionMode.SCREEN.value == "SCREEN"
        assert VisionMode.BOTH.value == "BOTH"

    def test_vision_mode_is_string_enum(self) -> None:
        """Test that VisionMode is a string enum."""
        assert isinstance(VisionMode.OFF, str)
        assert VisionMode.CAMERA == "CAMERA"


class TestPoint2D:
    """Tests for Point2D."""

    def test_point_creation(self) -> None:
        """Test point creation."""
        point = Point2D(x=10.5, y=20.5)
        assert point.x == 10.5
        assert point.y == 20.5

    def test_point_with_integers(self) -> None:
        """Test point with integer values."""
        point = Point2D(x=100, y=200)
        assert point.x == 100
        assert point.y == 200


class TestBoundingBox:
    """Tests for BoundingBox."""

    def test_bounding_box_creation(self, sample_bounding_box: BoundingBox) -> None:
        """Test bounding box creation."""
        assert sample_bounding_box.x == 100
        assert sample_bounding_box.y == 100
        assert sample_bounding_box.width == 200
        assert sample_bounding_box.height == 300

    def test_bounding_box_center(self, sample_bounding_box: BoundingBox) -> None:
        """Test bounding box center calculation."""
        center = sample_bounding_box.center()
        assert center.x == 200  # 100 + 200/2
        assert center.y == 250  # 100 + 300/2

    def test_bounding_box_area(self, sample_bounding_box: BoundingBox) -> None:
        """Test bounding box area calculation."""
        assert sample_bounding_box.area() == 60000  # 200 * 300

    def test_bounding_box_aspect_ratio(self) -> None:
        """Test bounding box aspect ratio calculation."""
        box = BoundingBox(x=0, y=0, width=400, height=200)
        assert box.aspect_ratio() == 2.0

    def test_bounding_box_aspect_ratio_zero_height(self) -> None:
        """Test aspect ratio with zero height."""
        box = BoundingBox(x=0, y=0, width=100, height=0)
        assert box.aspect_ratio() == 0


class TestCameraInfo:
    """Tests for CameraInfo."""

    def test_camera_info_creation(self, sample_camera_info: CameraInfo) -> None:
        """Test camera info creation."""
        assert sample_camera_info.id == "cam-001"
        assert sample_camera_info.name == "Test Camera"
        assert sample_camera_info.connected is True


class TestKeypoint:
    """Tests for Keypoint."""

    def test_keypoint_creation(self, sample_keypoint: Keypoint) -> None:
        """Test keypoint creation."""
        assert sample_keypoint.part == "nose"
        assert sample_keypoint.position.x == 100
        assert sample_keypoint.position.y == 50
        assert sample_keypoint.score == 0.95


class TestDetectedObject:
    """Tests for DetectedObject."""

    def test_detected_object_creation(self, sample_detected_object: DetectedObject) -> None:
        """Test detected object creation."""
        assert sample_detected_object.id == "obj-001"
        assert sample_detected_object.type == "laptop"
        assert sample_detected_object.confidence == 0.92
        assert sample_detected_object.bounding_box is not None


class TestPersonInfo:
    """Tests for PersonInfo."""

    def test_person_info_creation(self, sample_person_info: PersonInfo) -> None:
        """Test person info creation."""
        assert sample_person_info.id == "person-001"
        assert sample_person_info.pose == "standing"
        assert sample_person_info.facing == "camera"
        assert sample_person_info.confidence == 0.88
        assert len(sample_person_info.keypoints) == 1

    def test_person_info_pose_values(self) -> None:
        """Test valid pose values."""
        bbox = BoundingBox(x=0, y=0, width=100, height=200)
        for pose in ["sitting", "standing", "lying", "unknown"]:
            person = PersonInfo(
                id="test", pose=pose, facing="camera", confidence=0.9, bounding_box=bbox
            )
            assert person.pose == pose

    def test_person_info_facing_values(self) -> None:
        """Test valid facing values."""
        bbox = BoundingBox(x=0, y=0, width=100, height=200)
        for facing in ["camera", "away", "left", "right", "unknown"]:
            person = PersonInfo(
                id="test", pose="standing", facing=facing, confidence=0.9, bounding_box=bbox
            )
            assert person.facing == facing


class TestSceneDescription:
    """Tests for SceneDescription."""

    def test_scene_description_creation(self, sample_scene_description: SceneDescription) -> None:
        """Test scene description creation."""
        assert sample_scene_description.timestamp == 1704067200000
        assert "person" in sample_scene_description.description.lower()
        assert len(sample_scene_description.objects) == 1
        assert len(sample_scene_description.people) == 1
        assert sample_scene_description.scene_changed is False
        assert sample_scene_description.change_percentage == 5.0

    def test_scene_description_with_audio(self) -> None:
        """Test scene description with audio transcription."""
        scene = SceneDescription(
            timestamp=0,
            description="Test",
            objects=[],
            people=[],
            scene_changed=False,
            change_percentage=0,
            audio_transcription="Hello there",
        )
        assert scene.audio_transcription == "Hello there"


class TestOCRResult:
    """Tests for OCRResult."""

    def test_ocr_result_creation(self, sample_ocr_result: OCRResult) -> None:
        """Test OCR result creation."""
        assert sample_ocr_result.text == "Hello World"
        assert len(sample_ocr_result.blocks) == 1
        assert sample_ocr_result.full_text == "Hello World"

    def test_ocr_block_creation(self) -> None:
        """Test OCR block creation."""
        block = OCRBlock(
            text="Test",
            bbox=BoundingBox(x=0, y=0, width=50, height=20),
            confidence=0.9,
            words=[],
        )
        assert block.text == "Test"
        assert block.confidence == 0.9


class TestVisionFrame:
    """Tests for VisionFrame."""

    def test_vision_frame_creation(self) -> None:
        """Test vision frame creation."""
        frame = VisionFrame(
            timestamp=1704067200000,
            width=1920,
            height=1080,
            data=b"test_data",
            format="jpeg",
        )
        assert frame.timestamp == 1704067200000
        assert frame.width == 1920
        assert frame.height == 1080
        assert frame.format == "jpeg"

    def test_vision_frame_formats(self) -> None:
        """Test valid frame formats."""
        for fmt in ["rgb", "rgba", "jpeg", "png"]:
            frame = VisionFrame(timestamp=0, width=100, height=100, data=b"", format=fmt)
            assert frame.format == fmt


class TestEntityAttributes:
    """Tests for EntityAttributes."""

    def test_entity_attributes_creation(self, sample_entity_attributes: EntityAttributes) -> None:
        """Test entity attributes creation."""
        assert sample_entity_attributes.name == "Test Person"
        assert "blue shirt" in sample_entity_attributes.clothing
        assert sample_entity_attributes.hair_color == "brown"

    def test_entity_attributes_defaults(self) -> None:
        """Test entity attributes defaults."""
        attrs = EntityAttributes()
        assert attrs.name is None
        assert attrs.clothing == []
        assert attrs.tags == []


class TestTrackedEntity:
    """Tests for TrackedEntity."""

    def test_tracked_entity_creation(self, sample_tracked_entity: TrackedEntity) -> None:
        """Test tracked entity creation."""
        assert sample_tracked_entity.id == "entity-001"
        assert sample_tracked_entity.entity_type == "person"
        assert len(sample_tracked_entity.appearances) == 1
        assert sample_tracked_entity.world_id == "world-001"

    def test_tracked_entity_types(self) -> None:
        """Test valid entity types."""
        bbox = BoundingBox(x=0, y=0, width=100, height=100)
        for entity_type in ["person", "object", "pet"]:
            entity = TrackedEntity(
                id="test",
                entity_type=entity_type,
                first_seen=0,
                last_seen=0,
                last_position=bbox,
                appearances=[],
                attributes=EntityAttributes(),
            )
            assert entity.entity_type == entity_type


class TestScreenCapture:
    """Tests for ScreenCapture."""

    def test_screen_capture_creation(self) -> None:
        """Test screen capture creation."""
        tile = ScreenTile(id="tile-001", row=0, col=0, x=0, y=0, width=256, height=256)
        capture = ScreenCapture(
            timestamp=1704067200000,
            width=1920,
            height=1080,
            data=b"screen_data",
            tiles=[tile],
        )
        assert capture.width == 1920
        assert capture.height == 1080
        assert len(capture.tiles) == 1


class TestWorldState:
    """Tests for WorldState."""

    def test_world_state_creation(self, sample_tracked_entity: TrackedEntity) -> None:
        """Test world state creation."""
        state = WorldState(
            world_id="world-001",
            entities={"entity-001": sample_tracked_entity},
            last_update=1704067260000,
            active_entities=["entity-001"],
            recently_left=[],
        )
        assert state.world_id == "world-001"
        assert "entity-001" in state.entities
        assert len(state.active_entities) == 1


class TestVisionConfig:
    """Tests for VisionConfig."""

    def test_vision_config_defaults(self, vision_config: VisionConfig) -> None:
        """Test vision config defaults."""
        assert vision_config.pixel_change_threshold == 50.0
        assert vision_config.update_interval == 100
        assert vision_config.vision_mode == VisionMode.CAMERA
        assert vision_config.enable_pose_detection is False
        assert vision_config.enable_object_detection is False

    def test_vision_config_custom_values(self) -> None:
        """Test vision config with custom values."""
        config = VisionConfig(
            camera_name="Custom Camera",
            pixel_change_threshold=25.0,
            vision_mode=VisionMode.BOTH,
            enable_pose_detection=True,
            ocr_enabled=True,
            debug_mode=True,
        )
        assert config.camera_name == "Custom Camera"
        assert config.pixel_change_threshold == 25.0
        assert config.vision_mode == VisionMode.BOTH
        assert config.enable_pose_detection is True
        assert config.ocr_enabled is True
        assert config.debug_mode is True
