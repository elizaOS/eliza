"""ElevenLabs plugin definition for ElizaOS."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .services.elevenlabs_service import ElevenLabsService
from .types import ElevenLabsSTTOptions, ElevenLabsTTSOptions

if TYPE_CHECKING:
    pass


@dataclass
class ElevenLabsPlugin:
    """ElevenLabs plugin for ElizaOS.

    Provides high-quality text-to-speech (TTS) and speech-to-text (STT) capabilities
    using the ElevenLabs API.

    Features:
        - High-quality voice synthesis (TTS)
        - High-accuracy speech transcription (STT) with Scribe v1 model
        - Support for multiple voice models and settings
        - Configurable voice parameters (stability, similarity, style)
        - Stream-based audio output for efficient memory usage
        - Speaker diarization (up to 32 speakers)
        - Multi-language support (99 languages for STT)
        - Audio event detection (laughter, applause, etc.)
    """

    name: str = "elevenLabs"
    description: str = (
        "High-quality text-to-speech synthesis and speech-to-text transcription "
        "using ElevenLabs API with support for multiple voices, languages, "
        "and speaker diarization"
    )

    tts_options: ElevenLabsTTSOptions = field(default_factory=ElevenLabsTTSOptions)
    stt_options: ElevenLabsSTTOptions = field(default_factory=ElevenLabsSTTOptions)

    _service: ElevenLabsService | None = field(default=None, init=False, repr=False)

    @property
    def service(self) -> ElevenLabsService:
        """Get the ElevenLabs service instance."""
        if self._service is None:
            self._service = ElevenLabsService(
                api_key=self.tts_options.api_key or self.stt_options.api_key,
                tts_options=self.tts_options,
                stt_options=self.stt_options,
            )
        return self._service

    async def text_to_speech(self, text: str) -> bytes:
        """Convert text to speech.

        Args:
            text: The text to convert to speech.

        Returns:
            Audio data as bytes.
        """
        return await self.service.text_to_speech_bytes(text)

    async def speech_to_text(self, audio: bytes | str) -> str:
        """Convert speech to text.

        Args:
            audio: Audio data as bytes or URL string.

        Returns:
            Transcribed text.
        """
        return await self.service.speech_to_text(audio)

    async def close(self) -> None:
        """Close the plugin and release resources."""
        if self._service is not None:
            await self._service.close()
            self._service = None


# Default plugin instance
elevenlabs_plugin = ElevenLabsPlugin()
