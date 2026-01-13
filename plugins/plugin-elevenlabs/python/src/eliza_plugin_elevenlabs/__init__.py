"""ElevenLabs plugin for ElizaOS - High-quality TTS and STT."""

from .plugin import ElevenLabsPlugin, elevenlabs_plugin
from .services.elevenlabs_service import ElevenLabsService
from .types import (
    DEFAULT_STT_OPTIONS,
    DEFAULT_TTS_OPTIONS,
    ElevenLabsSTTOptions,
    ElevenLabsTTSOptions,
    TranscriptionSettings,
    VoiceSettings,
)

__version__ = "0.1.0"
__all__ = [
    "ElevenLabsTTSOptions",
    "ElevenLabsSTTOptions",
    "VoiceSettings",
    "TranscriptionSettings",
    "DEFAULT_TTS_OPTIONS",
    "DEFAULT_STT_OPTIONS",
    "ElevenLabsService",
    "ElevenLabsPlugin",
    "elevenlabs_plugin",
]
