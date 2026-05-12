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
import os
from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from .types import Sample

log = logging.getLogger("elizaos_voicebench.adapters")


@dataclass(frozen=True)
class AdapterRequest:
    """Per-sample input to the agent under test.

    ``prompt_text`` is the cascaded-STT transcript of ``sample.audio_bytes``
    (or ``sample.reference_text`` in mock mode where audio is absent).
    ``sample`` is passed through so suite-specific prompt wrapping
    (e.g. MCQ choices) can be done by the runner before this is built.
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
    function. When ``audio_bytes`` is absent (mock mode) we use the
    sample's reference transcript directly — that's the documented
    smoke-test contract.
    """

    def __init__(self, *, stt: SttFn | None, text: TextFn, name: str) -> None:
        self._stt = stt
        self._text = text
        self.name = name

    async def __call__(self, request: AdapterRequest) -> AdapterResponse:
        transcript = request.prompt_text
        audio = request.sample.audio_bytes
        if audio is not None and self._stt is not None:
            transcript = (await self._stt(audio)).strip() or transcript
        reply = await self._text(transcript)
        return AdapterResponse(text=reply)


# --- mock adapter for smoke tests ---


class EchoAdapter:
    """Deterministic adapter that returns ``sample.answer``.

    Used by the smoke test so we don't need any network in CI. Scores
    100% on MCQ / ifeval-exact suites and gives the judge a known target
    string for open-ended suites.
    """

    name = "echo"

    async def __call__(self, request: AdapterRequest) -> AdapterResponse:
        return AdapterResponse(text=request.sample.answer)


# --- factory ---


def build_adapter(
    *,
    agent: str,
    stt_provider: str | None,
    mock: bool,
) -> VoiceAdapter:
    """Construct an adapter for the named agent.

    Live adapters require the corresponding ``*_adapter`` Python package
    to be importable; we import lazily so smoke tests don't depend on
    any of them.
    """

    if mock or agent == "echo":
        return EchoAdapter()

    stt = _build_stt(stt_provider) if stt_provider else None
    text = _build_text_adapter(agent)
    return CascadedAdapter(stt=stt, text=text, name=agent)


def _build_text_adapter(agent: str) -> TextFn:
    if agent == "eliza":
        if os.environ.get("ELIZA_BENCH_URL") and os.environ.get("ELIZA_BENCH_TOKEN"):
            from eliza_adapter.client import ElizaClient  # noqa: WPS433

            client = ElizaClient()
            client.wait_until_ready(timeout=120)
        else:
            from eliza_adapter.server_manager import ElizaServerManager  # noqa: WPS433

            manager = ElizaServerManager()
            manager.start()
            client = manager.client

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

        client = OpenClawClient(
            direct_openai_compatible=True,
            allow_text_tool_calls=True,
        )

        async def _call(prompt: str) -> str:
            resp = client.send_message(prompt, context={"benchmark": "voicebench-quality"})
            return resp.text

        return _call

    raise ValueError(f"unknown agent: {agent!r}")


def _build_stt(provider: str) -> SttFn:
    if provider != "groq":
        raise ValueError(
            f"unsupported STT provider {provider!r}; only 'groq' is wired today"
        )
    from .clients.groq_stt import GroqWhisperClient

    client = GroqWhisperClient()

    async def _transcribe(audio: bytes) -> str:
        return await client.transcribe(audio)

    return _transcribe
