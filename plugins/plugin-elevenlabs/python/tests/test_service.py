"""Tests for ElevenLabs service."""

import pytest

from eliza_plugin_elevenlabs import ElevenLabsService
from eliza_plugin_elevenlabs.types import ElevenLabsTTSOptions, VoiceSettings


class TestElevenLabsServiceInit:
    """Tests for ElevenLabsService initialization."""

    def test_init_with_api_key(self, mock_api_key: str) -> None:
        """Test service initialization with API key."""
        service = ElevenLabsService(api_key=mock_api_key)
        assert service.api_key == mock_api_key

    def test_init_without_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test service initialization without API key uses empty string."""
        # Clear the environment variable to test default behavior
        monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
        service = ElevenLabsService()
        assert service.api_key == ""

    def test_tts_options_from_env(self, mock_api_key: str) -> None:
        """Test TTS options are loaded from environment."""
        service = ElevenLabsService(api_key=mock_api_key)
        assert service.tts_options is not None
        assert service.tts_options.voice_id == "EXAVITQu4vr4xnSDxMaL"

    def test_stt_options_from_env(self, mock_api_key: str) -> None:
        """Test STT options are loaded from environment."""
        service = ElevenLabsService(api_key=mock_api_key)
        assert service.stt_options is not None
        assert service.stt_options.model_id == "scribe_v1"


class TestElevenLabsServiceOptions:
    """Tests for service option handling."""

    def test_custom_tts_options(self, mock_api_key: str) -> None:
        """Test service with custom TTS options."""
        options = ElevenLabsTTSOptions(
            api_key=mock_api_key,
            voice_id="custom-voice",
            model_id="eleven_multilingual_v2",
        )
        service = ElevenLabsService(api_key=mock_api_key, tts_options=options)
        assert service.tts_options.voice_id == "custom-voice"
        assert service.tts_options.model_id == "eleven_multilingual_v2"

    def test_voice_settings(self, mock_api_key: str) -> None:
        """Test voice settings configuration."""
        voice_settings = VoiceSettings(
            stability=0.8,
            similarity_boost=0.9,
            style=0.3,
            use_speaker_boost=False,
        )
        options = ElevenLabsTTSOptions(
            api_key=mock_api_key,
            voice_settings=voice_settings,
        )
        service = ElevenLabsService(api_key=mock_api_key, tts_options=options)
        assert service.tts_options.voice_settings.stability == 0.8
        assert service.tts_options.voice_settings.similarity_boost == 0.9


class TestElevenLabsServiceContextManager:
    """Tests for service context manager."""

    @pytest.mark.asyncio
    async def test_async_context_manager(self, mock_api_key: str) -> None:
        """Test service can be used as async context manager."""
        async with ElevenLabsService(api_key=mock_api_key) as service:
            assert service.api_key == mock_api_key


class TestElevenLabsServiceValidation:
    """Tests for service validation."""

    def test_api_key_property(self, mock_api_key: str) -> None:
        """Test API key property returns correct value."""
        service = ElevenLabsService(api_key=mock_api_key)
        assert service.api_key == mock_api_key

    def test_base_url(self, mock_api_key: str) -> None:
        """Test base URL is correct."""
        service = ElevenLabsService(api_key=mock_api_key)
        assert service.BASE_URL == "https://api.elevenlabs.io/v1"
