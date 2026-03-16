"""Tests for Edge TTS plugin."""

import pytest

from eliza_plugin_edge_tts import EdgeTTSPlugin, edge_tts_plugin
from eliza_plugin_edge_tts.types import EdgeTTSSettings


class TestEdgeTTSPluginInit:
    """Tests for EdgeTTSPlugin initialization."""

    def test_default_plugin(self) -> None:
        """Test default plugin instance."""
        plugin = EdgeTTSPlugin()
        assert plugin.name == "edge-tts"
        assert "text-to-speech" in plugin.description
        assert "free" in plugin.description.lower() or "no api key" in plugin.description.lower()

    def test_plugin_with_settings(self, custom_settings: EdgeTTSSettings) -> None:
        """Test plugin with custom settings."""
        plugin = EdgeTTSPlugin(settings=custom_settings)
        assert plugin.settings == custom_settings
        assert plugin.settings.voice == "en-US-GuyNeural"
        assert plugin.settings.rate == "+10%"

    def test_default_settings(self) -> None:
        """Test default settings values."""
        plugin = EdgeTTSPlugin()
        assert plugin.settings.voice == "en-US-MichelleNeural"
        assert plugin.settings.lang == "en-US"
        assert plugin.settings.output_format == "audio-24khz-48kbitrate-mono-mp3"
        assert plugin.settings.timeout_ms == 30000


class TestEdgeTTSPluginService:
    """Tests for plugin service access."""

    def test_service_property_creates_service(self) -> None:
        """Test service property creates service instance."""
        plugin = EdgeTTSPlugin()
        service = plugin.service
        assert service is not None

    def test_service_property_reuses_service(self) -> None:
        """Test service property returns same instance."""
        plugin = EdgeTTSPlugin()
        service1 = plugin.service
        service2 = plugin.service
        assert service1 is service2

    def test_service_uses_plugin_settings(self, custom_settings: EdgeTTSSettings) -> None:
        """Test service uses plugin settings."""
        plugin = EdgeTTSPlugin(settings=custom_settings)
        assert plugin.service.settings == custom_settings


class TestEdgeTTSPluginClose:
    """Tests for plugin close functionality."""

    @pytest.mark.asyncio
    async def test_close_releases_service(self) -> None:
        """Test close releases the service."""
        plugin = EdgeTTSPlugin()
        _ = plugin.service  # Create service
        await plugin.close()
        assert plugin._service is None

    @pytest.mark.asyncio
    async def test_close_then_access_creates_new_service(self) -> None:
        """Test accessing service after close creates a new instance."""
        plugin = EdgeTTSPlugin()
        service1 = plugin.service
        await plugin.close()
        service2 = plugin.service
        assert service1 is not service2


class TestEdgeTTSPluginLiveTTS:
    """Live tests for plugin TTS (requires network)."""

    @pytest.mark.asyncio
    async def test_text_to_speech(self) -> None:
        """Test generating speech through the plugin."""
        plugin = EdgeTTSPlugin()
        try:
            audio_data = await plugin.text_to_speech("Hello, this is a test.")
            assert isinstance(audio_data, bytes)
            assert len(audio_data) > 0
        except Exception as e:
            error_msg = str(e).lower()
            if "network" in error_msg or "enotfound" in error_msg or "connect" in error_msg:
                pytest.skip(f"Network unavailable: {e}")
            raise
        finally:
            await plugin.close()


class TestDefaultPluginInstance:
    """Tests for default plugin instance."""

    def test_edge_tts_plugin_exists(self) -> None:
        """Test default plugin instance exists."""
        assert edge_tts_plugin is not None

    def test_edge_tts_plugin_name(self) -> None:
        """Test default plugin instance name."""
        assert edge_tts_plugin.name == "edge-tts"

    def test_edge_tts_plugin_description(self) -> None:
        """Test default plugin instance description."""
        assert "edge" in edge_tts_plugin.description.lower()
