"""Speech-to-text shim for the cascaded baseline.

The cascaded baseline transcribes a query's ``audio_bytes`` to text via
Groq Whisper before forwarding to the agent's text path. Missing audio or
missing credentials are hard failures so benchmark reports cannot silently use
ground-truth transcripts.

Direct-audio adapters (future work) bypass this shim entirely.
"""

from __future__ import annotations

import os
from typing import Protocol

from .types import AudioQuery


class STTBackend(Protocol):
    """Minimal STT interface."""

    def transcribe(self, query: AudioQuery) -> str:
        ...


class GroqWhisperSTT:
    """Groq Whisper backend.

    The Groq client is loaded lazily so tests that never call
    :meth:`transcribe` don't need the ``groq`` package or credentials.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str = "whisper-large-v3-turbo",
    ) -> None:
        self._api_key = api_key or os.environ.get("GROQ_API_KEY")
        if not self._api_key:
            raise RuntimeError(
                "GroqWhisperSTT requires GROQ_API_KEY (env or arg)."
            )
        self._model = os.environ.get("GROQ_TRANSCRIPTION_MODEL") or model
        self._client = None

    def _ensure_client(self) -> None:
        if self._client is not None:
            return
        from groq import Groq  # type: ignore[import-not-found]

        self._client = Groq(api_key=self._api_key)

    def transcribe(self, query: AudioQuery) -> str:
        if query.audio_bytes is None:
            raise RuntimeError(
                "VoiceAgentBench task is missing audio bytes; refusing to use "
                "ground-truth transcript as STT output."
            )
        self._ensure_client()
        assert self._client is not None
        response = self._client.audio.transcriptions.create(
            file=("query.wav", query.audio_bytes),
            model=self._model,
            language=query.language,
        )
        text = getattr(response, "text", None)
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError(
                f"Groq Whisper returned no transcript for task language "
                f"{query.language!r}"
            )
        return text


def build_stt() -> STTBackend:
    """Build the real STT backend."""
    return GroqWhisperSTT()
