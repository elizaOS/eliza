"""Adapter safety tests for real VoiceBench-quality runs."""

from __future__ import annotations

import asyncio

import pytest

from elizaos_voicebench.adapters import AdapterRequest, CascadedAdapter
from elizaos_voicebench.types import Sample


def _sample(*, audio: bytes | None = b"RIFF") -> Sample:
    return Sample(
        suite="openbookqa",
        sample_id="sample-1",
        reference_text="What color is the sky?",
        answer="B",
        audio_bytes=audio,
        metadata={},
    )


def test_cascaded_adapter_refuses_missing_audio() -> None:
    async def stt(_audio: bytes) -> str:
        return "transcript"

    async def text(prompt: str) -> str:
        return prompt

    adapter = CascadedAdapter(stt=stt, text=text, name="test")
    request = AdapterRequest(prompt_text="reference prompt", sample=_sample(audio=None))

    with pytest.raises(RuntimeError, match="no audio bytes"):
        asyncio.run(adapter(request))


def test_cascaded_adapter_refuses_empty_stt_transcript() -> None:
    async def stt(_audio: bytes) -> str:
        return "  "

    async def text(prompt: str) -> str:
        return prompt

    adapter = CascadedAdapter(stt=stt, text=text, name="test")
    request = AdapterRequest(prompt_text="reference prompt", sample=_sample())

    with pytest.raises(RuntimeError, match="empty STT transcript"):
        asyncio.run(adapter(request))


def test_cascaded_adapter_uses_stt_transcript_not_reference_text() -> None:
    async def stt(_audio: bytes) -> str:
        return "spoken transcript"

    async def text(prompt: str) -> str:
        return f"agent saw: {prompt}"

    adapter = CascadedAdapter(stt=stt, text=text, name="test")
    request = AdapterRequest(prompt_text="reference prompt", sample=_sample())

    response = asyncio.run(adapter(request))

    assert response.text == "agent saw: spoken transcript"

