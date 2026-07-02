"""Built-in Audio MMAU agents.

* :class:`OracleMMAUAgent` returns the ground-truth letter -- used for
  smoke tests, harness wiring checks, and ``--mock`` runs.
* :class:`CascadedSTTAgent` is the documented cascaded baseline shape:
  run STT (Groq Whisper by default) over the audio, hand the transcript
  to a text agent (the ``AgentFn`` callable), parse the returned letter.
  STT discards music / non-speech semantic information, so on sound and
  music splits this baseline is intentionally weak -- a direct audio-input
  adapter should supersede it. That trade-off is documented in the README.

External adapters live in ``eliza-adapter`` (and the hermes / openclaw
trees). They implement the same ``predict(sample) -> MMAUPrediction``
protocol used here.
"""

from __future__ import annotations

import os
import time
from collections.abc import Awaitable, Callable
from typing import Protocol

from elizaos_mmau_audio.evaluator import (
    choice_letters,
    extract_answer_letter,
    extract_letter_from_option,
)
from elizaos_mmau_audio.types import MMAUPrediction, MMAUSample

AgentFn = Callable[[str, bytes | None], Awaitable[str]]
"""Text agent callable for the cascaded baseline.

Accepts the formatted prompt (question + transcript + lettered choices)
plus the raw audio bytes (for adapters that can consume audio directly).
Returns the model's free-form answer text.
"""


SttFn = Callable[[bytes], Awaitable[str]]
"""Speech-to-text callable. Takes raw audio bytes, returns a transcript."""


class MMAUAgentProtocol(Protocol):
    async def initialize(self) -> None: ...
    async def predict(self, sample: MMAUSample) -> MMAUPrediction: ...
    async def close(self) -> None: ...


class OracleMMAUAgent:
    """Returns the ground-truth letter. Used for offline smoke / mock runs."""

    async def initialize(self) -> None:
        return None

    async def predict(self, sample: MMAUSample) -> MMAUPrediction:
        started = time.time()
        return MMAUPrediction(
            sample_id=sample.id,
            predicted_letter=sample.answer_letter,
            raw_answer=sample.answer_text,
            raw_output={"mode": "oracle"},
            latency_ms=(time.time() - started) * 1000,
        )

    async def close(self) -> None:
        return None


def format_mcq_prompt(sample: MMAUSample, *, transcript: str = "") -> str:
    """Build the canonical cascaded prompt for one MCQ sample."""
    parts: list[str] = []
    if sample.context:
        parts.append(sample.context.strip())
    if transcript:
        parts.append(f"Audio transcript:\n{transcript.strip()}")
    else:
        parts.append("Audio transcript:\n(no transcript available)")
    parts.append(f"Question: {sample.question.strip()}")
    letters = choice_letters(sample.choices)
    formatted_choices = []
    for letter, choice in zip(letters, sample.choices, strict=False):
        existing = extract_letter_from_option(choice)
        if existing == letter:
            formatted_choices.append(choice.strip())
        else:
            stripped = choice.strip()
            formatted_choices.append(f"({letter}) {stripped}")
    parts.append("Choices:\n" + "\n".join(formatted_choices))
    parts.append("Respond with the single letter of the correct option only (for example: 'A').")
    return "\n\n".join(parts)


class CascadedSTTAgent:
    """STT -> text-agent baseline.

    Pipes audio bytes through ``stt_fn`` (Groq Whisper by default in the
    real adapter), formats the prompt with the transcript, dispatches to
    ``agent_fn``, and parses the returned letter. Pure orchestration --
    no network calls live here; both callables are injected.
    """

    def __init__(self, *, agent_fn: AgentFn, stt_fn: SttFn | None = None) -> None:
        self._agent_fn = agent_fn
        self._stt_fn = stt_fn

    async def initialize(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def predict(self, sample: MMAUSample) -> MMAUPrediction:
        started = time.time()
        transcript = ""
        if self._stt_fn is not None and sample.audio_bytes is not None:
            transcript = await self._stt_fn(sample.audio_bytes)
        if not transcript and sample.audio_bytes is None:
            metadata_transcript = sample.metadata.get("transcript")
            if isinstance(metadata_transcript, str):
                transcript = metadata_transcript
        prompt = format_mcq_prompt(sample, transcript=transcript)
        raw_answer = await self._agent_fn(prompt, sample.audio_bytes)
        letters = choice_letters(sample.choices)
        predicted_letter = extract_answer_letter(raw_answer, valid_letters=letters)
        return MMAUPrediction(
            sample_id=sample.id,
            predicted_letter=predicted_letter,
            raw_answer=raw_answer,
            raw_output={"mode": "cascaded_stt", "prompt": prompt},
            transcript=transcript,
            latency_ms=(time.time() - started) * 1000,
        )


class DirectOpenAICompatibleMMAUAgent:
    """Text-only OpenAI-compatible agent for fixture and transcript smoke runs."""

    def __init__(
        self,
        *,
        provider: str,
        model: str | None = None,
        temperature: float = 0.0,
    ) -> None:
        self.provider = provider.strip().lower()
        self.model = model or {
            "openai": "openai/gpt-oss-120b",
            "groq": "openai/gpt-oss-120b",
            "openrouter": "openai/gpt-oss-120b",
            "cerebras": "gemma-4-31b",
        }.get(self.provider, "gemma-4-31b")
        self.temperature = temperature
        key_var = {
            "openai": "OPENAI_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "cerebras": "CEREBRAS_API_KEY",
        }.get(self.provider)
        self.api_key = os.environ.get(key_var or "", "")
        if not self.api_key:
            raise RuntimeError(f"{key_var or 'API key'} is required for MMAU provider={self.provider}")
        self.base_url = (
            os.environ.get(f"{self.provider.upper()}_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or {
                "openai": "https://api.openai.com/v1",
                "groq": "https://api.groq.com/openai/v1",
                "openrouter": "https://openrouter.ai/api/v1",
                "cerebras": "https://api.cerebras.ai/v1",
            }.get(self.provider, "https://api.cerebras.ai/v1")
        ).rstrip("/")

    async def initialize(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def predict(self, sample: MMAUSample) -> MMAUPrediction:
        import aiohttp

        started = time.time()
        transcript = ""
        metadata_transcript = sample.metadata.get("transcript")
        if isinstance(metadata_transcript, str):
            transcript = metadata_transcript
        prompt = format_mcq_prompt(sample, transcript=transcript)
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Accept-Encoding": "identity",
                    "User-Agent": "eliza-mmau-benchmark/1.0",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You answer MMAU multiple-choice audio questions from "
                                "the provided context/transcript. Return only one letter."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": self.temperature,
                    "max_tokens": 64,
                },
            ) as resp:
                data = await resp.json(content_type=None)
                if resp.status >= 400 or "error" in data:
                    detail = data.get("error", data) if isinstance(data, dict) else data
                    raise RuntimeError(f"{self.provider} chat completion failed: {detail}")
                raw_answer = str(
                    data.get("choices", [{}])[0].get("message", {}).get("content", "")
                )
        letters = choice_letters(sample.choices)
        predicted_letter = extract_answer_letter(raw_answer, valid_letters=letters)
        return MMAUPrediction(
            sample_id=sample.id,
            predicted_letter=predicted_letter,
            raw_answer=raw_answer,
            raw_output={"mode": "direct_openai_compatible", "provider": self.provider},
            transcript=transcript,
            latency_ms=(time.time() - started) * 1000,
        )
