"""Type definitions for the ElevenLabs plugin."""

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class VoiceSettings:
    """Voice settings configuration for ElevenLabs TTS API."""

    stability: float = 0.5
    similarity_boost: float = 0.75
    style: float = 0.0
    use_speaker_boost: bool = True


@dataclass
class ElevenLabsTTSOptions:
    """Options for text-to-speech generation."""

    api_key: str = ""
    voice_id: str = "EXAVITQu4vr4xnSDxMaL"
    model_id: str = "eleven_monolingual_v1"
    output_format: str = "mp3_44100_128"
    optimize_streaming_latency: int = 0
    voice_settings: VoiceSettings = field(default_factory=VoiceSettings)


@dataclass
class TranscriptionSettings:
    """Settings for speech-to-text transcription."""

    timestamps_granularity: Literal["none", "word", "character"] = "word"
    diarize: bool = False
    num_speakers: int | None = None
    tag_audio_events: bool = False


@dataclass
class ElevenLabsSTTOptions:
    """Options for speech-to-text transcription."""

    api_key: str = ""
    model_id: str = "scribe_v1"
    language_code: str | None = None
    transcription_settings: TranscriptionSettings = field(default_factory=TranscriptionSettings)


# Default TTS options
DEFAULT_TTS_OPTIONS = ElevenLabsTTSOptions()

# Default STT options
DEFAULT_STT_OPTIONS = ElevenLabsSTTOptions()


# Supported output formats for TTS
TTS_OUTPUT_FORMATS = [
    "mp3_22050_32",
    "mp3_44100_32",
    "mp3_44100_64",
    "mp3_44100_96",
    "mp3_44100_128",
    "mp3_44100_192",
    "pcm_16000",
    "pcm_22050",
    "pcm_24000",
    "pcm_44100",
    "ulaw_8000",
]

# Supported STT models
STT_MODELS = [
    "scribe_v1",
]

# Supported TTS models
TTS_MODELS = [
    "eleven_monolingual_v1",
    "eleven_multilingual_v1",
    "eleven_multilingual_v2",
    "eleven_turbo_v2",
    "eleven_turbo_v2_5",
]
