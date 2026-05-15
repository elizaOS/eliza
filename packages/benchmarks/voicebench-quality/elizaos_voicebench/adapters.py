"""Voice-aware adapter contract for VoiceBench-quality.

VoiceBench is fundamentally a speech-in, text-out task. The Eliza,
Hermes, and OpenClaw text adapters currently in this repo don't speak
audio. For the cascaded baseline we transcribe audio with an STT
provider (Groq Whisper, matching the latency benchmark's default), then
hand the resulting text to the text-only adapter.

A native voice-in model can plug in here directly by implementing
``VoiceAdapter`` without going through STT.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from .types import Sample

log = logging.getLogger("elizaos_voicebench.adapters")


@dataclass(frozen=True)
class AdapterRequest:
    """Per-sample input to the agent under test.

    ``prompt_text`` is the benchmark prompt wrapper around the transcribed
    sample. ``sample`` is passed through so the adapter can use real audio
    bytes for STT before calling the text backend.
    """

    prompt_text: str
    sample: Sample


@dataclass(frozen=True)
class AdapterResponse:
    """Per-sample output from the agent under test."""

    text: str


class VoiceAdapter(Protocol):
    """Single-call interface. Implementations are stateless w.r.t. samples."""

    async def __call__(self, request: AdapterRequest) -> AdapterResponse: ...


# --- text-only adapters wrapped with a cascaded STT front end ---

TextFn = Callable[[str], Awaitable[str]]
SttFn = Callable[[bytes], Awaitable[str]]


class CascadedAdapter:
    """Compose an STT provider with a text-only chat adapter.

    The text adapter is expected to be a simple ``async (str) -> str``
    function. Audio bytes and STT are required; using the reference transcript
    as a substitute would turn the benchmark into a text-only fixture run.
    """

    def __init__(self, *, stt: SttFn | None, text: TextFn, name: str) -> None:
        self._stt = stt
        self._text = text
        self.name = name

    async def __call__(self, request: AdapterRequest) -> AdapterResponse:
        transcript = request.prompt_text
        audio = request.sample.audio_bytes
        if audio is None:
            raise RuntimeError(
                f"sample {request.sample.sample_id} has no audio bytes; "
                "refusing to use reference text as STT output"
            )
        if self._stt is None:
            raise RuntimeError("VoiceBench requires a real STT provider")
        transcript = (await self._stt(audio)).strip() or transcript
        reply = await self._text(transcript)
        return AdapterResponse(text=reply)


# --- factory ---


def build_adapter(
    *,
    agent: str,
    stt_provider: str | None,
) -> VoiceAdapter:
    """Construct an adapter for the named agent.

    Live adapters require the corresponding ``*_adapter`` Python package
    to be importable.
    """

    if not stt_provider:
        raise ValueError("VoiceBench requires --stt-provider for real audio runs")
    stt = _build_stt(stt_provider)
    text = _build_text_adapter(agent)
    return CascadedAdapter(stt=stt, text=text, name=agent)


def _build_text_adapter(agent: str) -> TextFn:
    if agent == "eliza":
        from eliza_adapter.client import ElizaClient  # noqa: WPS433

        client = ElizaClient(
            base_url=(
                __import__("os").environ.get("ELIZA_API_BASE")
                or __import__("os").environ.get("ELIZA_BENCH_URL")
                or "http://localhost:31337"
            )
        )
        client.wait_until_ready(timeout=120)

        async def _call(prompt: str) -> str:
            resp = client.send_message(prompt, context={"benchmark": "voicebench-quality"})
            return resp.text

        return _call

    if agent == "hermes":
        from hermes_adapter.client import HermesClient  # noqa: WPS433

        client = HermesClient()

        async def _call(prompt: str) -> str:
            resp = client.send_message(prompt, context={"benchmark": "voicebench-quality"})
            return resp.text

        return _call

    if agent == "openclaw":
        from openclaw_adapter.client import OpenClawClient  # noqa: WPS433

        client = OpenClawClient()

        async def _call(prompt: str) -> str:
            resp = client.send_message(prompt, context={"benchmark": "voicebench-quality"})
            return resp.text

        return _call

    raise ValueError(f"unknown agent: {agent!r}")


def _build_stt(provider: str) -> SttFn:
    if provider == "groq":
        from .clients.groq_stt import GroqWhisperClient  # noqa: WPS433

        client = GroqWhisperClient()

        async def _transcribe_groq(audio: bytes) -> str:
            return await client.transcribe(audio)

        return _transcribe_groq

    if provider == "eliza-runtime":
        # POST audio bytes to the local Eliza runtime's STT endpoint.
        # The runtime must expose a compatible /v1/audio/transcriptions route
        # (wired by plugin-groq, plugin-local-inference, or any other STT plugin).
        import os

        import httpx

        base_url = (
            os.environ.get("ELIZA_API_BASE")
            or os.environ.get("ELIZA_BENCH_URL")
            or "http://localhost:31337"
        ).rstrip("/")
        stt_url = f"{base_url}/v1/audio/transcriptions"

        async def _transcribe_eliza(audio: bytes) -> str:
            async with httpx.AsyncClient(timeout=60.0) as http:
                resp = await http.post(
                    stt_url,
                    files={"file": ("sample.wav", audio, "audio/wav")},
                    data={"model": "whisper-large-v3-turbo", "response_format": "json"},
                )
            resp.raise_for_status()
            payload = resp.json()
            text = payload.get("text") if isinstance(payload, dict) else None
            if not isinstance(text, str):
                raise RuntimeError(f"Eliza STT returned no text: {payload!r}")
            return text

        return _transcribe_eliza

    raise ValueError(
        f"unsupported STT provider {provider!r}; "
        "supported: 'groq' (Groq Whisper API) or 'eliza-runtime' (local Eliza /v1/audio/transcriptions)"
    )
