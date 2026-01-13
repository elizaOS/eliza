from __future__ import annotations

import logging
import os
from typing import Any, Protocol

from pydantic import BaseModel, Field, ValidationError

from .types import VisionConfig, VisionMode

logger = logging.getLogger(__name__)


default_vision_config = VisionConfig()


class ConfigSchema(BaseModel):
    camera_name: str | None = None
    enable_camera: bool = True

    # Vision processing
    pixel_change_threshold: float = Field(default=50, ge=0, le=100)
    update_interval: int = Field(default=100, ge=10, le=10000)

    # Object detection
    enable_object_detection: bool = False
    object_confidence_threshold: float = Field(default=0.5, ge=0, le=1)

    # Pose detection
    enable_pose_detection: bool = False
    pose_confidence_threshold: float = Field(default=0.5, ge=0, le=1)

    # Face recognition
    enable_face_recognition: bool = False
    face_match_threshold: float = Field(default=0.6, ge=0, le=1)
    max_face_profiles: int = Field(default=1000, ge=10, le=10000)

    # Update intervals
    tf_update_interval: int = Field(default=1000, ge=100, le=60000)
    vlm_update_interval: int = Field(default=10000, ge=1000, le=300000)
    tf_change_threshold: float = Field(default=10, ge=0, le=100)
    vlm_change_threshold: float = Field(default=50, ge=0, le=100)

    # Vision mode
    vision_mode: VisionMode = VisionMode.CAMERA

    # Screen capture
    screen_capture_interval: int = Field(default=2000, ge=100, le=60000)
    tile_size: int = Field(default=256, ge=64, le=1024)
    tile_processing_order: str = Field(default="priority")
    max_concurrent_tiles: int = Field(default=3, ge=1, le=10)

    # OCR configuration
    ocr_enabled: bool = True
    ocr_language: str = "eng"
    ocr_confidence_threshold: float = Field(default=60, ge=0, le=100)

    # Florence-2 configuration
    florence2_enabled: bool = True
    florence2_provider: str | None = None
    florence2_endpoint: str | None = None
    florence2_timeout: int = Field(default=30000, ge=1000, le=300000)

    # Entity tracking
    entity_timeout: int = Field(default=30000, ge=1000, le=300000)
    max_tracked_entities: int = Field(default=100, ge=10, le=1000)

    # Performance
    enable_gpu_acceleration: bool = True
    max_memory_usage_mb: int = Field(default=2000, ge=100, le=8000)

    # Logging
    debug_mode: bool = False
    log_level: str = Field(default="info")


class RuntimeProtocol(Protocol):
    def get_setting(self, key: str) -> str | None: ...


