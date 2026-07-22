"""Tests for ``Mind2WebDataset`` test-split auto-fetch.

The heavy network-bound tests are gated behind the ``MIND2WEB_RUN_NETWORK``
environment variable so the default ``pytest`` invocation stays offline-safe.
They verify that each of the three test splits loads with the expected number
of tasks documented in Deng et al. 2023 (Table 1):

    test_task    -> 252
    test_website -> 177
    test_domain  -> 912
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "packages" / "python"))
sys.path.insert(0, str(REPO_ROOT / "benchmarks"))

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lightweight offline tests
# ---------------------------------------------------------------------------


def test_expected_counts_dict_has_three_splits() -> None:
    from benchmarks.mind2web.dataset import EXPECTED_TEST_COUNTS

    assert EXPECTED_TEST_COUNTS == {
        "test_task": 252,
        "test_website": 177,
        "test_domain": 912,
    }


def test_default_cache_dir_respects_override(tmp_path, monkeypatch) -> None:
    from benchmarks.mind2web.dataset import _default_cache_dir

    monkeypatch.setenv("MIND2WEB_CACHE_DIR", str(tmp_path / "custom"))
    assert _default_cache_dir() == tmp_path / "custom"


async def test_edge_expansion_shares_read_only_trace_payload() -> None:
    from benchmarks.mind2web.dataset import Mind2WebDataset, expand_tasks

    dataset = Mind2WebDataset()
    await dataset.load(use_huggingface=False, use_sample=True)
    base = dataset.get_tasks(limit=1)[0]

    expanded = expand_tasks([base])

    assert len(expanded) == 11
    assert all(variant.actions is base.actions for variant in expanded[1:])
    assert all(variant.action_reprs is base.action_reprs for variant in expanded[1:])
    assert len({variant.annotation_id for variant in expanded}) == 11


def test_disabled_download_fails_closed_when_archive_is_absent(tmp_path, monkeypatch) -> None:
    """Campaign mode must never replace a missing pinned archive."""
    from benchmarks.mind2web.dataset import ensure_test_splits_available

    monkeypatch.setenv("MIND2WEB_DISABLE_DATA_DOWNLOAD", "1")
    monkeypatch.setenv("MIND2WEB_CACHE_DIR", str(tmp_path))
    with pytest.raises(FileNotFoundError, match="Pinned Mind2Web archive is missing"):
        ensure_test_splits_available()
    assert not (tmp_path / "test.zip").exists()
    assert not (tmp_path / "extracted").exists()


def test_disabled_download_requires_pinned_ranker_scores(tmp_path, monkeypatch) -> None:
    from benchmarks.mind2web.dataset import ensure_ranker_scores_available

    monkeypatch.setenv("MIND2WEB_DISABLE_DATA_DOWNLOAD", "1")
    monkeypatch.setenv("MIND2WEB_CACHE_DIR", str(tmp_path))
    with pytest.raises(FileNotFoundError, match="ranker scores are missing"):
        ensure_ranker_scores_available()


def test_ranker_score_checksum_mismatch_fails_closed(tmp_path, monkeypatch) -> None:
    from benchmarks.mind2web.dataset import ensure_ranker_scores_available

    (tmp_path / "scores_all_data.pkl").write_bytes(b"not the pinned artifact")
    monkeypatch.setenv("MIND2WEB_CACHE_DIR", str(tmp_path))
    with pytest.raises(RuntimeError, match="ranker-score checksum mismatch"):
        ensure_ranker_scores_available()


def test_ranker_score_checksum_is_cached_until_file_changes(
    tmp_path, monkeypatch
) -> None:
    from benchmarks.mind2web import dataset

    scores_path = tmp_path / "scores_all_data.pkl"
    scores_path.write_bytes(b"first")
    monkeypatch.setenv("MIND2WEB_CACHE_DIR", str(tmp_path))
    calls = 0

    def matching_hash(_path: Path) -> str:
        nonlocal calls
        calls += 1
        return dataset.MIND2WEB_RANKER_SCORES_SHA256

    monkeypatch.setattr(dataset, "_sha256", matching_hash)

    assert dataset.ensure_ranker_scores_available() == scores_path
    assert dataset.ensure_ranker_scores_available() == scores_path
    assert calls == 1

    scores_path.write_bytes(b"second-and-different-size")
    assert dataset.ensure_ranker_scores_available() == scores_path
    assert calls == 2


# ---------------------------------------------------------------------------
# Network-bound integration tests (gated)
# ---------------------------------------------------------------------------


_NETWORK_REASON = (
    "Network fetch of Mind2Web test.zip (~568 MB) is heavy; "
    "set MIND2WEB_RUN_NETWORK=1 to enable."
)


@pytest.mark.skipif(
    os.environ.get("MIND2WEB_RUN_NETWORK") != "1", reason=_NETWORK_REASON
)
@pytest.mark.parametrize(
    ("split_value", "expected_count"),
    [
        ("test_task", 252),
        ("test_website", 177),
        ("test_domain", 912),
    ],
)
async def test_test_splits_load_with_expected_count(
    split_value: str, expected_count: int
) -> None:
    from benchmarks.mind2web.dataset import Mind2WebDataset
    from benchmarks.mind2web.types import Mind2WebSplit

    ds = Mind2WebDataset(split=Mind2WebSplit(split_value))
    await ds.load(use_huggingface=True, use_sample=False)
    tasks = ds.get_tasks()
    logger.info("Split %s -> %d tasks (expected %d)", split_value, len(tasks), expected_count)
    assert len(tasks) == expected_count, (
        f"Mind2Web split '{split_value}' loaded {len(tasks)} tasks; "
        f"expected {expected_count} per Deng et al. 2023 Table 1."
    )
