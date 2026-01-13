"""Tests for ElevenLabs plugin."""

import pytest

from eliza_plugin_elevenlabs import ElevenLabsPlugin, elevenlabs_plugin
from eliza_plugin_elevenlabs.types import ElevenLabsSTTOptions, ElevenLabsTTSOptions


class TestElevenLabsPluginInit:
    """Tests for ElevenLabsPlugin initialization."""

    def test_default_plugin(self) -> None:
        """Test default plugin instance."""
        plugin = ElevenLabsPlugin()
        assert plugin.name == "elevenLabs"
        assert "text-to-speech" in plugin.description
        assert "speech-to-text" in plugin.description

    def test_plugin_with_options(
        self, tts_options: ElevenLabsTTSOptions, stt_options: ElevenLabsSTTOptions
    ) -> None:
        """Test plugin with custom options."""
        plugin = ElevenLabsPlugin(tts_options=tts_options, stt_options=stt_options)
        assert plugin.tts_options == tts_options
        assert plugin.stt_options == stt_options


class TestElevenLabsPluginService:
    """Tests for plugin service access."""

    def test_service_property_creates_service(
        self, tts_options: ElevenLabsTTSOptions, stt_options: ElevenLabsSTTOptions
    ) -> None:
        """Test service property creates service instance."""
        plugin = ElevenLabsPlugin(tts_options=tts_options, stt_options=stt_options)
        service = plugin.service
        assert service is not None
        assert service.api_key == tts_options.api_key

    def test_service_property_reuses_service(
        self, tts_options: ElevenLabsTTSOptions, stt_options: ElevenLabsSTTOptions
    ) -> None:
        """Test service property returns same instance."""
        plugin = ElevenLabsPlugin(tts_options=tts_options, stt_options=stt_options)
        service1 = plugin.service
        service2 = plugin.service
        assert service1 is service2


class TestElevenLabsPluginClose:
    """Tests for plugin close functionality."""

    @pytest.mark.asyncio
    async def test_close_releases_service(
        self, tts_options: ElevenLabsTTSOptions, stt_options: ElevenLabsSTTOptions
    ) -> None:
        """Test close releases the service."""
        plugin = ElevenLabsPlugin(tts_options=tts_options, stt_options=stt_options)
        _ = plugin.service  # Create service
        await plugin.close()
        # After close, accessing service creates new instance
        assert plugin._service is None


class TestDefaultPluginInstance:
    """Tests for default plugin instance."""

    def test_elevenlabs_plugin_exists(self) -> None:
        """Test default plugin instance exists."""
        assert elevenlabs_plugin is not None

    def test_elevenlabs_plugin_name(self) -> None:
        """Test default plugin instance name."""
        assert elevenlabs_plugin.name == "elevenLabs"

    def test_elevenlabs_plugin_description(self) -> None:
        """Test default plugin instance description."""
        assert "ElevenLabs" in elevenlabs_plugin.description
