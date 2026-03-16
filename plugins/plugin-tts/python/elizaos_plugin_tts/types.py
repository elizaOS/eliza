"""TTS system types."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Optional


class TtsProvider(str, Enum):
    """Supported TTS providers."""

    ELEVENLABS = "elevenlabs"
    OPENAI = "openai"
    EDGE = "edge"
    SIMPLE_VOICE = "simple-voice"
    AUTO = "auto"


class TtsAutoMode(str, Enum):
    """When to automatically apply TTS."""

    OFF = "off"
    ALWAYS = "always"
    INBOUND = "inbound"
    TAGGED = "tagged"


TtsApplyKind = Literal["tool", "block", "final"]

TtsAudioFormat = Literal["mp3", "opus", "wav"]


@dataclass
class TtsConfig:
    """Full TTS configuration (defaults + session overrides merged)."""

    provider: TtsProvider = TtsProvider.AUTO
    auto: TtsAutoMode = TtsAutoMode.OFF
    max_length: int = 1500
    summarize: bool = True
    voice: Optional[str] = None
    model: Optional[str] = None
    speed: Optional[float] = None


@dataclass
class TtsDirective:
    """Parsed [[tts]] directive options."""

    provider: Optional[TtsProvider] = None
    voice: Optional[str] = None
    model: Optional[str] = None
    speed: Optional[float] = None
    text: Optional[str] = None


@dataclass
class TtsRequest:
    """Request for TTS synthesis."""

    text: str
    provider: Optional[TtsProvider] = None
    voice: Optional[str] = None
    model: Optional[str] = None
    speed: Optional[float] = None
    format: TtsAudioFormat = "mp3"


@dataclass
class TtsResult:
    """Result of TTS synthesis."""

    audio: bytes
    format: str
    provider: TtsProvider
    duration: Optional[float] = None


@dataclass
class TtsSessionConfig:
    """Per-session TTS overrides (all optional)."""

    auto: Optional[TtsAutoMode] = None
    provider: Optional[TtsProvider] = None
    voice: Optional[str] = None
    max_length: Optional[int] = None
    summarize: Optional[bool] = None


DEFAULT_TTS_CONFIG = TtsConfig()

# Provider priority for auto-selection
TTS_PROVIDER_PRIORITY: list[TtsProvider] = [
    TtsProvider.ELEVENLABS,
    TtsProvider.OPENAI,
    TtsProvider.EDGE,
    TtsProvider.SIMPLE_VOICE,
]

# API key environment variable names for each provider
TTS_PROVIDER_API_KEYS: dict[TtsProvider, list[str]] = {
    TtsProvider.ELEVENLABS: ["ELEVENLABS_API_KEY", "XI_API_KEY"],
    TtsProvider.OPENAI: ["OPENAI_API_KEY"],
    TtsProvider.EDGE: [],
    TtsProvider.SIMPLE_VOICE: [],
    TtsProvider.AUTO: [],
}
