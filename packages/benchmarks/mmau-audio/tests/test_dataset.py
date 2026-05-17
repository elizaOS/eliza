"""Tests for the MMAU dataset loader (fixture path)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from elizaos_mmau_audio.dataset import FIXTURE_PATH, MMAUDataset
from elizaos_mmau_audio.types import MMAUCategory


def test_fixture_loads_all_samples() -> None:
    ds = MMAUDataset()
    asyncio.run(ds.load(use_fixture=True))
    samples = ds.get_samples()
    assert len(samples) >= 5
    cats = {s.category for s in samples}
    assert MMAUCategory.SPEECH in cats
    assert MMAUCategory.SOUND in cats
    assert MMAUCategory.MUSIC in cats


def test_fixture_answer_letter_parsed() -> None:
    ds = MMAUDataset()
    asyncio.run(ds.load(use_fixture=True))
    for sample in ds.get_samples():
        assert sample.answer_letter in {"A", "B", "C", "D"}
        assert sample.choices, "sample must have non-empty choices"


def test_fixture_filtered_by_category() -> None:
    ds = MMAUDataset(categories=(MMAUCategory.MUSIC,))
    asyncio.run(ds.load(use_fixture=True))
    samples = ds.get_samples()
    assert samples
    assert all(s.category is MMAUCategory.MUSIC for s in samples)


def test_fixture_respects_max_samples() -> None:
    ds = MMAUDataset()
    asyncio.run(ds.load(use_fixture=True, max_samples=3))
    samples = ds.get_samples()
    assert len(samples) == 3


def test_fixture_parses_metadata_fields() -> None:
    ds = MMAUDataset()
    asyncio.run(ds.load(use_fixture=True))
    sample = next(s for s in ds.get_samples() if s.category is MMAUCategory.SPEECH)
    assert sample.skill
    assert sample.information_category in {
        "Reasoning",
        "Information Extraction",
        "Knowledge",
    }
    assert sample.difficulty in {"easy", "medium", "hard"}


def test_hf_style_context_audio_is_parsed_as_audio_metadata(tmp_path: Path) -> None:
    fixture = tmp_path / "hf_audio.jsonl"
    fixture.write_text(
        json.dumps(
            {
                "id": "audio-context",
                "context": [{"src": "https://example.test/audio.wav", "type": "audio/wav"}],
                "instruction": "What is heard?",
                "choices": ["(A) speech", "(B) music"],
                "answer": "(A) speech",
                "other_attributes": {
                    "id": "audio-context",
                    "task": "speech",
                    "sub-category": "Speaker Identification",
                    "category": "Information Extraction",
                    "difficulty": "easy",
                    "dataset": "AudioSet",
                },
            }
        )
        + "\n"
    )
    ds = MMAUDataset(fixture_path=fixture)
    asyncio.run(ds.load(use_fixture=True))

    sample = ds.get_samples()[0]
    assert sample.context == ""
    assert sample.audio_path is None
    assert sample.audio_bytes is None
    assert sample.metadata["audio_url"] == "https://example.test/audio.wav"
    assert sample.metadata["audio_mime_type"] == "audio/wav"


def test_hf_style_context_audio_bytes_are_preserved() -> None:
    ds = MMAUDataset()

    sample = ds._parse_record(
        {
            "id": "audio-bytes",
            "context": {"bytes": b"RIFFfake-wave", "path": "audio.wav"},
            "instruction": "What is heard?",
            "choices": ["(A) speech", "(B) music"],
            "answer": "(A) speech",
            "other_attributes": {
                "id": "audio-bytes",
                "task": "speech",
                "sub-category": "Speaker Identification",
                "category": "Information Extraction",
                "difficulty": "easy",
                "dataset": "AudioSet",
            },
        }
    )

    assert sample is not None
    assert sample.context == ""
    assert sample.audio_bytes == b"RIFFfake-wave"
    assert sample.audio_path == Path("audio.wav")


def test_record_with_unknown_task_is_skipped(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text(
        json.dumps(
            {
                "id": "x",
                "instruction": "q",
                "choices": ["(A) yes", "(B) no"],
                "answer": "(A) yes",
                "other_attributes": {
                    "id": "x",
                    "task": "video",
                    "sub-category": "skill",
                    "category": "Reasoning",
                    "difficulty": "easy",
                    "dataset": "fake",
                },
            }
        )
        + "\n"
    )
    ds = MMAUDataset(fixture_path=bad)
    asyncio.run(ds.load(use_fixture=True))
    assert ds.get_samples() == []


def test_record_with_invalid_answer_skipped(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text(
        json.dumps(
            {
                "id": "y",
                "instruction": "q",
                "choices": ["(A) yes", "(B) no"],
                "answer": "maybe",
                "other_attributes": {
                    "id": "y",
                    "task": "speech",
                    "sub-category": "skill",
                    "category": "Reasoning",
                    "difficulty": "easy",
                    "dataset": "fake",
                },
            }
        )
        + "\n"
    )
    ds = MMAUDataset(fixture_path=bad)
    asyncio.run(ds.load(use_fixture=True))
    assert ds.get_samples() == []


def test_fixture_path_constant_exists() -> None:
    assert FIXTURE_PATH.exists()


def test_missing_fixture_raises(tmp_path: Path) -> None:
    ds = MMAUDataset(fixture_path=tmp_path / "missing.jsonl")
    with pytest.raises(FileNotFoundError):
        asyncio.run(ds.load(use_fixture=True))
