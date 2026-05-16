from __future__ import annotations

import asyncio

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
