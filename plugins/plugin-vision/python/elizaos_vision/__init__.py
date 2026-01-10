"""
ElizaOS Vision Plugin
Provides visual perception through camera integration and scene analysis
"""

from .types import (
    VisionMode,
    BoundingBox,
    Point2D,
    CameraInfo,
    VisionFrame,
    DetectedObject,
    Keypoint,
    PersonInfo,
    SceneDescription,
    ScreenTile,
    OCRResult,
    OCRBlock,
    ScreenCapture,
    EnhancedSceneDescription,
    TrackedEntity,
    EntityAppearance,
    EntityAttributes,
    WorldState,
    VisionConfig,
)
from .config import ConfigurationManager, default_vision_config
from .errors import (
    VisionError,
    CameraError,
    ScreenCaptureError,
    ModelInitializationError,
    ProcessingError,
    ConfigurationError,
    APIError,
    ErrorRecoveryManager,
    CircuitBreaker,
    VisionErrorHandler,
)
from .entity_tracker import EntityTracker
from .screen_capture import ScreenCaptureService
from .ocr import OCRService
from .service import VisionService
from .provider import VisionProvider
from .actions import (
    describe_scene_action,
    capture_image_action,
    set_vision_mode_action,
    name_entity_action,
    identify_person_action,
    track_entity_action,
    kill_autonomous_action,
)

__version__ = "1.3.0"

__all__ = [
    # Version
    "__version__",
    # Types
    "VisionMode",
    "BoundingBox",
    "Point2D",
    "CameraInfo",
    "VisionFrame",
    "DetectedObject",
    "Keypoint",
    "PersonInfo",
    "SceneDescription",
    "ScreenTile",
    "OCRResult",
    "OCRBlock",
    "ScreenCapture",
    "EnhancedSceneDescription",
    "TrackedEntity",
    "EntityAppearance",
    "EntityAttributes",
    "WorldState",
    "VisionConfig",
    # Config
    "ConfigurationManager",
    "default_vision_config",
    # Errors
    "VisionError",
    "CameraError",
    "ScreenCaptureError",
    "ModelInitializationError",
    "ProcessingError",
    "ConfigurationError",
    "APIError",
    "ErrorRecoveryManager",
    "CircuitBreaker",
    "VisionErrorHandler",
    # Services
    "EntityTracker",
    "ScreenCaptureService",
    "OCRService",
    "VisionService",
    "VisionProvider",
    # Actions
    "describe_scene_action",
    "capture_image_action",
    "set_vision_mode_action",
    "name_entity_action",
    "identify_person_action",
    "track_entity_action",
    "kill_autonomous_action",
]


def create_plugin():
    """Create and return the vision plugin configuration."""
    return {
        "name": "vision",
        "description": "Provides visual perception through camera integration and scene analysis",
        "services": [VisionService],
        "providers": [VisionProvider],
        "actions": [
            describe_scene_action,
            capture_image_action,
            set_vision_mode_action,
            name_entity_action,
            identify_person_action,
            track_entity_action,
            kill_autonomous_action,
        ],
    }

