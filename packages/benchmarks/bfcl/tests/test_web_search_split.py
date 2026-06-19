"""Unit tests for the BFCL web_search_base / web_search_no_snippet split.

Upstream BFCL packs both categories into the same source file
(``BFCL_v4_web_search.json``) and distinguishes them via a per-entry
``show_snippet`` flag tied to the test id. Our dataset loader replicates
that by partitioning the loaded entries into the two categories at the
end of ``BFCLDataset.load()``.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from benchmarks.bfcl.dataset import BFCLDataset
from benchmarks.bfcl.types import BFCLCategory, BFCLConfig


def _write_ndjson(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def web_search_fixture(tmp_path: Path) -> Path:
    """Two synthetic web_search entries: one plain, one explicitly tagged
    no_snippet via its id (upstream's convention when both buckets share
    a source file)."""
    rows = [
        {
            "id": "web_search_0",
            "question": [[{"role": "user", "content": "Who won the World Cup in 2022?"}]],
            "function": [],
            "involved_classes": ["WebSearchAPI"],
        },
        {
            "id": "web_search_1",
            "question": [[{"role": "user", "content": "What is the capital of France?"}]],
            "function": [],
            "involved_classes": ["WebSearchAPI"],
        },
        {
            "id": "web_search_no_snippet_0",
            "question": [[{"role": "user", "content": "Who is the president of Brazil?"}]],
            "function": [],
            "involved_classes": ["WebSearchAPI"],
        },
    ]
    _write_ndjson(tmp_path / "BFCL_v4_web_search.json", rows)
    return tmp_path


def _load_dataset(data_path: Path, categories: list[BFCLCategory]) -> BFCLDataset:
    config = BFCLConfig(
        data_path=str(data_path),
        use_huggingface=False,
        categories=categories,
        generate_report=False,
        save_raw_responses=False,
    )
    ds = BFCLDataset(config)
    asyncio.run(ds.load())
    return ds


class TestWebSearchSplit:
    def test_base_only_contains_base_entries(self, web_search_fixture: Path) -> None:
        ds = _load_dataset(web_search_fixture, [BFCLCategory.WEB_SEARCH_BASE])
        cats = {tc.category for tc in ds}
        assert cats == {BFCLCategory.WEB_SEARCH_BASE}
        # All entries should be base entries (none explicitly tagged
        # no_snippet sneak into the base bucket).
        for tc in ds:
            assert "no_snippet" not in tc.id

    def test_no_snippet_only_contains_no_snippet_entries(
        self, web_search_fixture: Path
    ) -> None:
        ds = _load_dataset(
            web_search_fixture, [BFCLCategory.WEB_SEARCH_NO_SNIPPET]
        )
        cats = {tc.category for tc in ds}
        assert cats == {BFCLCategory.WEB_SEARCH_NO_SNIPPET}
        # Every entry must end up in the no_snippet bucket — either it
        # already had the marker in its id, or it was synthesized from a
        # base entry as the no_snippet pair.
        assert len(list(ds)) >= 1
        for tc in ds:
            # Either the original explicit no_snippet entry, or a
            # synthesized one with the no_snippet marker in the id.
            assert (
                "no_snippet" in tc.id
                or tc.category == BFCLCategory.WEB_SEARCH_NO_SNIPPET
            )

    def test_both_categories_partition_cleanly(
        self, web_search_fixture: Path
    ) -> None:
        ds = _load_dataset(
            web_search_fixture,
            [BFCLCategory.WEB_SEARCH_BASE, BFCLCategory.WEB_SEARCH_NO_SNIPPET],
        )

        base_ids = [
            tc.id for tc in ds if tc.category == BFCLCategory.WEB_SEARCH_BASE
        ]
        ns_ids = [
            tc.id
            for tc in ds
            if tc.category == BFCLCategory.WEB_SEARCH_NO_SNIPPET
        ]

        # Every id falls into exactly one bucket.
        assert set(base_ids).isdisjoint(set(ns_ids))
        # Both buckets are populated.
        assert len(base_ids) >= 1
        assert len(ns_ids) >= 1
        # No id appears twice within a bucket.
        assert len(base_ids) == len(set(base_ids))
        assert len(ns_ids) == len(set(ns_ids))

    def test_no_base_entry_carries_no_snippet_marker(
        self, web_search_fixture: Path
    ) -> None:
        ds = _load_dataset(
            web_search_fixture,
            [BFCLCategory.WEB_SEARCH_BASE, BFCLCategory.WEB_SEARCH_NO_SNIPPET],
        )
        for tc in ds:
            if tc.category == BFCLCategory.WEB_SEARCH_BASE:
                assert "no_snippet" not in tc.id.lower()
