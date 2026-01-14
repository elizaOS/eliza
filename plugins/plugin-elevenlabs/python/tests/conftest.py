"""Pytest fixtures for ElevenLabs plugin tests."""

import os
from collections.abc import AsyncIterator

import pytest

from eliza_plugin_elevenlabs import ElevenLabsPlugin, ElevenLabsService
from eliza_plugin_elevenlabs.types import (
    ElevenLabsSTTOptions,
    ElevenLabsTTSOptions,
    VoiceSettings,
)


@pytest.fixture
def mock_api_key() -> str:
    """Provide a mock API key for testing."""
    return "test-api-key-12345"


@pytest.fixture
def tts_options(mock_api_key: str) -> ElevenLabsTTSOptions:
    """Provide TTS options for testing."""
    return ElevenLabsTTSOptions(
        api_key=mock_api_key,
        voice_id="test-voice-id",
        model_id="eleven_monolingual_v1",
        output_format="mp3_44100_128",
        voice_settings=VoiceSettings(
            stability=0.5,
            similarity_boost=0.75,
            style=0.0,
            use_speaker_boost=True,
        ),
    )


@pytest.fixture
def stt_options(mock_api_key: str) -> ElevenLabsSTTOptions:
    """Provide STT options for testing."""
    return ElevenLabsSTTOptions(
        api_key=mock_api_key,
        model_id="scribe_v1",
    )


@pytest.fixture
def plugin(
    tts_options: ElevenLabsTTSOptions, stt_options: ElevenLabsSTTOptions
) -> ElevenLabsPlugin:
    """Provide a configured plugin instance for testing."""
    return ElevenLabsPlugin(
        tts_options=tts_options,
        stt_options=stt_options,
    )


@pytest.fixture
async def service(mock_api_key: str) -> AsyncIterator[ElevenLabsService]:
    """Provide a service instance for testing."""
    svc = ElevenLabsService(api_key=mock_api_key)
    yield svc
    await svc.close()


@pytest.fixture
def real_api_key() -> str | None:
    """Get real API key from environment if available."""
    return os.getenv("ELEVENLABS_API_KEY")


@pytest.fixture
def skip_without_api_key(real_api_key: str | None) -> None:
    """Skip test if no real API key is available."""
    if not real_api_key:
        pytest.skip("ELEVENLABS_API_KEY not set")
