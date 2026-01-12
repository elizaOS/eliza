"""Tests for vision plugin configuration."""

from __future__ import annotations

from elizaos_vision.config import ConfigurationManager, default_vision_config
from elizaos_vision.types import VisionConfig, VisionMode


class TestVisionConfig:
    """Tests for VisionConfig."""

    def test_default_config(self) -> None:
        """Test default configuration values."""
        config = VisionConfig()
        assert config.camera_name is None
        assert config.pixel_change_threshold == 50.0
        assert config.update_interval == 100
        assert config.vision_mode == VisionMode.CAMERA

    def test_detection_settings_default_disabled(self) -> None:
        """Test detection settings are disabled by default."""
        config = VisionConfig()
        assert config.enable_pose_detection is False
        assert config.enable_object_detection is False
        assert config.enable_face_recognition is False

    def test_update_intervals(self) -> None:
        """Test update interval settings."""
        config = VisionConfig()
        assert config.tf_update_interval == 1000
        assert config.vlm_update_interval == 10000
        assert config.tf_change_threshold == 10.0
        assert config.vlm_change_threshold == 50.0

    def test_screen_capture_settings(self) -> None:
        """Test screen capture settings."""
        config = VisionConfig()
        assert config.screen_capture_interval == 2000
        assert config.tile_size == 256
        assert config.tile_processing_order == "priority"
        assert config.ocr_enabled is True
        assert config.florence2_enabled is True

    def test_performance_settings(self) -> None:
        """Test performance settings."""
        config = VisionConfig()
        assert config.enable_gpu_acceleration is True
        assert config.max_memory_usage_mb == 2000

    def test_entity_tracking_settings(self) -> None:
        """Test entity tracking settings."""
        config = VisionConfig()
        assert config.entity_timeout == 30000
        assert config.max_tracked_entities == 100
        assert config.face_match_threshold == 0.6
        assert config.max_face_profiles == 1000

    def test_debug_mode_default(self) -> None:
        """Test debug mode is disabled by default."""
        config = VisionConfig()
        assert config.debug_mode is False

    def test_custom_config_values(self) -> None:
        """Test custom configuration values."""
        config = VisionConfig(
            camera_name="Custom Camera",
            pixel_change_threshold=25.0,
            vision_mode=VisionMode.BOTH,
            enable_pose_detection=True,
            enable_object_detection=True,
            enable_face_recognition=True,
            debug_mode=True,
        )
        assert config.camera_name == "Custom Camera"
        assert config.pixel_change_threshold == 25.0
        assert config.vision_mode == VisionMode.BOTH
        assert config.enable_pose_detection is True
        assert config.enable_object_detection is True
        assert config.enable_face_recognition is True
        assert config.debug_mode is True


class TestConfigurationManager:
    """Tests for ConfigurationManager."""

    def test_configuration_manager_exists(self) -> None:
        """Test ConfigurationManager class exists."""
        assert ConfigurationManager is not None

    def test_default_vision_config_exists(self) -> None:
        """Test default_vision_config exists."""
        assert default_vision_config is not None
        # default_vision_config may be a function or an instance
        if callable(default_vision_config):
            config = default_vision_config()
        else:
            config = default_vision_config
        assert isinstance(config, VisionConfig)


class TestVisionModeConfig:
    """Tests for VisionMode in configuration."""

    def test_all_vision_modes_configurable(self) -> None:
        """Test all vision modes can be configured."""
        for mode in VisionMode:
            config = VisionConfig(vision_mode=mode)
            assert config.vision_mode == mode

    def test_vision_mode_off(self) -> None:
        """Test OFF mode configuration."""
        config = VisionConfig(vision_mode=VisionMode.OFF)
        assert config.vision_mode == VisionMode.OFF

    def test_vision_mode_camera(self) -> None:
        """Test CAMERA mode configuration."""
        config = VisionConfig(vision_mode=VisionMode.CAMERA)
        assert config.vision_mode == VisionMode.CAMERA

    def test_vision_mode_screen(self) -> None:
        """Test SCREEN mode configuration."""
        config = VisionConfig(vision_mode=VisionMode.SCREEN)
        assert config.vision_mode == VisionMode.SCREEN

    def test_vision_mode_both(self) -> None:
        """Test BOTH mode configuration."""
        config = VisionConfig(vision_mode=VisionMode.BOTH)
        assert config.vision_mode == VisionMode.BOTH


class TestTileProcessingOrder:
    """Tests for tile processing order configuration."""

    def test_valid_tile_processing_orders(self) -> None:
        """Test valid tile processing order values."""
        for order in ["sequential", "priority", "random"]:
            config = VisionConfig(tile_processing_order=order)
            assert config.tile_processing_order == order

    def test_default_tile_processing_order(self) -> None:
        """Test default tile processing order is priority."""
        config = VisionConfig()
        assert config.tile_processing_order == "priority"
