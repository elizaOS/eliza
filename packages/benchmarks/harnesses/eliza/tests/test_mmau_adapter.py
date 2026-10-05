from __future__ import annotations

import asyncio
from pathlib import Path

import eliza_adapter.mmau as mmau_module
from eliza_adapter.client import MessageResponse
from eliza_adapter.mmau import ElizaMMAUAgent
from elizaos_mmau_audio.types import MMAUCategory, MMAUConfig, MMAUSample


def _sample(**kwargs: object) -> MMAUSample:
    values = {
        "id": "sample-1",
        "question": "What is heard?",
        "choices": ("(A) speech", "(B) music"),
        "answer_letter": "A",
        "answer_text": "(A) speech",
        "category": MMAUCategory.SPEECH,
        "skill": "Speaker Identification",
        "information_category": "Information Extraction",
        "difficulty": "easy",
        "dataset": "fixture",
    }
    values.update(kwargs)
    return MMAUSample(**values)


def test_mmau_transcribe_accepts_current_sample_without_transcript_attr() -> None:
    agent = ElizaMMAUAgent(MMAUConfig(model="test-model"))

    transcript = asyncio.run(agent._transcribe(_sample(context="A person speaks.")))

    assert transcript == ""


def test_mmau_transcribe_uses_metadata_transcript_when_present() -> None:
    agent = ElizaMMAUAgent(MMAUConfig(model="test-model"))

    transcript = asyncio.run(
        agent._transcribe(_sample(metadata={"transcript": "A person speaks."}))
    )

    assert transcript == "A person speaks."


def test_mmau_edge_variants_reuse_the_base_sample_transcript() -> None:
    agent = ElizaMMAUAgent(MMAUConfig(model="test-model"))
    base = _sample(id="base", metadata={"transcript": "Shared transcript."})
    edge = _sample(
        id="base--edge-01",
        metadata={
            "base_sample_id": "base",
            "transcript": "This should not trigger a second transcription.",
        },
    )

    assert asyncio.run(agent._transcribe(base)) == "Shared transcript."
    assert asyncio.run(agent._transcribe(edge)) == "Shared transcript."


def test_mmau_send_prompt_includes_transcript_and_audio_metadata() -> None:
    class Client:
        def __init__(self) -> None:
            self.context: dict[str, object] = {}

        def send_message(
            self, text: str, context: dict[str, object]
        ) -> MessageResponse:
            self.context = context
            assert "Audio transcript:\nA person speaks." in text
            return MessageResponse(text="A", thought=None, actions=[], params={})

    agent = ElizaMMAUAgent(MMAUConfig(model="test-model"))
    client = Client()
    agent._client = client

    answer = agent._send_prompt(
        _sample(
            context="Based on the given audio, identify the source.",
            metadata={
                "audio_url": "https://example.test/audio.wav",
                "audio_mime_type": "audio/wav",
            },
        ),
        "Audio transcript:\nA person speaks.",
        "A person speaks.",
    )

    assert answer == "A"
    assert (
        client.context["audio_context"]
        == "Based on the given audio, identify the source."
    )
    assert client.context["transcript"] == "A person speaks."
    assert client.context["audio"] == {
        "has_audio_bytes": False,
        "audio_path": "",
        "audio_url": "https://example.test/audio.wav",
        "audio_mime_type": "audio/wav",
    }


def test_mmau_transcribe_uses_local_stt_when_groq_key_is_unavailable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    agent = ElizaMMAUAgent(MMAUConfig(model="test-model"))
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFFfake-wave")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    captured: list[bytes] = []

    def fake_transcribe(audio: bytes) -> str:
        captured.append(audio)
        return "Local transcript."

    monkeypatch.setattr(
        mmau_module,
        "_transcribe_with_faster_whisper",
        fake_transcribe,
    )

    transcript = asyncio.run(agent._transcribe(_sample(audio_path=audio_path)))

    assert transcript == "Local transcript."
    assert captured == [b"RIFFfake-wave"]
