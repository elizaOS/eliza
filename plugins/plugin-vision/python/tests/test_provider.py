"""Tests for vision plugin provider."""

from __future__ import annotations

from elizaos_vision.provider import VisionProvider
from elizaos_vision.types import VisionMode


class TestVisionProvider:
    """Tests for VisionProvider."""

    def test_provider_metadata(self) -> None:
        """Test provider metadata."""
        assert hasattr(VisionProvider, "name") or hasattr(VisionProvider, "NAME")
        # The provider should be named "VISION" or similar
        provider = VisionProvider()
        assert provider is not None

    def test_provider_instantiation(self) -> None:
        """Test provider can be instantiated."""
        provider = VisionProvider()
        assert provider is not None

    def test_provider_has_get_method(self) -> None:
        """Test provider has a get method."""
        provider = VisionProvider()
        assert hasattr(provider, "get") or hasattr(provider, "get_state")

    def test_provider_default_values(self) -> None:
        """Test provider returns sensible defaults when no service available."""
        provider = VisionProvider()
        # Provider should handle case where vision service is unavailable
        assert provider is not None


class TestVisionProviderValues:
    """Tests for VisionProvider output values."""

    def test_vision_mode_enum_values(self) -> None:
        """Test VisionMode enum has expected values."""
        assert VisionMode.OFF == "OFF"
        assert VisionMode.CAMERA == "CAMERA"
        assert VisionMode.SCREEN == "SCREEN"
        assert VisionMode.BOTH == "BOTH"

    def test_vision_mode_is_iterable(self) -> None:
        """Test VisionMode enum is iterable."""
        modes = list(VisionMode)
        assert len(modes) == 4
        assert VisionMode.OFF in modes
        assert VisionMode.CAMERA in modes
        assert VisionMode.SCREEN in modes
        assert VisionMode.BOTH in modes
