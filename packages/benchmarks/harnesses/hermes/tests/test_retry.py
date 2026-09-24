"""Deterministic tests for the shared provider retry-policy primitives.

Native Hermes owns provider retries inside ``AIAgent``. The adapter's former
in-process retry path is deliberately unavailable because it bypassed Hermes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_adapter._retry import (
    MAX_ATTEMPTS,
    RetryExhaustedError,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)
from hermes_adapter.client import HermesClient


def test_parse_retry_after_empty_values() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("") is None
    assert parse_retry_after("   ") is None


def test_parse_retry_after_seconds_and_clamping() -> None:
    assert parse_retry_after("3") == 3.0
    assert parse_retry_after("0.5") == 0.5
    assert parse_retry_after("0") == 0.0
    assert parse_retry_after("-5") == 0.0
    assert parse_retry_after("600") == 60.0


def test_parse_retry_after_http_date() -> None:
    delay = parse_retry_after(
        "Wed, 21 Oct 2099 07:28:00 GMT", now_epoch=4_096_000_000.0
    )
    assert delay is not None
    assert 0.0 <= delay <= 60.0


def test_parse_retry_after_unparseable_returns_none() -> None:
    assert parse_retry_after("not-a-number-or-date") is None


def test_backoff_seconds_schedule() -> None:
    assert [backoff_seconds(index) for index in range(5)] == [1.0, 2.0, 4.0, 8.0, 16.0]
    assert backoff_seconds(99) == 16.0
    assert backoff_seconds(-1) == 1.0


def test_retryable_statuses() -> None:
    assert all(is_retryable_status(status) for status in (429, 500, 502, 599))
    assert not any(is_retryable_status(status) for status in (200, 400, 401, 404))


def test_retry_exhausted_error_records_state() -> None:
    error = RetryExhaustedError(
        attempts=MAX_ATTEMPTS,
        last_status=429,
        last_error="too many",
    )
    assert error.attempts == MAX_ATTEMPTS
    assert error.last_status == 429
    assert error.last_error == "too many"
    assert "429" in str(error)


def test_retry_exhausted_error_network_status() -> None:
    error = RetryExhaustedError(
        attempts=MAX_ATTEMPTS,
        last_status=None,
        last_error="connection refused",
    )
    assert error.last_status is None
    assert "network-error" in str(error)


def test_legacy_in_process_path_fails_closed(tmp_path: Path) -> None:
    client = HermesClient(
        repo_path=tmp_path,
        mode="in_process",
        base_url="http://127.0.0.1:8765/v1",
        api_key="benchmark-token",
    )
    probe = client.health()
    assert probe["status"] == "error"
    assert probe["publishable_native"] is False
    with pytest.raises(RuntimeError, match="nonpublishable legacy path"):
        client.send_message("hello")
