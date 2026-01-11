"""
Vision Plugin Type Definitions
Complete type definitions for the ElizaOS vision plugin
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


class VisionMode(str, Enum):
    """Vision processing modes"""

    OFF = "OFF"
    CAMERA = "CAMERA"
    SCREEN = "SCREEN"
    BOTH = "BOTH"


@dataclass
class Point2D:
    """Point in 2D space"""

    x: float
    y: float


@dataclass
class BoundingBox:
    """Bounding box for detected objects"""

    x: float
    y: float
    width: float
    height: float

    def center(self) -> Point2D:
        """Get the center point of the bounding box"""
        return Point2D(x=self.x + self.width / 2, y=self.y + self.height / 2)

    def area(self) -> float:
        """Get the area of the bounding box"""
        return self.width * self.height

    def aspect_ratio(self) -> float:
        """Get the aspect ratio (width/height)"""
        return self.width / self.height if self.height > 0 else 0


@dataclass
class CameraInfo:
    """Camera device information"""

    id: str
    name: str
    connected: bool


@dataclass
class VisionFrame:
    """Vision frame captured from camera"""

    timestamp: int
    width: int
    height: int
    data: bytes
    format: Literal["rgb", "rgba", "jpeg", "png"]


@dataclass
class DetectedObject:
    """Detected object in a scene"""

    id: str
    type: str
    confidence: float
    bounding_box: BoundingBox


@dataclass
class Keypoint:
    """Keypoint for pose detection"""

    part: str
    position: Point2D
    score: float


@dataclass
class PersonInfo:
    """Detected person information"""

    id: str
    pose: Literal["sitting", "standing", "lying", "unknown"]
    facing: Literal["camera", "away", "left", "right", "unknown"]
    confidence: float
    bounding_box: BoundingBox
    keypoints: list[Keypoint] = field(default_factory=list)


@dataclass
class SceneDescription:
    """Scene description from vision analysis"""

    timestamp: int
    description: str
    objects: list[DetectedObject]
    people: list[PersonInfo]
    scene_changed: bool
    change_percentage: float
    audio_transcription: str | None = None


@dataclass
class OCRBlock:
    """OCR text block"""

    text: str
    bbox: BoundingBox
    confidence: float
    words: list[OCRWord] = field(default_factory=list)


@dataclass
class OCRWord:
    """OCR word"""

    text: str
    bbox: BoundingBox
    confidence: float


@dataclass
class OCRResult:
    """OCR result from text extraction"""

    text: str
    blocks: list[OCRBlock]
    full_text: str


@dataclass
class Florence2Result:
    """Florence-2 model result"""

    caption: str | None = None
    objects: list[dict] = field(default_factory=list)
    regions: list[dict] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)


@dataclass
class TileAnalysis:
    """Analysis result for a screen tile"""

    timestamp: int
    florence2: Florence2Result | None = None
    ocr: OCRResult | None = None
    objects: list[DetectedObject] = field(default_factory=list)
    text: str | None = None
    summary: str | None = None


@dataclass
class ScreenTile:
    """Screen tile for tiled processing"""

    id: str
    row: int
    col: int
    x: int
    y: int
    width: int
    height: int
    data: bytes | None = None
    analysis: TileAnalysis | None = None


@dataclass
class ScreenCapture:
    """Screen capture result"""

    timestamp: int
    width: int
    height: int
    data: bytes
    tiles: list[ScreenTile]


@dataclass
class ScreenAnalysis:
    """Screen analysis data"""

    full_screen_ocr: str | None = None
    active_tile: TileAnalysis | None = None
    grid_summary: str | None = None
    focused_app: str | None = None
    ui_elements: list[dict] = field(default_factory=list)


@dataclass
class EnhancedSceneDescription(SceneDescription):
    """Enhanced scene description with screen data"""

    screen_capture: ScreenCapture | None = None
    screen_analysis: ScreenAnalysis | None = None


@dataclass
class EntityAppearance:
    """Entity appearance record"""

    timestamp: int
    bounding_box: BoundingBox
    confidence: float
    embedding: list[float] | None = None
    keypoints: list[Keypoint] = field(default_factory=list)


@dataclass
class EntityAttributes:
    """Entity attributes"""

    # For people
    name: str | None = None
    face_embedding: list[float] | None = None
    face_id: str | None = None
    clothing: list[str] = field(default_factory=list)
    hair_color: str | None = None
    accessories: list[str] = field(default_factory=list)

    # For objects
    object_type: str | None = None
    color: str | None = None
    size: Literal["small", "medium", "large"] | None = None

    # Common
    description: str | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class TrackedEntity:
    """Tracked entity"""

    id: str
    entity_type: Literal["person", "object", "pet"]
    first_seen: int
    last_seen: int
    last_position: BoundingBox
    appearances: list[EntityAppearance]
    attributes: EntityAttributes
    world_id: str | None = None
    room_id: str | None = None


@dataclass
class RecentlyLeftEntity:
    """Recently departed entity"""

    entity_id: str
    left_at: int
    last_position: BoundingBox


@dataclass
class WorldState:
    """World state for entity tracking"""

    world_id: str
    entities: dict[str, TrackedEntity]
    last_update: int
    active_entities: list[str]
    recently_left: list[RecentlyLeftEntity]


@dataclass
class VisionConfig:
    """Vision configuration"""

    # Camera
    camera_name: str | None = None
    pixel_change_threshold: float = 50.0
    update_interval: int = 100

    # Detection
    enable_pose_detection: bool = False
    enable_object_detection: bool = False
    enable_face_recognition: bool = False

    # Update intervals
    tf_update_interval: int = 1000
    vlm_update_interval: int = 10000
    tf_change_threshold: float = 10.0
    vlm_change_threshold: float = 50.0

    # Vision mode
    vision_mode: VisionMode = VisionMode.CAMERA

    # Screen capture
    screen_capture_interval: int = 2000
    tile_size: int = 256
    tile_processing_order: Literal["sequential", "priority", "random"] = "priority"
    ocr_enabled: bool = True
    florence2_enabled: bool = True
    display_index: int | None = None
    capture_all_displays: bool = False
    target_screen_fps: int | None = None

    # Performance
    enable_gpu_acceleration: bool = True
    max_memory_usage_mb: int = 2000

    # Entity tracking
    entity_timeout: int = 30000
    max_tracked_entities: int = 100
    face_match_threshold: float = 0.6
    max_face_profiles: int = 1000

    # Logging
    debug_mode: bool = False
