"""Speech-to-text shim for the cascaded baseline.

The cascaded baseline transcribes a query's ``audio_bytes`` to text via
Groq Whisper before forwarding to the agent's text path. When no audio
is attached (text-only fixture runs) or when ``--mock`` is set, the
shim returns the query's ground-truth transcript so smoke tests stay
deterministic.

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


class TranscriptPassthroughSTT:
    """Returns ``query.transcript`` unchanged.

    Used in mock mode and when audio bytes are absent. Deterministic,
    requires no credentials.
    """

    def transcribe(self, query: AudioQuery) -> str:
        return query.transcript


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
                "GroqWhisperSTT requires GROQ_API_KEY (env or arg). Use "
                "TranscriptPassthroughSTT for mock / fixture runs."
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
            return query.transcript
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


def build_stt(*, mock: bool) -> STTBackend:
    """Pick an STT backend based on run mode."""
    if mock:
        return TranscriptPassthroughSTT()
    if os.environ.get("GROQ_API_KEY"):
        return GroqWhisperSTT()
    return TranscriptPassthroughSTT()
