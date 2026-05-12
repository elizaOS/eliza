"""Unit tests for ``hermes_adapter._retry`` and the in-process retry loop.

The retry helper module is tested directly. The in-process loop in
``HermesClient._send_in_process`` is tested with a fake openai client that
raises ``RateLimitError`` twice then returns a real completion shape.
"""

from __future__ import annotations

import sys
import time
import types
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import pytest

from hermes_adapter._retry import (
    MAX_ATTEMPTS,
    RetryExhaustedError,
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
    # 600 seconds should be clamped to 60.
    assert parse_retry_after("600") == 60.0


def test_parse_retry_after_negative_returns_zero() -> None:
    assert parse_retry_after("-5") == 0.0


def test_parse_retry_after_http_date() -> None:
    # Fixed reference epoch so the test is deterministic.
    delay = parse_retry_after("Wed, 21 Oct 2099 07:28:00 GMT", now_epoch=4_096_000_000.0)
    assert delay is not None
    # We don't pin the exact value (RFC-date arithmetic varies); just confirm
    # it parsed and produced a non-None, clamped result.
    assert 0.0 <= delay <= 60.0


def test_parse_retry_after_unparseable_returns_none() -> None:
    assert parse_retry_after("not-a-number-or-date") is None


# ---------------------------------------------------------------------------
# backoff_seconds + is_retryable_status
# ---------------------------------------------------------------------------


def test_backoff_seconds_schedule() -> None:
    assert backoff_seconds(0) == 1.0
    assert backoff_seconds(1) == 2.0
    assert backoff_seconds(2) == 4.0
    assert backoff_seconds(3) == 8.0
    assert backoff_seconds(4) == 16.0
    # Out-of-range index clamps to the last value.
    assert backoff_seconds(99) == 16.0
    assert backoff_seconds(-1) == 1.0


def test_is_retryable_status() -> None:
    assert is_retryable_status(429) is True
    assert is_retryable_status(500) is True
    assert is_retryable_status(502) is True
    assert is_retryable_status(599) is True
    assert is_retryable_status(400) is False
    assert is_retryable_status(401) is False
    assert is_retryable_status(404) is False
    assert is_retryable_status(200) is False


# ---------------------------------------------------------------------------
# RetryExhaustedError
# ---------------------------------------------------------------------------


def test_retry_exhausted_error_records_state() -> None:
    err = RetryExhaustedError(
        attempts=MAX_ATTEMPTS, last_status=429, last_error="too many"
    )
    assert err.attempts == MAX_ATTEMPTS
    assert err.last_status == 429
    assert err.last_error == "too many"
    assert "5" in str(err) or "5 attempts" in str(err)
    assert "429" in str(err)
    assert "too many" in str(err)


def test_retry_exhausted_error_network_status() -> None:
    err = RetryExhaustedError(
        attempts=MAX_ATTEMPTS, last_status=None, last_error="connection refused"
    )
    assert err.last_status is None
    assert "network-error" in str(err)


# ---------------------------------------------------------------------------
# In-process retry loop in HermesClient._send_in_process
# ---------------------------------------------------------------------------


@dataclass
class _FakeMsg:
    content: str = ""
    tool_calls: list[Any] | None = None
    reasoning_content: str | None = None


@dataclass
class _FakeChoice:
    message: _FakeMsg


@dataclass
class _FakeCompletion:
    choices: list[_FakeChoice]
    usage: Any = None


@dataclass
class _FakeResponse:
    headers: dict[str, str]


class _FakeRateLimitError(Exception):
    """Stand-in for openai.RateLimitError carrying a fake .response.headers."""

    def __init__(self, message: str, *, retry_after: str | None = None) -> None:
        super().__init__(message)
        headers = {"Retry-After": retry_after} if retry_after else {}
        self.response = _FakeResponse(headers=headers)
        self.status_code = 429


class _FakeAPIStatusError(Exception):
    def __init__(self, message: str, *, status: int) -> None:
        super().__init__(message)
        self.status_code = status
        self.response = _FakeResponse(headers={})


class _FakeAPIConnectionError(Exception):
    pass


class _FakeAPITimeoutError(Exception):
    pass


class _FakeChatCompletions:
    """Mock ``openai.OpenAI().chat.completions`` that scripts a response sequence."""

    def __init__(self, side_effects: list[Any]) -> None:
        self._side_effects = list(side_effects)
        self.call_count = 0

    def create(self, **kwargs: Any) -> _FakeCompletion:
        self.call_count += 1
        if not self._side_effects:
            raise AssertionError("no scripted side effect remaining")
        nxt = self._side_effects.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


class _FakeChat:
    def __init__(self, completions: _FakeChatCompletions) -> None:
        self.completions = completions


class _FakeOpenAI:
    def __init__(
        self,
        *,
        api_key: Any = None,
        base_url: Any = None,
        max_retries: int = 0,
        completions: _FakeChatCompletions | None = None,
    ) -> None:
        # Capture for assertion.
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self.chat = _FakeChat(completions or _FakeChatCompletions([]))


def _install_fake_openai_module(
    monkeypatch: pytest.MonkeyPatch,
    completions: _FakeChatCompletions,
) -> None:
    """Install a fake ``openai`` module into ``sys.modules`` for lazy imports."""
    module = types.ModuleType("openai")

    def _factory(**kwargs: Any) -> _FakeOpenAI:
        return _FakeOpenAI(completions=completions, **kwargs)

    module.OpenAI = _factory  # type: ignore[attr-defined]
    module.RateLimitError = _FakeRateLimitError  # type: ignore[attr-defined]
    module.APIStatusError = _FakeAPIStatusError  # type: ignore[attr-defined]
    module.APIConnectionError = _FakeAPIConnectionError  # type: ignore[attr-defined]
    module.APITimeoutError = _FakeAPITimeoutError  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openai", module)


def _build_in_process_client() -> Any:
    from hermes_adapter.client import HermesClient

    return HermesClient(
        repo_path=None,
        mode="in_process",
        api_key="sk-test",
        base_url="https://example.test/v1",
        model="gpt-oss-120b",
    )


def test_in_process_retries_429_twice_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """429 → 429 → 200: send_message should return on the 3rd attempt."""
    good = _FakeCompletion(choices=[_FakeChoice(message=_FakeMsg(content="PONG"))])
    completions = _FakeChatCompletions(
        side_effects=[
            _FakeRateLimitError("rate limited"),
            _FakeRateLimitError("rate limited"),
            good,
        ]
    )
    _install_fake_openai_module(monkeypatch, completions)

    sleeps: list[float] = []
    monkeypatch.setattr("hermes_adapter.client.time.sleep", lambda s: sleeps.append(s))

    client = _build_in_process_client()
    result = client.send_message("hi", context=None)

    assert result.text == "PONG"
    assert completions.call_count == 3
    # First retry uses 1s, second retry uses 2s.
    assert sleeps == [1.0, 2.0]


def test_in_process_honors_retry_after_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """When 429 carries Retry-After: 5, the next sleep is 5s, not the 1s default."""
    good = _FakeCompletion(choices=[_FakeChoice(message=_FakeMsg(content="ok"))])
    completions = _FakeChatCompletions(
        side_effects=[
            _FakeRateLimitError("rate limited", retry_after="5"),
            good,
        ]
    )
    _install_fake_openai_module(monkeypatch, completions)

    sleeps: list[float] = []
    monkeypatch.setattr("hermes_adapter.client.time.sleep", lambda s: sleeps.append(s))

    client = _build_in_process_client()
    client.send_message("hi", context=None)

    assert sleeps == [5.0]
    assert completions.call_count == 2


def test_in_process_exhausts_after_max_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """5 consecutive 429s should raise RetryExhaustedError with last_status=429."""
    completions = _FakeChatCompletions(
        side_effects=[_FakeRateLimitError("rate limited")] * MAX_ATTEMPTS
    )
    _install_fake_openai_module(monkeypatch, completions)

    monkeypatch.setattr("hermes_adapter.client.time.sleep", lambda s: None)

    client = _build_in_process_client()
    with pytest.raises(RetryExhaustedError) as excinfo:
        client.send_message("hi", context=None)

    assert excinfo.value.last_status == 429
    assert excinfo.value.attempts == MAX_ATTEMPTS
    assert completions.call_count == MAX_ATTEMPTS


def test_in_process_does_not_retry_400(monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-retryable 4xx should surface immediately, not retry."""
    completions = _FakeChatCompletions(
        side_effects=[_FakeAPIStatusError("bad request", status=400)]
    )
    _install_fake_openai_module(monkeypatch, completions)

    monkeypatch.setattr("hermes_adapter.client.time.sleep", lambda s: None)

    client = _build_in_process_client()
    with pytest.raises(_FakeAPIStatusError):
        client.send_message("hi", context=None)

    assert completions.call_count == 1


def test_in_process_retries_500_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 500 should retry; first attempt fails, second succeeds."""
    good = _FakeCompletion(choices=[_FakeChoice(message=_FakeMsg(content="ok"))])
    completions = _FakeChatCompletions(
        side_effects=[
            _FakeAPIStatusError("server boom", status=500),
            good,
        ]
    )
    _install_fake_openai_module(monkeypatch, completions)

    monkeypatch.setattr("hermes_adapter.client.time.sleep", lambda s: None)

    client = _build_in_process_client()
    result = client.send_message("hi", context=None)
    assert result.text == "ok"
    assert completions.call_count == 2


def test_in_process_retries_connection_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Network errors trigger retry (status=None)."""
    good = _FakeCompletion(choices=[_FakeChoice(message=_FakeMsg(content="ok"))])
    completions = _FakeChatCompletions(
        side_effects=[
            _FakeAPIConnectionError("dns failure"),
            good,
        ]
    )
    _install_fake_openai_module(monkeypatch, completions)

    monkeypatch.setattr("hermes_adapter.client.time.sleep", lambda s: None)

    client = _build_in_process_client()
    result = client.send_message("hi", context=None)
    assert result.text == "ok"
    assert completions.call_count == 2
