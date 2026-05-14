"""Tests for the MMAU dataset loader (fixture path)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from benchmarks.mmau.dataset import FIXTURE_PATH, MMAUDataset
from benchmarks.mmau.types import MMAUCategory


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
