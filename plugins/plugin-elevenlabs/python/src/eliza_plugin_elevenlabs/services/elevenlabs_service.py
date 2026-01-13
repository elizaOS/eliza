"""ElevenLabs service for TTS and STT operations."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import BinaryIO

import httpx

from ..types import (
    DEFAULT_STT_OPTIONS,
    DEFAULT_TTS_OPTIONS,
    ElevenLabsSTTOptions,
    ElevenLabsTTSOptions,
    VoiceSettings,
)


class ElevenLabsService:
    """Service for interacting with the ElevenLabs API.

    Provides high-quality text-to-speech (TTS) and speech-to-text (STT) capabilities.
    """

    BASE_URL = "https://api.elevenlabs.io/v1"

    def __init__(
        self,
        api_key: str | None = None,
        tts_options: ElevenLabsTTSOptions | None = None,
        stt_options: ElevenLabsSTTOptions | None = None,
    ) -> None:
        """Initialize the ElevenLabs service.

        Args:
            api_key: ElevenLabs API key. If not provided, will use ELEVENLABS_API_KEY env var.
            tts_options: Text-to-speech options.
            stt_options: Speech-to-text options.
        """
        self._api_key = api_key or os.getenv("ELEVENLABS_API_KEY", "")
        self._tts_options = tts_options or self._get_tts_options_from_env()
        self._stt_options = stt_options or self._get_stt_options_from_env()
        self._client = httpx.AsyncClient(
            base_url=self.BASE_URL,
            headers={"xi-api-key": self._api_key},
            timeout=60.0,
        )

    def _get_tts_options_from_env(self) -> ElevenLabsTTSOptions:
        """Get TTS options from environment variables."""
        return ElevenLabsTTSOptions(
            api_key=self._api_key,
            voice_id=os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_TTS_OPTIONS.voice_id),
            model_id=os.getenv("ELEVENLABS_MODEL_ID", DEFAULT_TTS_OPTIONS.model_id),
            output_format=os.getenv("ELEVENLABS_OUTPUT_FORMAT", DEFAULT_TTS_OPTIONS.output_format),
            optimize_streaming_latency=int(
                os.getenv(
                    "ELEVENLABS_OPTIMIZE_STREAMING_LATENCY",
                    str(DEFAULT_TTS_OPTIONS.optimize_streaming_latency),
                )
            ),
            voice_settings=VoiceSettings(
                stability=float(os.getenv("ELEVENLABS_VOICE_STABILITY", "0.5")),
                similarity_boost=float(os.getenv("ELEVENLABS_VOICE_SIMILARITY_BOOST", "0.75")),
                style=float(os.getenv("ELEVENLABS_VOICE_STYLE", "0.0")),
                use_speaker_boost=os.getenv("ELEVENLABS_VOICE_USE_SPEAKER_BOOST", "true").lower()
                == "true",
            ),
        )

    def _get_stt_options_from_env(self) -> ElevenLabsSTTOptions:
        """Get STT options from environment variables."""
        from ..types import TranscriptionSettings

        language_code = os.getenv("ELEVENLABS_STT_LANGUAGE_CODE")
        num_speakers_str = os.getenv("ELEVENLABS_STT_NUM_SPEAKERS")

        return ElevenLabsSTTOptions(
            api_key=self._api_key,
            model_id=os.getenv("ELEVENLABS_STT_MODEL_ID", DEFAULT_STT_OPTIONS.model_id),
            language_code=language_code if language_code else None,
            transcription_settings=TranscriptionSettings(
                timestamps_granularity=os.getenv(  # type: ignore[arg-type]
                    "ELEVENLABS_STT_TIMESTAMPS_GRANULARITY", "word"
                ),
                diarize=os.getenv("ELEVENLABS_STT_DIARIZE", "false").lower() == "true",
                num_speakers=int(num_speakers_str) if num_speakers_str else None,
                tag_audio_events=os.getenv("ELEVENLABS_STT_TAG_AUDIO_EVENTS", "false").lower()
                == "true",
            ),
        )

    @property
    def api_key(self) -> str:
        """Get the API key."""
        return self._api_key

    @property
    def tts_options(self) -> ElevenLabsTTSOptions:
        """Get TTS options."""
        return self._tts_options

    @property
    def stt_options(self) -> ElevenLabsSTTOptions:
        """Get STT options."""
        return self._stt_options

    async def text_to_speech(
        self,
        text: str,
        voice_id: str | None = None,
        model_id: str | None = None,
        output_format: str | None = None,
        voice_settings: VoiceSettings | None = None,
    ) -> AsyncIterator[bytes]:
        """Convert text to speech using ElevenLabs API.

        Args:
            text: The text to convert to speech.
            voice_id: Voice ID to use. Defaults to configured voice.
            model_id: Model ID to use. Defaults to configured model.
            output_format: Output format. Defaults to configured format.
            voice_settings: Voice settings. Defaults to configured settings.

        Yields:
            Audio data chunks as bytes.

        Raises:
            httpx.HTTPStatusError: If the API request fails.
        """
        resolved_voice_id = voice_id or self._tts_options.voice_id
        resolved_model_id = model_id or self._tts_options.model_id
        resolved_format = output_format or self._tts_options.output_format
        resolved_settings = voice_settings or self._tts_options.voice_settings

        url = f"/text-to-speech/{resolved_voice_id}/stream"

        payload = {
            "text": text,
            "model_id": resolved_model_id,
            "output_format": resolved_format,
            "voice_settings": {
                "stability": resolved_settings.stability,
                "similarity_boost": resolved_settings.similarity_boost,
                "style": resolved_settings.style,
                "use_speaker_boost": resolved_settings.use_speaker_boost,
            },
        }

        async with self._client.stream("POST", url, json=payload) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                yield chunk

    async def text_to_speech_bytes(
        self,
        text: str,
        voice_id: str | None = None,
        model_id: str | None = None,
        output_format: str | None = None,
        voice_settings: VoiceSettings | None = None,
    ) -> bytes:
        """Convert text to speech and return complete audio data.

        Args:
            text: The text to convert to speech.
            voice_id: Voice ID to use. Defaults to configured voice.
            model_id: Model ID to use. Defaults to configured model.
            output_format: Output format. Defaults to configured format.
            voice_settings: Voice settings. Defaults to configured settings.

        Returns:
            Complete audio data as bytes.
        """
        chunks: list[bytes] = []
        async for chunk in self.text_to_speech(
            text, voice_id, model_id, output_format, voice_settings
        ):
            chunks.append(chunk)
        return b"".join(chunks)

    async def speech_to_text(
        self,
        audio: bytes | BinaryIO | str,
        model_id: str | None = None,
        language_code: str | None = None,
    ) -> str:
        """Convert speech to text using ElevenLabs API.

        Args:
            audio: Audio data as bytes, file-like object, or URL string.
            model_id: Model ID to use. Defaults to configured model.
            language_code: Language code for transcription. Defaults to auto-detect.

        Returns:
            Transcribed text.

        Raises:
            httpx.HTTPStatusError: If the API request fails.
        """
        resolved_model_id = model_id or self._stt_options.model_id
        resolved_language = language_code or self._stt_options.language_code
        settings = self._stt_options.transcription_settings

        # Handle URL input
        if isinstance(audio, str):
            async with httpx.AsyncClient() as client:
                response = await client.get(audio)
                response.raise_for_status()
                audio_data = response.content
        elif isinstance(audio, bytes):
            audio_data = audio
        else:
            audio_data = audio.read()

        url = "/speech-to-text"

        # Build form data
        files = {"audio": ("audio.mp3", audio_data, "audio/mpeg")}
        data: dict[str, str | int] = {"model_id": resolved_model_id}

        if resolved_language:
            data["language_code"] = resolved_language

        if settings.timestamps_granularity != "none":
            data["timestamps_granularity"] = settings.timestamps_granularity

        if settings.diarize:
            data["diarize"] = "true"
            if settings.num_speakers:
                data["num_speakers"] = settings.num_speakers

        if settings.tag_audio_events:
            data["tag_audio_events"] = "true"

        response = await self._client.post(url, files=files, data=data)
        response.raise_for_status()

        result = response.json()

        # Extract transcript from response
        if "text" in result:
            return str(result["text"])
        if "transcript" in result:
            transcript = result["transcript"]
            if isinstance(transcript, dict) and "text" in transcript:
                return str(transcript["text"])
        if "transcripts" in result:
            transcripts = result["transcripts"]
            texts = [str(t.get("text", "")) for t in transcripts if isinstance(t, dict)]
            return "\n".join(texts)

        return ""

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> ElevenLabsService:
        """Enter async context."""
        return self

    async def __aexit__(self, *args: object) -> None:
        """Exit async context."""
        await self.close()
