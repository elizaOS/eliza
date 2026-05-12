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
<<<<<<< HEAD
=======


# ---------------------------------------------------------------------------
# HTTP retry loop in OpenClawClient._send_openai_compatible
# ---------------------------------------------------------------------------


def _ok_response_body() -> bytes:
    return json.dumps(
        {
            "choices": [
                {"message": {"content": "PONG", "tool_calls": []}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6},
        }
    ).encode("utf-8")


class _FakeOkResponse:
    """Stand-in for ``urllib.request.urlopen`` return value."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_FakeOkResponse":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        return None


def _make_http_error(status: int, *, retry_after: str | None = None) -> HTTPError:
    body = b'{"error": "rate limited"}'
    headers: dict[str, str] = {}
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    err = HTTPError(
        url="https://api.cerebras.ai/v1/chat/completions",
        code=status,
        msg=f"HTTP {status}",
        hdrs=headers,  # type: ignore[arg-type] - hdrs accepts dict-like
        fp=io.BytesIO(body),
    )
    return err


@pytest.fixture
def client(tmp_path) -> OpenClawClient:
    binary = tmp_path / "openclaw"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    return OpenClawClient(
        binary_path=binary,
        repo_path=binary.parent,
        provider="cerebras",
        base_url="https://api.cerebras.ai/v1",
        api_key="sk-test",
        direct_openai_compatible=True,
    )


def test_openai_compat_retries_429_twice_then_succeeds(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """429 → 429 → 200: send_message returns on the third urlopen call."""
    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)

    call_count = {"n": 0}

    def _fake_urlopen(_request: Any, *, timeout: float = 0.0) -> _FakeOkResponse:
        call_count["n"] += 1
        if call_count["n"] <= 2:
            raise _make_http_error(429)
        return _FakeOkResponse(_ok_response_body())

    sleeps: list[float] = []
    monkeypatch.setattr("openclaw_adapter.client.time.sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(
        "openclaw_adapter.client.urllib.request.urlopen", _fake_urlopen
    )

    # Bypass api_key resolution (api_key is read from env in __init__).
    client.api_key = "sk-test"

    result = client.send_message("hi", context=None)
    assert call_count["n"] == 3
    assert result.text == "PONG"
    assert sleeps == [1.0, 2.0]


def test_openai_compat_honors_retry_after(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When Retry-After: 4 is present, the next sleep is 4s, not 1s."""
    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)

    call_count = {"n": 0}

    def _fake_urlopen(_request: Any, *, timeout: float = 0.0) -> _FakeOkResponse:
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise _make_http_error(429, retry_after="4")
        return _FakeOkResponse(_ok_response_body())

    sleeps: list[float] = []
    monkeypatch.setattr("openclaw_adapter.client.time.sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(
        "openclaw_adapter.client.urllib.request.urlopen", _fake_urlopen
    )

    client.api_key = "sk-test"
    client.send_message("hi", context=None)

    assert call_count["n"] == 2
    assert sleeps == [4.0]


def test_openai_compat_exhausts_after_max_attempts(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """5 consecutive 429s should raise RetryExhaustedError."""
    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)

    def _fake_urlopen(_request: Any, *, timeout: float = 0.0) -> _FakeOkResponse:
        raise _make_http_error(429)

    monkeypatch.setattr("openclaw_adapter.client.time.sleep", lambda s: None)
    monkeypatch.setattr(
        "openclaw_adapter.client.urllib.request.urlopen", _fake_urlopen
    )

    client.api_key = "sk-test"
    with pytest.raises(RetryExhaustedError) as excinfo:
        client.send_message("hi", context=None)
    assert excinfo.value.attempts == MAX_ATTEMPTS
    assert excinfo.value.last_status == 429


def test_openai_compat_does_not_retry_400(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-retryable 4xx surfaces immediately as RuntimeError."""
    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)

    calls = {"n": 0}

    def _fake_urlopen(_request: Any, *, timeout: float = 0.0) -> _FakeOkResponse:
        calls["n"] += 1
        raise _make_http_error(400)

    monkeypatch.setattr("openclaw_adapter.client.time.sleep", lambda s: None)
    monkeypatch.setattr(
        "openclaw_adapter.client.urllib.request.urlopen", _fake_urlopen
    )

    client.api_key = "sk-test"
    with pytest.raises(RuntimeError, match="status=400"):
        client.send_message("hi", context=None)
    assert calls["n"] == 1


def test_openai_compat_retries_500_then_succeeds(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 500 should retry once, then succeed."""
    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)
    calls = {"n": 0}

    def _fake_urlopen(_request: Any, *, timeout: float = 0.0) -> _FakeOkResponse:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _make_http_error(503)
        return _FakeOkResponse(_ok_response_body())

    monkeypatch.setattr("openclaw_adapter.client.time.sleep", lambda s: None)
    monkeypatch.setattr(
        "openclaw_adapter.client.urllib.request.urlopen", _fake_urlopen
    )

    client.api_key = "sk-test"
    result = client.send_message("hi", context=None)
    assert calls["n"] == 2
    assert result.text == "PONG"


def test_openai_compat_retries_url_error(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Network-level URLError should be retried."""
    from urllib.error import URLError

    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)
    calls = {"n": 0}

    def _fake_urlopen(_request: Any, *, timeout: float = 0.0) -> _FakeOkResponse:
        calls["n"] += 1
        if calls["n"] == 1:
            raise URLError("connection refused")
        return _FakeOkResponse(_ok_response_body())

    monkeypatch.setattr("openclaw_adapter.client.time.sleep", lambda s: None)
    monkeypatch.setattr(
        "openclaw_adapter.client.urllib.request.urlopen", _fake_urlopen
    )

    client.api_key = "sk-test"
    result = client.send_message("hi", context=None)
    assert calls["n"] == 2
    assert result.text == "PONG"
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
