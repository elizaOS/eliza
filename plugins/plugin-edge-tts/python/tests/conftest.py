"""Pytest fixtures for Edge TTS plugin tests."""

import pytest

from eliza_plugin_edge_tts import EdgeTTSPlugin, EdgeTTSService
from eliza_plugin_edge_tts.types import EdgeTTSSettings


@pytest.fixture
def default_settings() -> EdgeTTSSettings:
    """Provide default settings for testing."""
    return EdgeTTSSettings()


@pytest.fixture
def custom_settings() -> EdgeTTSSettings:
    """Provide custom settings for testing."""
    return EdgeTTSSettings(
        voice="en-US-GuyNeural",
        lang="en-US",
        rate="+10%",
        pitch="+5Hz",
        volume="+20%",
    )


@pytest.fixture
def plugin(default_settings: EdgeTTSSettings) -> EdgeTTSPlugin:
    """Provide a configured plugin instance for testing."""
    return EdgeTTSPlugin(settings=default_settings)


@pytest.fixture
def service(default_settings: EdgeTTSSettings) -> EdgeTTSService:
    """Provide a service instance for testing."""
    return EdgeTTSService(settings=default_settings)
