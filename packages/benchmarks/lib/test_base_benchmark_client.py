"""Unit tests for ``benchmarks.lib.base_benchmark_client``.

Targets the shared scaffolding that hermes / openclaw / eliza adapters now
inherit from: retry math, cost computation, telemetry capture, concurrency
semaphore, and the abstract ``_send`` plumbing.
"""

from __future__ import annotations

import asyncio
from typing import Mapping

import pytest

from benchmarks.lib.base_benchmark_client import (
    CEREBRAS_GPT_OSS_120B_PRICING,
    MAX_ATTEMPTS,
    BaseBenchmarkClient,
    ModelPricing,
    RetryExhaustedError,
    TurnTelemetry,
    backoff_seconds,
    compute_cost_usd,
    is_retryable_status,
    parse_retry_after,
)


# ---------------------------------------------------------------------------
# Retry helpers
# ---------------------------------------------------------------------------


def test_parse_retry_after_handles_seconds_and_dates() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("") is None
    assert parse_retry_after("3") == 3.0
    assert parse_retry_after("0.5") == 0.5
    assert parse_retry_after("0") == 0.0
    assert parse_retry_after("600") == 60.0  # clamped
    assert parse_retry_after("-5") == 0.0  # clamped to zero
    assert parse_retry_after("nonsense") is None
    delay = parse_retry_after("Wed, 21 Oct 2099 07:28:00 GMT", now_epoch=4_096_000_000.0)
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
    err = RetryExhaustedError(attempts=MAX_ATTEMPTS, last_status=429, last_error="too many")
    assert err.attempts == MAX_ATTEMPTS
    assert err.last_status == 429
    assert err.last_error == "too many"
    assert "429" in str(err)
    assert "too many" in str(err)
    network_err = RetryExhaustedError(
        attempts=MAX_ATTEMPTS, last_status=None, last_error="dns failure"
    )
    assert "network-error" in str(network_err)


# ---------------------------------------------------------------------------
# Cost computation
# ---------------------------------------------------------------------------


def test_compute_cost_usd_basic() -> None:
    # 1_000_000 prompt at $0.35/M + 1_000_000 completion at $0.75/M = $1.10
    cost = compute_cost_usd(
        prompt_tokens=1_000_000,
        completion_tokens=1_000_000,
        pricing=CEREBRAS_GPT_OSS_120B_PRICING,
    )
    assert cost == pytest.approx(1.10)


def test_compute_cost_usd_rejects_negative_counts() -> None:
    with pytest.raises(ValueError):
        compute_cost_usd(
            prompt_tokens=-1,
            completion_tokens=10,
            pricing=CEREBRAS_GPT_OSS_120B_PRICING,
        )


def test_compute_cost_usd_cached_overage_raises() -> None:
    with pytest.raises(ValueError):
        compute_cost_usd(
            prompt_tokens=100,
            completion_tokens=10,
            cached_prompt_tokens=200,
            pricing=CEREBRAS_GPT_OSS_120B_PRICING,
        )


def test_compute_cost_usd_with_cache_discount() -> None:
    pricing = ModelPricing(
        input_per_m=10.0,
        output_per_m=20.0,
        cached_input_per_m=1.0,
    )
    cost = compute_cost_usd(
        prompt_tokens=1_000_000,
        completion_tokens=100_000,
        cached_prompt_tokens=500_000,
        pricing=pricing,
    )
    # 500k uncached @ $10/M + 500k cached @ $1/M = $5 + $0.50 = $5.50
    # + 100k output @ $20/M = $2
    assert cost == pytest.approx(5.50 + 2.0)


def test_compute_cost_usd_no_cache_discount_falls_back_to_input_rate() -> None:
    pricing = ModelPricing(input_per_m=10.0, output_per_m=20.0)
    cost = compute_cost_usd(
        prompt_tokens=1_000_000,
        completion_tokens=0,
        cached_prompt_tokens=500_000,
        pricing=pricing,
    )
    assert cost == pytest.approx(10.0)


# ---------------------------------------------------------------------------
# BaseBenchmarkClient
# ---------------------------------------------------------------------------


