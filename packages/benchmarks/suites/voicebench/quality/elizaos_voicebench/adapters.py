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
import tempfile
from dataclasses import dataclass
from pathlib import Path
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
        audio = request.sample.audio_bytes
        if audio is None:
            raise RuntimeError(
                f"sample {request.sample.sample_id} has no audio bytes; "
                "refusing to use reference text as STT output"
            )
        if self._stt is None:
            raise RuntimeError("VoiceBench requires a real STT provider")
        transcript = (await self._stt(audio)).strip()
        if not transcript:
            raise RuntimeError(
                f"sample {request.sample.sample_id} produced an empty STT transcript; "
                "refusing to fall back to reference text"
            )
        reply = await self._text(transcript)
        return AdapterResponse(text=reply)


class FixtureEchoAdapter:
    """No-cost fixture adapter that returns each sample's gold answer."""

    name = "echo"

    async def __call__(self, request: AdapterRequest) -> AdapterResponse:
        if request.sample.suite == "advbench":
            return AdapterResponse(text="I can't help with that request.")
        return AdapterResponse(text=request.sample.answer)


# --- factory ---


def build_adapter(
    *,
    agent: str,
    stt_provider: str | None,
    mock: bool = False,
) -> VoiceAdapter:
    """Construct an adapter for the named agent.

    Live adapters require the corresponding ``*_adapter`` Python package
    to be importable.
    """

    if mock or agent == "echo":
        return FixtureEchoAdapter()
    if not stt_provider:
        raise ValueError("VoiceBench requires --stt-provider for real audio runs")
    stt = _build_stt(stt_provider)
    text = _build_text_adapter(agent)
    return CascadedAdapter(stt=stt, text=text, name=agent)


def _build_text_adapter(agent: str) -> TextFn:
    if agent == "eliza":
        server_mgr = None
        if not os.environ.get("ELIZA_API_BASE") and not os.environ.get("ELIZA_BENCH_URL"):
            from eliza_adapter.server_manager import ElizaServerManager  # noqa: WPS433

            server_mgr = ElizaServerManager()
            server_mgr.start()
            os.environ["ELIZA_BENCH_TOKEN"] = server_mgr.token
            os.environ["ELIZA_BENCH_URL"] = server_mgr.client.base_url

        from eliza_adapter.client import ElizaClient  # noqa: WPS433

        client = ElizaClient(
            base_url=(
                __import__("os").environ.get("ELIZA_API_BASE")
                or __import__("os").environ.get("ELIZA_BENCH_URL")
                or "http://localhost:31337"
            ),
            token=__import__("os").environ.get("ELIZA_BENCH_TOKEN") or None,
        )
        _ = server_mgr
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

    if provider in {"eliza1", "eliza-1", "eliza1-asr"}:
        from .clients.eliza1_asr import Eliza1ASRClient  # noqa: WPS433

        eliza1_client = Eliza1ASRClient()

        async def _transcribe_eliza1(audio: bytes) -> str:
            return await eliza1_client.transcribe(audio)

        return _transcribe_eliza1

    if provider == "eliza-runtime":
        # POST audio bytes to the local Eliza runtime's STT endpoint.
        # The runtime must expose a compatible /v1/audio/transcriptions route
        # (wired by plugin-groq, plugin-local-inference, or any other STT plugin).
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
            if not isinstance(text, str) or not text.strip():
                raise RuntimeError(f"Eliza STT returned no text: {payload!r}")
            return text

        return _transcribe_eliza

    if provider in {"faster-whisper", "local-whisper"}:
        model_name = (
            os.environ.get("VOICEBENCH_FASTER_WHISPER_MODEL")
            or os.environ.get("FASTER_WHISPER_MODEL")
            or "base.en"
        )
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]

        model = WhisperModel(model_name, device="auto", compute_type="auto")

        async def _transcribe_faster_whisper(audio: bytes) -> str:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
                fh.write(audio)
                audio_path = Path(fh.name)
            try:
                segments, _info = model.transcribe(
                    str(audio_path),
                    beam_size=1,
                    vad_filter=False,
                )
                text = " ".join(segment.text.strip() for segment in segments).strip()
            finally:
                audio_path.unlink(missing_ok=True)
            if not text:
                raise RuntimeError("faster-whisper returned no text")
            return text

        return _transcribe_faster_whisper

    raise ValueError(
        f"unsupported STT provider {provider!r}; "
        "supported: 'groq' (Groq Whisper API), 'eliza-runtime' "
        "(local Eliza /v1/audio/transcriptions), 'eliza1' "
        "(local eliza-1 llama.cpp ASR), or 'faster-whisper'"
    )
