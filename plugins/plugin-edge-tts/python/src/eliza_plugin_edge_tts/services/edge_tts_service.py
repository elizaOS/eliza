"""Edge TTS service for text-to-speech operations."""

from __future__ import annotations

import os

import edge_tts

from ..types import (
    DEFAULT_LANG,
    DEFAULT_OUTPUT_FORMAT,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_VOICE,
    VOICE_PRESETS,
    EdgeTTSParams,
    EdgeTTSSettings,
)


def resolve_voice(voice: str | None, default_voice: str) -> str:
    """Resolve voice name - handles OpenAI-style voice names and Edge TTS voice IDs.

    Args:
        voice: Voice name or ID to resolve.
        default_voice: Default voice to use if voice is None or empty.

    Returns:
        Resolved Edge TTS voice ID.
    """
    if not voice:
        return default_voice

    preset = VOICE_PRESETS.get(voice.lower())
    if preset:
        return preset

    return voice


def speed_to_rate(speed: float | None) -> str | None:
    """Convert speed multiplier to Edge TTS rate string.

    Speed: 1.0 = normal, 0.5 = half speed, 2.0 = double speed.

    Args:
        speed: Speed multiplier.

    Returns:
        Rate string (e.g., "+50%", "-25%") or None if speed is 1.0 or None.
    """
    if speed is None or speed == 1.0:
        return None
    percentage = round((speed - 1) * 100)
    return f"+{percentage}%" if percentage >= 0 else f"{percentage}%"


def infer_extension(output_format: str) -> str:
    """Infer file extension from Edge TTS output format.

    Args:
        output_format: The Edge TTS output format string.

    Returns:
        File extension including the dot (e.g., ".mp3").
    """
    normalized = output_format.lower()
    if "webm" in normalized:
        return ".webm"
    if "ogg" in normalized:
        return ".ogg"
    if "opus" in normalized:
        return ".opus"
    if any(x in normalized for x in ("wav", "riff", "pcm")):
        return ".wav"
    return ".mp3"


class EdgeTTSService:
    """Service for generating speech using Microsoft Edge TTS.

    Provides free text-to-speech synthesis using the same TTS engine as
    Microsoft Edge browser. No API key required.
    """

    def __init__(
        self,
        settings: EdgeTTSSettings | None = None,
    ) -> None:
        """Initialize the Edge TTS service.

        Args:
            settings: Edge TTS settings. If not provided, settings are loaded from
                environment variables.
        """
        self._settings = settings or self._get_settings_from_env()

    @staticmethod
    def _get_settings_from_env() -> EdgeTTSSettings:
        """Load Edge TTS settings from environment variables."""
        timeout_str = os.getenv("EDGE_TTS_TIMEOUT_MS")
        return EdgeTTSSettings(
            voice=os.getenv("EDGE_TTS_VOICE", DEFAULT_VOICE),
            lang=os.getenv("EDGE_TTS_LANG", DEFAULT_LANG),
            output_format=os.getenv("EDGE_TTS_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT),
            rate=os.getenv("EDGE_TTS_RATE"),
            pitch=os.getenv("EDGE_TTS_PITCH"),
            volume=os.getenv("EDGE_TTS_VOLUME"),
            proxy=os.getenv("EDGE_TTS_PROXY"),
            timeout_ms=int(timeout_str) if timeout_str else DEFAULT_TIMEOUT_MS,
        )

    @property
    def settings(self) -> EdgeTTSSettings:
        """Get the current Edge TTS settings."""
        return self._settings

    async def text_to_speech(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
        rate: str | None = None,
        pitch: str | None = None,
        volume: str | None = None,
    ) -> bytes:
        """Convert text to speech.

        Args:
            text: The text to convert to speech.
            voice: Voice name or ID. Supports OpenAI-style names (alloy, nova, etc.)
                and direct Edge TTS voice IDs.
            speed: Speed multiplier (1.0 = normal, 0.5 = half, 2.0 = double).
            rate: Edge TTS rate string (e.g., "+10%", "-5%"). Overrides speed.
            pitch: Edge TTS pitch string (e.g., "+5Hz", "-10Hz").
            volume: Edge TTS volume string (e.g., "+20%", "-10%").

        Returns:
            Audio data as bytes.

        Raises:
            ValueError: If text is empty or exceeds character limit.
        """
        if not text or not text.strip():
            raise ValueError("Text must not be empty")
        if len(text) > 5000:
            raise ValueError("Text exceeds 5000 character limit")

        resolved_voice = resolve_voice(voice, self._settings.voice)
        resolved_rate = rate or speed_to_rate(speed) or self._settings.rate or "+0%"
        resolved_pitch = pitch or self._settings.pitch or "+0Hz"
        resolved_volume = volume or self._settings.volume or "+0%"

        communicate = edge_tts.Communicate(
            text=text,
            voice=resolved_voice,
            rate=resolved_rate,
            pitch=resolved_pitch,
            volume=resolved_volume,
            proxy=self._settings.proxy,
        )

        audio_chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        return b"".join(audio_chunks)

    async def text_to_speech_with_params(self, params: EdgeTTSParams) -> bytes:
        """Convert text to speech using params object.

        Args:
            params: Edge TTS parameters.

        Returns:
            Audio data as bytes.
        """
        return await self.text_to_speech(
            text=params.text,
            voice=params.voice,
            speed=params.speed,
            rate=params.rate,
            pitch=params.pitch,
            volume=params.volume,
        )

    async def text_to_speech_file(
        self,
        text: str,
        output_path: str,
        voice: str | None = None,
        speed: float | None = None,
        rate: str | None = None,
        pitch: str | None = None,
        volume: str | None = None,
    ) -> str:
        """Convert text to speech and save to file.

        Args:
            text: The text to convert to speech.
            output_path: Path to save the audio file.
            voice: Voice name or ID.
            speed: Speed multiplier.
            rate: Edge TTS rate string. Overrides speed.
            pitch: Edge TTS pitch string.
            volume: Edge TTS volume string.

        Returns:
            The output file path.

        Raises:
            ValueError: If text is empty or exceeds character limit.
        """
        if not text or not text.strip():
            raise ValueError("Text must not be empty")
        if len(text) > 5000:
            raise ValueError("Text exceeds 5000 character limit")

        resolved_voice = resolve_voice(voice, self._settings.voice)
        resolved_rate = rate or speed_to_rate(speed) or self._settings.rate or "+0%"
        resolved_pitch = pitch or self._settings.pitch or "+0Hz"
        resolved_volume = volume or self._settings.volume or "+0%"

        communicate = edge_tts.Communicate(
            text=text,
            voice=resolved_voice,
            rate=resolved_rate,
            pitch=resolved_pitch,
            volume=resolved_volume,
            proxy=self._settings.proxy,
        )

        await communicate.save(output_path)
        return output_path
