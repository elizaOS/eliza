"""Edge TTS plugin for elizaOS - Free text-to-speech using Microsoft Edge TTS."""

from .plugin import EdgeTTSPlugin, edge_tts_plugin
from .services.edge_tts_service import EdgeTTSService
from .types import (
    DEFAULT_SETTINGS,
    VOICE_PRESETS,
    EdgeTTSParams,
    EdgeTTSSettings,
)

__version__ = "0.1.0"
__all__ = [
    "EdgeTTSSettings",
    "EdgeTTSParams",
    "DEFAULT_SETTINGS",
    "VOICE_PRESETS",
    "EdgeTTSService",
    "EdgeTTSPlugin",
    "edge_tts_plugin",
]
