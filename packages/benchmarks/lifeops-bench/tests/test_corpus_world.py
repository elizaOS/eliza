"""Tests for corpus-backed LifeWorld loading from the bundled synthetic sample."""

from __future__ import annotations

from pathlib import Path

import pytest

from eliza_lifeops_bench.lifeworld.corpus import (
    CorpusLoadOptions,
    CorpusSelector,
    generate_corpus_world,
    load_corpus_rows,
)

NOW_ISO = "2026-05-10T12:00:00Z"
SAMPLE_HASH = "4f3973da15e68f32f825ec86c11fbce54ae5468f73460b2a1edfa51bd9d5782f"
SAMPLE_SUBSET_HASH = "31f55d0113abf5544d9675ce36cafe9af3d058c42593d8c41cebdd0c7f670f6c"


def test_sample_corpus_world_is_hash_pinned() -> None:
    world = generate_corpus_world(seed=42, now_iso=NOW_ISO)

    assert world.state_hash() == SAMPLE_HASH
    assert len(world.emails) == 20
    assert len(world.email_threads) == 17
    assert len(world.contacts) == 19
    assert world.emails["syn-gmail-001"].subject == "Atlas launch checklist"
    assert world.email_threads["syn-thread-001"].message_ids == [
        "syn-gmail-001",
        "syn-gmail-002",
    ]


def test_sample_corpus_subset_selection_is_seeded() -> None:
    options = CorpusLoadOptions(selector=CorpusSelector(max_messages=5))
    first = generate_corpus_world(seed=7, now_iso=NOW_ISO, options=options)
    second = generate_corpus_world(seed=7, now_iso=NOW_ISO, options=options)
    different = generate_corpus_world(seed=8, now_iso=NOW_ISO, options=options)

    assert first.state_hash() == SAMPLE_SUBSET_HASH
    assert second.state_hash() == first.state_hash()
    assert different.state_hash() != first.state_hash()
    assert len(first.emails) == 5


def test_local_mode_requires_directory() -> None:
    with pytest.raises(ValueError, match="local corpus mode requires local_dir"):
        load_corpus_rows(CorpusLoadOptions(mode="local"))


def test_huggingface_mode_requires_token() -> None:
    with pytest.raises(ValueError, match="requires HF_TOKEN"):
        load_corpus_rows(CorpusLoadOptions(mode="huggingface", token=None))


def test_local_mode_reads_sample_directory() -> None:
    sample_dir = Path(__file__).resolve().parents[3] / "corpus-tools/fixtures/synthetic"
    rows = load_corpus_rows(CorpusLoadOptions(mode="local", local_dir=sample_dir))

    assert len(rows) == 20
    assert rows[0]["id"] == "syn-gmail-001"
