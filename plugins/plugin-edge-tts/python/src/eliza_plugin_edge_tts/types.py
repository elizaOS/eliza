"""Type definitions for the Edge TTS plugin."""

from dataclasses import dataclass

# Default configuration
DEFAULT_VOICE = "en-US-MichelleNeural"
DEFAULT_LANG = "en-US"
DEFAULT_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
DEFAULT_TIMEOUT_MS = 30000

# Voice presets mapping common voice names to Edge TTS voices
VOICE_PRESETS: dict[str, str] = {
    "alloy": "en-US-GuyNeural",
    "echo": "en-US-ChristopherNeural",
    "fable": "en-GB-RyanNeural",
    "onyx": "en-US-DavisNeural",
    "nova": "en-US-JennyNeural",
    "shimmer": "en-US-AriaNeural",
}

# Supported output formats
SUPPORTED_OUTPUT_FORMATS = [
    "audio-24khz-48kbitrate-mono-mp3",
    "audio-24khz-96kbitrate-mono-mp3",
    "audio-48khz-96kbitrate-mono-mp3",
    "audio-48khz-192kbitrate-mono-mp3",
    "webm-24khz-16bit-mono-opus",
    "ogg-24khz-16bit-mono-opus",
    "ogg-48khz-16bit-mono-opus",
    "riff-8khz-16bit-mono-pcm",
    "riff-24khz-16bit-mono-pcm",
    "riff-48khz-16bit-mono-pcm",
]

# Popular voices
POPULAR_VOICES = [
    "en-US-MichelleNeural",
    "en-US-GuyNeural",
    "en-US-JennyNeural",
    "en-US-AriaNeural",
    "en-US-ChristopherNeural",
    "en-US-DavisNeural",
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
    "de-DE-KatjaNeural",
    "fr-FR-DeniseNeural",
    "es-ES-ElviraNeural",
    "ja-JP-NanamiNeural",
    "zh-CN-XiaoxiaoNeural",
]


@dataclass
class EdgeTTSSettings:
    """Edge TTS voice settings configuration."""

    voice: str = DEFAULT_VOICE
    lang: str = DEFAULT_LANG
    output_format: str = DEFAULT_OUTPUT_FORMAT
    rate: str | None = None
    pitch: str | None = None
    volume: str | None = None
    proxy: str | None = None
    timeout_ms: int = DEFAULT_TIMEOUT_MS


@dataclass
class EdgeTTSParams:
    """Extended TTS params with Edge-specific options."""

    text: str = ""
    voice: str | None = None
    speed: float | None = None
    lang: str | None = None
    output_format: str | None = None
    rate: str | None = None
    pitch: str | None = None
    volume: str | None = None


# Default settings instance
DEFAULT_SETTINGS = EdgeTTSSettings()