class _StubClient(BaseBenchmarkClient[dict]):
    """Minimal subclass: _send echoes input and a canned usage shape."""

    def __init__(
        self,
        *,
        concurrency: int = 4,
        pricing: ModelPricing | None = None,
        usage_to_return: Mapping[str, object] | None = None,
        send_side_effect: list[object] | None = None,
    ) -> None:
        super().__init__(
            concurrency=concurrency,
            pricing=pricing,
            model="gpt-oss-120b",
            provider="cerebras",
        )
        self.usage_to_return = dict(usage_to_return) if usage_to_return else None
        self._send_calls = 0
        self._send_side_effect = list(send_side_effect) if send_side_effect else None

    def _send(self, text: str, context: Mapping[str, object] | None) -> dict:
        self._send_calls += 1
        if self._send_side_effect:
            nxt = self._send_side_effect.pop(0)
            if isinstance(nxt, BaseException):
                raise nxt
            return nxt  # type: ignore[return-value]
        return {"text": text, "usage": self.usage_to_return or {}}


def test_init_rejects_zero_concurrency() -> None:
    with pytest.raises(ValueError):
        _StubClient(concurrency=0)


def test_build_auth_headers() -> None:
    assert BaseBenchmarkClient.build_auth_headers(None) == {}
    assert BaseBenchmarkClient.build_auth_headers("") == {}
    assert BaseBenchmarkClient.build_auth_headers("tok") == {"Authorization": "Bearer tok"}


def test_cost_for_usage_camel_and_snake_case() -> None:
    client = _StubClient(pricing=CEREBRAS_GPT_OSS_120B_PRICING)
    cost_camel = client.cost_for_usage(
        {"promptTokens": 1_000_000, "completionTokens": 1_000_000}
    )
    cost_snake = client.cost_for_usage(
        {"prompt_tokens": 1_000_000, "completion_tokens": 1_000_000}
    )
    assert cost_camel == pytest.approx(1.10)
    assert cost_snake == pytest.approx(1.10)


def test_cost_for_usage_reads_nested_cached_tokens() -> None:
    client = _StubClient(pricing=CEREBRAS_GPT_OSS_120B_PRICING)
    cost = client.cost_for_usage(
        {
            "prompt_tokens": 1_000_000,
            "completion_tokens": 0,
            "prompt_tokens_details": {"cached_tokens": 500_000},
        }
    )
    # No cached discount on the default ModelPricing, so full input rate.
    assert cost == pytest.approx(0.35)


def test_cost_for_usage_zero_when_no_pricing() -> None:
    client = _StubClient(pricing=None)
    assert client.cost_for_usage({"prompt_tokens": 1_000_000}) == 0.0


def test_record_telemetry_captures_full_shape() -> None:
    client = _StubClient(pricing=CEREBRAS_GPT_OSS_120B_PRICING)
    t = client.record_telemetry(
        started_at_epoch=1_700_000_000.0,
        finished_at_epoch=1_700_000_001.5,
        usage={"promptTokens": 200, "completionTokens": 100},
    )
    assert isinstance(t, TurnTelemetry)
    assert t.latency_ms == pytest.approx(1500.0)
    assert t.input_tokens == 200
    assert t.output_tokens == 100
    assert t.total_tokens == 300
    assert t.cost_usd == pytest.approx(200 * 0.35 / 1_000_000 + 100 * 0.75 / 1_000_000)
    assert t.model == "gpt-oss-120b"
    assert t.provider == "cerebras"
    assert client.last_telemetry is t
    assert client.total_cost_usd == pytest.approx(t.cost_usd)


def test_record_telemetry_missing_usage_is_zero_cost() -> None:
    client = _StubClient(pricing=CEREBRAS_GPT_OSS_120B_PRICING)
    t = client.record_telemetry(
        started_at_epoch=1.0, finished_at_epoch=1.05, usage=None
    )
    assert t.cost_usd == 0.0
    assert t.input_tokens == 0
    assert t.output_tokens == 0


def test_total_cost_usd_sums_across_turns() -> None:
    client = _StubClient(pricing=CEREBRAS_GPT_OSS_120B_PRICING)
    client.record_telemetry(
        started_at_epoch=0.0,
        finished_at_epoch=0.1,
        usage={"prompt_tokens": 1_000_000, "completion_tokens": 0},
    )
    client.record_telemetry(
        started_at_epoch=1.0,
        finished_at_epoch=1.1,
        usage={"prompt_tokens": 0, "completion_tokens": 1_000_000},
    )
    assert client.total_cost_usd == pytest.approx(0.35 + 0.75)


def test_send_message_tracked_records_telemetry() -> None:
    client = _StubClient(
        pricing=CEREBRAS_GPT_OSS_120B_PRICING,
        usage_to_return={"prompt_tokens": 100, "completion_tokens": 50},
    )
    result = client.send_message_tracked(
        "hi", context=None, usage_extractor=lambda r: r["usage"]
    )
    assert result["text"] == "hi"
    assert client.last_telemetry is not None
    assert client.last_telemetry.input_tokens == 100
    assert client.last_telemetry.output_tokens == 50
    assert client.last_telemetry.cost_usd > 0


