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


def test_autofetch_opt_out_blocks_network(tmp_path, monkeypatch) -> None:
    """Setting MIND2WEB_NO_AUTOFETCH=1 must skip network access entirely."""
    from benchmarks.mind2web.dataset import ensure_test_splits_available

    monkeypatch.setenv("MIND2WEB_NO_AUTOFETCH", "1")
    monkeypatch.setenv("MIND2WEB_CACHE_DIR", str(tmp_path))
    # If the function tried to hit the network it would either succeed (slow)
    # or raise. With the opt-out it must return None synchronously.
    assert ensure_test_splits_available() is None
    # And no zip or extraction artifacts should appear.
    assert not (tmp_path / "test.zip").exists()
    assert not (tmp_path / "extracted").exists()


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