class ConfigurationManager:
    def __init__(self, runtime: RuntimeProtocol | None = None):
        self._runtime = runtime
        self._config = self._load_configuration()

    def _get_setting(self, key: str) -> str | None:
        vision_key = f"VISION_{key}"

        if self._runtime:
            value = self._runtime.get_setting(vision_key)
            if value:
                return value
            value = self._runtime.get_setting(key)
            if value:
                return value

        value = os.environ.get(vision_key)
        if value:
            return value
        return os.environ.get(key)

    def _get_bool_setting(self, key: str, default: bool) -> bool:
        value = self._get_setting(key)
        if value is None:
            return default
        return value.lower() == "true"

    def _get_int_setting(self, key: str, default: int) -> int:
        value = self._get_setting(key)
        if value is None:
            return default
        try:
            return int(value)
        except ValueError:
            return default

    def _get_float_setting(self, key: str, default: float) -> float:
        value = self._get_setting(key)
        if value is None:
            return default
        try:
            return float(value)
        except ValueError:
            return default

    def _load_configuration(self) -> ConfigSchema:
        raw_config: dict[str, Any] = {
            "camera_name": self._get_setting("CAMERA_NAME"),
            "enable_camera": self._get_bool_setting("ENABLE_CAMERA", True),
            "pixel_change_threshold": self._get_float_setting("PIXEL_CHANGE_THRESHOLD", 50),
            "update_interval": self._get_int_setting("UPDATE_INTERVAL", 100),
            "enable_object_detection": self._get_bool_setting("ENABLE_OBJECT_DETECTION", False),
            "object_confidence_threshold": self._get_float_setting(
                "OBJECT_CONFIDENCE_THRESHOLD", 0.5
            ),
            "enable_pose_detection": self._get_bool_setting("ENABLE_POSE_DETECTION", False),
            "pose_confidence_threshold": self._get_float_setting("POSE_CONFIDENCE_THRESHOLD", 0.5),
            # Face recognition
            "enable_face_recognition": self._get_bool_setting("ENABLE_FACE_RECOGNITION", False),
            "face_match_threshold": self._get_float_setting("FACE_MATCH_THRESHOLD", 0.6),
            "max_face_profiles": self._get_int_setting("MAX_FACE_PROFILES", 1000),
            "tf_update_interval": self._get_int_setting("TF_UPDATE_INTERVAL", 1000),
            "vlm_update_interval": self._get_int_setting("VLM_UPDATE_INTERVAL", 10000),
            "tf_change_threshold": self._get_float_setting("TF_CHANGE_THRESHOLD", 10),
            "vlm_change_threshold": self._get_float_setting("VLM_CHANGE_THRESHOLD", 50),
            "screen_capture_interval": self._get_int_setting("SCREEN_CAPTURE_INTERVAL", 2000),
            "tile_size": self._get_int_setting("TILE_SIZE", 256),
            "tile_processing_order": self._get_setting("TILE_PROCESSING_ORDER") or "priority",
            "max_concurrent_tiles": self._get_int_setting("MAX_CONCURRENT_TILES", 3),
            # OCR
            "ocr_enabled": self._get_bool_setting("OCR_ENABLED", True),
            "ocr_language": self._get_setting("OCR_LANGUAGE") or "eng",
            "ocr_confidence_threshold": self._get_float_setting("OCR_CONFIDENCE_THRESHOLD", 60),
            "florence2_enabled": self._get_bool_setting("FLORENCE2_ENABLED", True),
            "florence2_provider": self._get_setting("FLORENCE2_PROVIDER"),
            "florence2_endpoint": self._get_setting("FLORENCE2_ENDPOINT"),
            "florence2_timeout": self._get_int_setting("FLORENCE2_TIMEOUT", 30000),
            # Entity tracking
            "entity_timeout": self._get_int_setting("ENTITY_TIMEOUT", 30000),
            "max_tracked_entities": self._get_int_setting("MAX_TRACKED_ENTITIES", 100),
            "enable_gpu_acceleration": self._get_bool_setting("ENABLE_GPU_ACCELERATION", True),
            "max_memory_usage_mb": self._get_int_setting("MAX_MEMORY_USAGE_MB", 2000),
            # Logging
            "debug_mode": self._get_bool_setting("DEBUG_MODE", False),
            "log_level": self._get_setting("LOG_LEVEL") or "info",
        }

        vision_mode_str = self._get_setting("VISION_MODE")
        if vision_mode_str:
            try:
                raw_config["vision_mode"] = VisionMode(vision_mode_str.upper())
            except ValueError:
                raw_config["vision_mode"] = VisionMode.CAMERA

        raw_config = {k: v for k, v in raw_config.items() if v is not None}

        try:
            config = ConfigSchema(**raw_config)
            logger.info("[ConfigurationManager] Configuration loaded successfully")
            if config.debug_mode:
                logger.debug(f"[ConfigurationManager] Configuration: {config}")
            return config
        except ValidationError as e:
            logger.error(f"[ConfigurationManager] Invalid configuration: {e}")
            return ConfigSchema()

    def get(self) -> ConfigSchema:
        return self._config

    def update(self, updates: dict[str, Any]) -> None:
        """Update configuration with new values"""
        try:
            current = self._config.model_dump()
            current.update(updates)
            self._config = ConfigSchema(**current)
            logger.info("[ConfigurationManager] Configuration updated")
        except ValidationError as e:
            logger.error(f"[ConfigurationManager] Failed to update configuration: {e}")
            raise

    def to_vision_config(self) -> VisionConfig:
        return VisionConfig(
            camera_name=self._config.camera_name,
            pixel_change_threshold=self._config.pixel_change_threshold,
            update_interval=self._config.update_interval,
            enable_object_detection=self._config.enable_object_detection,
            enable_pose_detection=self._config.enable_pose_detection,
            enable_face_recognition=self._config.enable_face_recognition,
            tf_update_interval=self._config.tf_update_interval,
            vlm_update_interval=self._config.vlm_update_interval,
            tf_change_threshold=self._config.tf_change_threshold,
            vlm_change_threshold=self._config.vlm_change_threshold,
            vision_mode=self._config.vision_mode,
            screen_capture_interval=self._config.screen_capture_interval,
            tile_size=self._config.tile_size,
            tile_processing_order=self._config.tile_processing_order,
            ocr_enabled=self._config.ocr_enabled,
            florence2_enabled=self._config.florence2_enabled,
            entity_timeout=self._config.entity_timeout,
            max_tracked_entities=self._config.max_tracked_entities,
            face_match_threshold=self._config.face_match_threshold,
            max_face_profiles=self._config.max_face_profiles,
        )

    @staticmethod
    def get_preset(name: str) -> dict[str, Any]:
        presets: dict[str, dict[str, Any]] = {
            "high-performance": {
                "update_interval": 50,
                "tf_update_interval": 500,
                "vlm_update_interval": 5000,
                "enable_gpu_acceleration": True,
                "max_concurrent_tiles": 5,
            },
            "low-resource": {
                "update_interval": 200,
                "tf_update_interval": 2000,
                "vlm_update_interval": 20000,
                "enable_object_detection": False,
                "enable_pose_detection": False,
                "max_memory_usage_mb": 500,
                "max_concurrent_tiles": 1,
            },
            "security-monitoring": {
                "enable_object_detection": True,
                "enable_pose_detection": True,
                "enable_face_recognition": True,
                "update_interval": 100,
                "entity_timeout": 60000,
            },
            "screen-reader": {
                "vision_mode": VisionMode.SCREEN,
                "ocr_enabled": True,
                "florence2_enabled": True,
                "screen_capture_interval": 1000,
                "tile_processing_order": "priority",
            },
        }
        return presets.get(name, {})