def test_acquire_release_slot_caps_concurrent_inflight() -> None:
    client = _StubClient(concurrency=2)
    assert client.acquire_slot(timeout=0.05) is True
    assert client.acquire_slot(timeout=0.05) is True
    # Third acquire must time out — pool exhausted.
    assert client.acquire_slot(timeout=0.05) is False
    client.release_slot()
    assert client.acquire_slot(timeout=0.05) is True
    client.release_slot()
    client.release_slot()


def test_send_message_tracked_releases_slot_on_exception() -> None:
    """If _send raises, the semaphore must still be released."""
    boom = RuntimeError("boom")
    client = _StubClient(concurrency=1, send_side_effect=[boom, {"text": "ok", "usage": {}}])
    with pytest.raises(RuntimeError, match="boom"):
        client.send_message_tracked("first", context=None)
    # The second call would deadlock if the slot wasn't released.
    result = client.send_message_tracked("second", context=None)
    assert result["text"] == "ok"


def test_async_semaphore_built_lazily_and_matches_concurrency() -> None:
    client = _StubClient(concurrency=3)
    assert client._async_semaphore is None  # noqa: SLF001
    sem = client.async_semaphore()
    assert isinstance(sem, asyncio.Semaphore)
    assert sem._value == 3  # noqa: SLF001 — inspecting stdlib internals for the test
    assert client.async_semaphore() is sem


# ---------------------------------------------------------------------------
# run_with_retry
# ---------------------------------------------------------------------------


class _FakeStatusError(Exception):
    def __init__(self, status: int, retry_after: float | None = None) -> None:
        super().__init__(f"status={status}")
        self.status = status
        self.retry_after = retry_after


def _classify(exc: BaseException) -> tuple[int | None, float | None] | None:
    if isinstance(exc, _FakeStatusError):
        if is_retryable_status(exc.status):
            return (exc.status, exc.retry_after)
        return None
    if isinstance(exc, ConnectionError):
        return (None, None)
    return None


def test_run_with_retry_returns_on_first_success() -> None:
    client = _StubClient()
    calls = {"n": 0}

    def call() -> str:
        calls["n"] += 1
        return "ok"

    result = client.run_with_retry(call, classify_error=_classify, sleep_fn=lambda _: None)
    assert result == "ok"
    assert calls["n"] == 1


def test_run_with_retry_retries_on_429_then_succeeds() -> None:
    client = _StubClient()
    sequence: list[object] = [_FakeStatusError(429), _FakeStatusError(429), "ok"]
    sleeps: list[float] = []

    def call() -> str:
        nxt = sequence.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return str(nxt)

    result = client.run_with_retry(
        call,
        classify_error=_classify,
        sleep_fn=lambda s: sleeps.append(s),
    )
    assert result == "ok"
    assert sleeps == [1.0, 2.0]


def test_run_with_retry_honors_explicit_retry_after() -> None:
    client = _StubClient()
    sequence: list[object] = [_FakeStatusError(429, retry_after=5.0), "ok"]
    sleeps: list[float] = []

    def call() -> str:
        nxt = sequence.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return str(nxt)

    client.run_with_retry(
        call,
        classify_error=_classify,
        sleep_fn=lambda s: sleeps.append(s),
    )
    assert sleeps == [5.0]


def test_run_with_retry_fails_fast_on_400() -> None:
    client = _StubClient()
    calls = {"n": 0}

    def call() -> None:
        calls["n"] += 1
        raise _FakeStatusError(400)

    with pytest.raises(_FakeStatusError):
        client.run_with_retry(call, classify_error=_classify, sleep_fn=lambda _: None)
    assert calls["n"] == 1


def test_run_with_retry_exhausts_after_max_attempts() -> None:
    client = _StubClient()
    calls = {"n": 0}

    def call() -> None:
        calls["n"] += 1
        raise _FakeStatusError(429)

    with pytest.raises(RetryExhaustedError) as excinfo:
        client.run_with_retry(call, classify_error=_classify, sleep_fn=lambda _: None)
    assert excinfo.value.attempts == MAX_ATTEMPTS
    assert excinfo.value.last_status == 429
    assert calls["n"] == MAX_ATTEMPTS


def test_run_with_retry_retries_network_errors() -> None:
    client = _StubClient()
    sequence: list[object] = [ConnectionError("dns failure"), "ok"]

    def call() -> str:
        nxt = sequence.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return str(nxt)

    result = client.run_with_retry(call, classify_error=_classify, sleep_fn=lambda _: None)
    assert result == "ok"
