"""Shared retry policy regression tests."""

import pytest

from benchmarks.lib import (
    MAX_ATTEMPTS,
    RetryExhaustedError,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)


def test_parse_retry_after_handles_seconds_and_dates() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("") is None
    assert parse_retry_after("3") == 3.0
    assert parse_retry_after("0.5") == 0.5
    assert parse_retry_after("0") == 0.0
    assert parse_retry_after("600") == 60.0  # clamped
    assert parse_retry_after("-5") == 0.0  # clamped to zero
    assert parse_retry_after("nonsense") is None
    delay = parse_retry_after(
        "Wed, 21 Oct 2099 07:28:00 GMT", now_epoch=4_096_000_000.0
    )
    assert delay is not None
    assert 0.0 <= delay <= 60.0


def test_backoff_seconds_schedule_with_clamps() -> None:
    assert backoff_seconds(0) == 1.0
    assert backoff_seconds(1) == 2.0
    assert backoff_seconds(2) == 4.0
    assert backoff_seconds(3) == 8.0
    assert backoff_seconds(4) == 16.0
    assert backoff_seconds(99) == 16.0
    assert backoff_seconds(-1) == 1.0


def test_is_retryable_status_only_429_and_5xx() -> None:
    assert is_retryable_status(429) is True
    assert is_retryable_status(500) is True
    assert is_retryable_status(599) is True
    assert is_retryable_status(400) is False
    assert is_retryable_status(401) is False
    assert is_retryable_status(404) is False
    assert is_retryable_status(200) is False


def test_retry_exhausted_error_carries_state() -> None:
    err = RetryExhaustedError(
        attempts=MAX_ATTEMPTS, last_status=429, last_error="too many"
    )
    assert err.attempts == MAX_ATTEMPTS
    assert err.last_status == 429
    assert err.last_error == "too many"
    assert "429" in str(err)
    assert "too many" in str(err)
    network_err = RetryExhaustedError(
        attempts=MAX_ATTEMPTS, last_status=None, last_error="dns failure"
    )
    assert "network-error" in str(network_err)


@pytest.mark.parametrize("value", ["NaN", "inf", "-inf"])
def test_nonfinite_retry_after_is_invalid(value):
    assert parse_retry_after(value) is None


def test_non_http_status_is_not_retryable():
    assert not is_retryable_status(600)
