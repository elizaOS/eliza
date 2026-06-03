"""Speech-to-text shim for the cascaded baseline.

The cascaded baseline transcribes a query's ``audio_bytes`` to text before
forwarding to the agent's text path. Missing audio or missing credentials are
hard failures so benchmark reports cannot silently use ground-truth transcripts.

Direct-audio adapters bypass this shim entirely.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
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


class FixtureTranscriptSTT:
    """No-cost STT backend for annotated fixture records."""

    def transcribe(self, query: AudioQuery) -> str:
        return query.transcript


class ElizaRuntimeSTT:
    """Local Eliza runtime STT backend.

    This posts real audio bytes to an OpenAI-compatible transcription route
    exposed by a local Eliza runtime. It is intentionally not a transcript
    fallback: missing audio, missing endpoint configuration, HTTP failures, or
    empty text all fail the benchmark run.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        model: str = "whisper-large-v3-turbo",
    ) -> None:
        resolved = (
            base_url
            or os.environ.get("ELIZA_API_BASE")
            or os.environ.get("ELIZA_BENCH_URL")
            or ""
        ).strip()
        if not resolved:
            raise RuntimeError(
                "ElizaRuntimeSTT requires ELIZA_API_BASE or ELIZA_BENCH_URL."
            )
        self._url = f"{resolved.rstrip('/')}/v1/audio/transcriptions"
        self._model = os.environ.get("VOICEAGENTBENCH_STT_MODEL") or model

    def transcribe(self, query: AudioQuery) -> str:
        if query.audio_bytes is None:
            raise RuntimeError(
                "VoiceAgentBench task is missing audio bytes; refusing to use "
                "ground-truth transcript as STT output."
            )
        import httpx

        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                self._url,
                files={"file": ("query.wav", query.audio_bytes, "audio/wav")},
                data={
                    "model": self._model,
                    "language": query.language,
                    "response_format": "json",
                },
            )
        response.raise_for_status()
        payload = response.json()
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError(f"Eliza STT returned no transcript: {payload!r}")
        return text


class FasterWhisperSTT:
    """Local faster-whisper backend over real audio bytes."""

    def __init__(self, *, model: str | None = None) -> None:
        self._model_name = (
            model
            or os.environ.get("VOICEAGENTBENCH_FASTER_WHISPER_MODEL")
            or os.environ.get("FASTER_WHISPER_MODEL")
            or "base.en"
        )
        self._model = None

    def _ensure_model(self):
        if self._model is not None:
            return self._model
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]

        self._model = WhisperModel(self._model_name, device="auto", compute_type="auto")
        return self._model

    def transcribe(self, query: AudioQuery) -> str:
        if query.audio_bytes is None:
            raise RuntimeError(
                "VoiceAgentBench task is missing audio bytes; refusing to use "
                "ground-truth transcript as STT output."
            )
        model = self._ensure_model()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
            fh.write(query.audio_bytes)
            audio_path = Path(fh.name)
        try:
            segments, _info = model.transcribe(
                str(audio_path),
                language=query.language or None,
                beam_size=1,
                vad_filter=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
        finally:
            audio_path.unlink(missing_ok=True)
        if not text:
            raise RuntimeError("faster-whisper returned no transcript")
        return text


class Eliza1STT:
    """Local eliza-1 llama.cpp ASR backend over real audio bytes."""

    def __init__(self) -> None:
        from .eliza1_asr import Eliza1ASRBackend

        self._backend = Eliza1ASRBackend()

    def transcribe(self, query: AudioQuery) -> str:
        if query.audio_bytes is None:
            raise RuntimeError(
                "VoiceAgentBench task is missing audio bytes; refusing to use "
                "ground-truth transcript as STT output."
            )
        return self._backend.transcribe_bytes(
            query.audio_bytes, language=query.language
        )


def build_stt(*, mock: bool = False, provider: str = "groq") -> STTBackend:
    """Build the real STT backend."""
    if mock:
        return FixtureTranscriptSTT()
    selected = provider.strip().lower()
    if selected == "groq":
        return GroqWhisperSTT()
    if selected == "eliza-runtime":
        return ElizaRuntimeSTT()
    if selected in {"eliza1", "eliza-1", "eliza1-asr"}:
        return Eliza1STT()
    if selected in {"faster-whisper", "local-whisper"}:
        return FasterWhisperSTT()
    raise ValueError(
        f"unsupported STT provider {provider!r}; expected 'groq', "
        "'eliza-runtime', 'eliza1', or 'faster-whisper'"
    )
