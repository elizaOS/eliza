"""Type definitions for the Edge TTS plugin."""

from dataclasses import dataclass

# Default configuration
DEFAULT_VOICE = "en-US-MichelleNeural"
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
    """Edge TTS voice settings configuration.

    Note: The edge-tts library determines language from the voice name and
    always outputs ``audio-24khz-48kbitrate-mono-mp3``. These are not
    configurable via ``Communicate()``, so no ``lang`` or ``output_format``
    fields are exposed here.
    """

    voice: str = DEFAULT_VOICE
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
    rate: str | None = None
    pitch: str | None = None
    volume: str | None = None


# Default settings instance
DEFAULT_SETTINGS = EdgeTTSSettings()
