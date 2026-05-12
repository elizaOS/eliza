"""Unit tests for ``openclaw_adapter._retry`` helpers.

The previous HTTP retry-loop tests targeted
``OpenClawClient._send_openai_compatible``, which was removed when
``send_message`` consolidated onto the CLI subprocess path. The retry helper
module is still exported and shared with hermes-adapter, so we keep the pure
helper-function tests below. If we re-introduce a Python-level HTTP path,
re-add the loop tests then.
"""

from __future__ import annotations

from openclaw_adapter._retry import (
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)


# ---------------------------------------------------------------------------
# parse_retry_after
# ---------------------------------------------------------------------------


def test_parse_retry_after_none() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("") is None
    assert parse_retry_after("   ") is None


def test_parse_retry_after_seconds() -> None:
    assert parse_retry_after("3") == 3.0
    assert parse_retry_after("0.5") == 0.5
    assert parse_retry_after("0") == 0.0


def test_parse_retry_after_clamps_huge_values() -> None:
    assert parse_retry_after("600") == 60.0


def test_parse_retry_after_unparseable_returns_none() -> None:
    assert parse_retry_after("nonsense") is None


# ---------------------------------------------------------------------------
# backoff_seconds + is_retryable_status
# ---------------------------------------------------------------------------


def test_backoff_seconds_schedule() -> None:
    assert backoff_seconds(0) == 1.0
    assert backoff_seconds(1) == 2.0
    assert backoff_seconds(2) == 4.0
    assert backoff_seconds(3) == 8.0
    assert backoff_seconds(4) == 16.0
    assert backoff_seconds(99) == 16.0
    assert backoff_seconds(-1) == 1.0


def test_is_retryable_status() -> None:
    assert is_retryable_status(429) is True
    assert is_retryable_status(500) is True
    assert is_retryable_status(502) is True
    assert is_retryable_status(400) is False
    assert is_retryable_status(404) is False
