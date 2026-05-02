"""Edge TTS service for text-to-speech operations."""

from __future__ import annotations

import asyncio
import os

import edge_tts

from ..types import (
    DEFAULT_TIMEOUT_MS,
    DEFAULT_VOICE,
    VOICE_PRESETS,
    EdgeTTSParams,
    EdgeTTSSettings,
)


def resolve_voice(voice: str | None, default_voice: str) -> str:
    """Map OpenAI-style voice names to Edge TTS voice IDs, falling back to *default_voice*."""
    if not voice:
        return default_voice

    preset = VOICE_PRESETS.get(voice.lower())
    if preset:
        return preset

    return voice


def speed_to_rate(speed: float | None) -> str | None:
    """Convert a speed multiplier (1.0 = normal) to an Edge TTS rate string like ``+50%``."""
    if speed is None or speed == 1.0:
        return None
    percentage = round((speed - 1) * 100)
    return f"+{percentage}%" if percentage >= 0 else f"{percentage}%"


def infer_extension(output_format: str) -> str:
    """Return a file extension (e.g. ``".mp3"``) for the given Edge TTS output format."""
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
    """Speech synthesis via Microsoft Edge TTS. No API key required."""

    def __init__(self, settings: EdgeTTSSettings | None = None) -> None:
        self._settings = settings or self._get_settings_from_env()

    @staticmethod
    def _get_settings_from_env() -> EdgeTTSSettings:
        timeout_str = os.getenv("EDGE_TTS_TIMEOUT_MS")
        return EdgeTTSSettings(
            voice=os.getenv("EDGE_TTS_VOICE", DEFAULT_VOICE),
            rate=os.getenv("EDGE_TTS_RATE"),
            pitch=os.getenv("EDGE_TTS_PITCH"),
            volume=os.getenv("EDGE_TTS_VOLUME"),
            proxy=os.getenv("EDGE_TTS_PROXY"),
            timeout_ms=int(timeout_str) if timeout_str else DEFAULT_TIMEOUT_MS,
        )

    @property
    def settings(self) -> EdgeTTSSettings:
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
        """Synthesize *text* and return raw audio bytes.

        Supports OpenAI-style voice names (alloy, nova, ...) and direct Edge TTS
        voice IDs.  *rate* overrides *speed* when both are given.
        """
        if not text or not text.strip():
            raise ValueError("Text must not be empty")
        if len(text) > 5000:
            raise ValueError("Text exceeds 5000 character limit")

        resolved_voice = resolve_voice(voice, self._settings.voice)
        resolved_rate = rate or speed_to_rate(speed) or self._settings.rate or "+0%"
        resolved_pitch = pitch or self._settings.pitch or "+0Hz"
        resolved_volume = volume or self._settings.volume or "+0%"

        timeout_s = self._settings.timeout_ms / 1000

        communicate = edge_tts.Communicate(
            text=text,
            voice=resolved_voice,
            rate=resolved_rate,
            pitch=resolved_pitch,
            volume=resolved_volume,
            proxy=self._settings.proxy,
            receive_timeout=int(timeout_s),
        )

        async def _stream() -> bytes:
            audio_chunks: list[bytes] = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_chunks.append(chunk["data"])
            return b"".join(audio_chunks)

        return await asyncio.wait_for(_stream(), timeout=timeout_s)

    async def text_to_speech_with_params(self, params: EdgeTTSParams) -> bytes:
        """Like :meth:`text_to_speech` but accepts an :class:`EdgeTTSParams` bundle."""
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
        """Synthesize *text* and write the audio to *output_path*. Returns the path."""
        if not text or not text.strip():
            raise ValueError("Text must not be empty")
        if len(text) > 5000:
            raise ValueError("Text exceeds 5000 character limit")

        resolved_voice = resolve_voice(voice, self._settings.voice)
        resolved_rate = rate or speed_to_rate(speed) or self._settings.rate or "+0%"
        resolved_pitch = pitch or self._settings.pitch or "+0Hz"
        resolved_volume = volume or self._settings.volume or "+0%"

        timeout_s = self._settings.timeout_ms / 1000

        communicate = edge_tts.Communicate(
            text=text,
            voice=resolved_voice,
            rate=resolved_rate,
            pitch=resolved_pitch,
            volume=resolved_volume,
            proxy=self._settings.proxy,
            receive_timeout=int(timeout_s),
        )

        await asyncio.wait_for(communicate.save(output_path), timeout=timeout_s)
        return output_path
