"""Shared base client for Hermes / OpenClaw / Eliza benchmark adapters.

Three adapters live alongside this module and historically duplicated:

  - retry/backoff with ``Retry-After`` honoring (429 + 5xx + network),
  - bearer-token auth header construction,
  - cost-from-usage computation (Cerebras and OpenAI-compatible providers),
  - per-turn telemetry capture (cost_usd, latency_ms, prompt/completion tokens),
  - error normalization (retryable vs fail-fast).

Each adapter still owns its transport — :meth:`BaseBenchmarkClient._send` is
abstract — but the surrounding concerns now live here and are tested once.

The retry helpers were previously duplicated in ``hermes_adapter._retry`` and
``openclaw_adapter._retry``. Those modules remain (for standalone wheel
installs) but their canonical home is here and the contracts match exactly.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Callable, Final, Generic, Mapping, TypeVar

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Retry helpers
# ---------------------------------------------------------------------------


MAX_ATTEMPTS: Final[int] = 5
_BACKOFF_SECONDS: Final[tuple[float, ...]] = (1.0, 2.0, 4.0, 8.0, 16.0)
_MAX_RETRY_AFTER_SECONDS: Final[float] = 60.0


class RetryExhaustedError(RuntimeError):
    """Raised after ``MAX_ATTEMPTS`` failed attempts.

    Attributes
    ----------
    attempts:
        Total attempts made (always ``MAX_ATTEMPTS`` when the loop ran to end).
    last_status:
        Last observed HTTP status code, or ``None`` if every attempt failed
        with a network-level exception before producing a response.
    last_error:
        Stringified last error or response body tail for debugging.
    """

    def __init__(
        self,
        *,
        attempts: int,
        last_status: int | None,
        last_error: str,
    ) -> None:
        self.attempts = attempts
        self.last_status = last_status
        self.last_error = last_error
        status_repr = "network-error" if last_status is None else str(last_status)
        super().__init__(
            f"retry exhausted after {attempts} attempts "
            f"(last_status={status_repr}): {last_error}"
        )


def parse_retry_after(value: str | None, *, now_epoch: float | None = None) -> float | None:
    """Parse a ``Retry-After`` header into a delay in seconds.

    Accepts either delta-seconds (RFC 7231 §7.1.3) or an HTTP-date. Returns
    ``None`` when the header is absent or unparseable. Negative or absurd
    values (>``_MAX_RETRY_AFTER_SECONDS``) are clamped.
    """
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        try:
            target = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if target is None:
            return None
        ref_epoch = now_epoch if now_epoch is not None else time.time()
        seconds = target.timestamp() - ref_epoch
    if seconds <= 0:
        return 0.0
    return min(seconds, _MAX_RETRY_AFTER_SECONDS)


def backoff_seconds(attempt_index: int) -> float:
    """Return the default backoff delay for the given 0-based attempt index."""
    if attempt_index < 0:
        return _BACKOFF_SECONDS[0]
    if attempt_index >= len(_BACKOFF_SECONDS):
        return _BACKOFF_SECONDS[-1]
    return _BACKOFF_SECONDS[attempt_index]


def is_retryable_status(status: int) -> bool:
    """Return True for transient HTTP statuses (429 + any 5xx)."""
    return status == 429 or status >= 500


# ---------------------------------------------------------------------------
# Pricing + cost computation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelPricing:
    """Per-million-token USD pricing for a model.

    Per Cerebras and OpenAI public pricing pages, costs are usually quoted in
    USD per million tokens. ``cached_input_per_m`` defaults to None — when
    set, prompt tokens that hit the provider cache are billed at this rate
    instead of ``input_per_m``.
    """

    input_per_m: float
    output_per_m: float
    cached_input_per_m: float | None = None


# Cerebras public pricing for gpt-oss-120b — referenced by hermes-adapter
# pricing math and used by ElizaClient when the route resolves to Cerebras.
CEREBRAS_GPT_OSS_120B_PRICING: Final[ModelPricing] = ModelPricing(
    input_per_m=0.35,
    output_per_m=0.75,
)


def compute_cost_usd(
    *,
    prompt_tokens: int,
    completion_tokens: int,
    pricing: ModelPricing,
    cached_prompt_tokens: int = 0,
) -> float:
    """Compute the USD cost for one LLM call.

    ``cached_prompt_tokens`` is the subset of ``prompt_tokens`` that hit the
    provider cache. When ``pricing.cached_input_per_m`` is set those tokens
    are billed at the cached rate; otherwise the full ``input_per_m`` rate
    applies (per the conservative assumption: callers that don't know the
    cache discount should not silently inflate or deflate spend).
    """
    if prompt_tokens < 0 or completion_tokens < 0 or cached_prompt_tokens < 0:
        raise ValueError(
            "token counts must be non-negative "
            f"(prompt={prompt_tokens}, completion={completion_tokens}, cached={cached_prompt_tokens})"
        )
    if cached_prompt_tokens > prompt_tokens:
        raise ValueError(
            f"cached_prompt_tokens ({cached_prompt_tokens}) cannot exceed "
            f"prompt_tokens ({prompt_tokens})"
        )
    cached_rate = (
        pricing.cached_input_per_m
        if pricing.cached_input_per_m is not None
        else pricing.input_per_m
    )
    uncached_prompt = prompt_tokens - cached_prompt_tokens
    input_cost = (
        uncached_prompt * pricing.input_per_m
        + cached_prompt_tokens * cached_rate
    ) / 1_000_000.0
    output_cost = completion_tokens * pricing.output_per_m / 1_000_000.0
    return input_cost + output_cost


# ---------------------------------------------------------------------------
# Per-turn telemetry
# ---------------------------------------------------------------------------


@dataclass
class TurnTelemetry:
    """Capture of a single ``send_message`` turn.

    Populated by :meth:`BaseBenchmarkClient.record_telemetry`. Consumers may
    pull the latest turn off ``BaseBenchmarkClient.last_telemetry`` or walk
    the full ``telemetry_history`` list when aggregating costs across a run.
    """

    started_at_epoch: float
    finished_at_epoch: float
    latency_ms: float
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    total_tokens: int
    cost_usd: float
    model: str | None = None
    provider: str | None = None


# ---------------------------------------------------------------------------
# Base client
# ---------------------------------------------------------------------------


T = TypeVar("T")


class BaseBenchmarkClient(ABC, Generic[T]):
    """Shared scaffolding for benchmark adapters.

    Subclasses must implement :meth:`_send`. The base class wraps that in
    concurrency limiting, per-turn telemetry capture, and (for HTTP clients)
    retry-with-backoff via :meth:`run_with_retry`.

    The concurrency cap is enforced with both a ``threading.Semaphore`` and
    an ``asyncio.Semaphore``, so subclasses can use whichever model fits
    their transport without the caller needing to know.
    """

    def __init__(
        self,
        *,
        concurrency: int = 4,
        pricing: ModelPricing | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> None:
        if concurrency < 1:
            raise ValueError(f"concurrency must be >= 1, got {concurrency}")
        self.concurrency = concurrency
        self.pricing = pricing
        self.model = model
        self.provider = provider
        self._sync_semaphore = threading.Semaphore(concurrency)
        # Async semaphore is lazy-built so subclasses that never touch asyncio
        # don't drag an event loop into existence.
        self._async_semaphore: asyncio.Semaphore | None = None
        self.telemetry_history: list[TurnTelemetry] = []

    # ------------------------------------------------------------------
    # Auth headers
    # ------------------------------------------------------------------

    @staticmethod
    def build_auth_headers(token: str | None) -> dict[str, str]:
        """Return ``{"Authorization": "Bearer <token>"}`` when ``token`` is set.

        Returns an empty dict when ``token`` is None / empty. Consumers merge
        the result into request headers; no header is set for unauthenticated
        endpoints.
        """
        if not token:
            return {}
        return {"Authorization": f"Bearer {token}"}

    # ------------------------------------------------------------------
    # Cost helpers
    # ------------------------------------------------------------------

    def cost_for_usage(self, usage: Mapping[str, object]) -> float:
        """Compute USD cost from a Cerebras / OpenAI-shaped ``usage`` mapping.

        Accepts both camelCase (``promptTokens`` / ``completionTokens``,
        emitted by the elizaOS bench server) and snake_case (``prompt_tokens``
        / ``completion_tokens``, emitted by the OpenAI SDK directly).

        Returns 0.0 when :attr:`pricing` is unset. Raises ``ValueError`` when
        the usage payload contains unparseable token counts.
        """
        if self.pricing is None:
            return 0.0
        prompt = _coerce_token_count(usage, ("promptTokens", "prompt_tokens"))
        completion = _coerce_token_count(
            usage, ("completionTokens", "completion_tokens")
        )
        cached = _coerce_token_count(
            usage,
            (
                "cacheReadInputTokens",
                "cache_read_input_tokens",
            ),
        )
        if cached == 0:
            details = usage.get("prompt_tokens_details")
            if isinstance(details, Mapping):
                cached = _coerce_token_count(details, ("cached_tokens",))
        return compute_cost_usd(
            prompt_tokens=prompt,
            completion_tokens=completion,
            cached_prompt_tokens=min(cached, prompt),
            pricing=self.pricing,
        )

    # ------------------------------------------------------------------
    # Telemetry capture
    # ------------------------------------------------------------------

    def record_telemetry(
        self,
        *,
        started_at_epoch: float,
        finished_at_epoch: float,
        usage: Mapping[str, object] | None,
    ) -> TurnTelemetry:
        """Capture a turn into :attr:`telemetry_history` and return it.

        ``finished_at_epoch`` minus ``started_at_epoch`` gives latency in
        seconds; the helper converts to milliseconds. Usage may be ``None``
        when the transport does not surface token counts (caller is then on
        the hook for filling cost/tokens elsewhere).
        """
        usage_map: Mapping[str, object] = (
            dict(usage) if isinstance(usage, Mapping) else {}
        )
        prompt = _coerce_token_count(usage_map, ("promptTokens", "prompt_tokens"))
        completion = _coerce_token_count(
            usage_map, ("completionTokens", "completion_tokens")
        )
        cached = _coerce_token_count(
            usage_map, ("cacheReadInputTokens", "cache_read_input_tokens")
        )
        if cached == 0:
            details = usage_map.get("prompt_tokens_details")
            if isinstance(details, Mapping):
                cached = _coerce_token_count(details, ("cached_tokens",))
        total = _coerce_token_count(usage_map, ("totalTokens", "total_tokens"))
        if total == 0:
            total = prompt + completion
        cost = self.cost_for_usage(usage_map) if usage_map else 0.0
        latency_ms = max(0.0, (finished_at_epoch - started_at_epoch) * 1000.0)
        telemetry = TurnTelemetry(
            started_at_epoch=started_at_epoch,
            finished_at_epoch=finished_at_epoch,
            latency_ms=latency_ms,
            input_tokens=prompt,
            output_tokens=completion,
            cached_input_tokens=cached,
            total_tokens=total,
            cost_usd=cost,
            model=self.model,
            provider=self.provider,
        )
        self.telemetry_history.append(telemetry)
        return telemetry

    @property
    def last_telemetry(self) -> TurnTelemetry | None:
        """The most recent ``TurnTelemetry`` recorded, or None."""
        return self.telemetry_history[-1] if self.telemetry_history else None

    @property
    def total_cost_usd(self) -> float:
        """Sum of ``cost_usd`` across every recorded turn."""
        return sum(t.cost_usd for t in self.telemetry_history)

    # ------------------------------------------------------------------
    # Concurrency
    # ------------------------------------------------------------------

    def acquire_slot(self, *, timeout: float | None = None) -> bool:
        """Block (up to ``timeout``) until a concurrency slot is free.

        Returns ``True`` on acquisition, ``False`` on timeout. Pair every
        successful ``acquire_slot`` with :meth:`release_slot`.
        """
        return self._sync_semaphore.acquire(timeout=timeout)

    def release_slot(self) -> None:
        """Release a concurrency slot acquired via :meth:`acquire_slot`."""
        self._sync_semaphore.release()

    def async_semaphore(self) -> asyncio.Semaphore:
        """Async semaphore mirroring :attr:`concurrency`.

        Lazy-built on first access so adapters that only use synchronous code
        don't force an event loop into existence.
        """
        if self._async_semaphore is None:
            self._async_semaphore = asyncio.Semaphore(self.concurrency)
        return self._async_semaphore

    # ------------------------------------------------------------------
    # Retry loop (HTTP/SDK shaped)
    # ------------------------------------------------------------------

    def run_with_retry(
        self,
        call: Callable[[], T],
        *,
        classify_error: Callable[[BaseException], tuple[int | None, float | None] | None],
        on_attempt_failure: Callable[[int, int | None, float, str], None] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> T:
        """Run ``call()`` with retry-on-transient-error semantics.

        ``classify_error`` inspects an exception and returns:

          - ``None`` — non-retryable; the exception propagates.
          - ``(status, retry_after_seconds)`` — retryable. ``status`` is the
            observed HTTP status (or None for network errors); the second
            element is an optional explicit delay from ``Retry-After``.

        Useful for any HTTP-or-SDK shaped call; the OpenClaw CLI path and the
        Hermes subprocess path each provide their own classifier.

        Raises :class:`RetryExhaustedError` after ``MAX_ATTEMPTS`` failures.
        """
        last_status: int | None = None
        last_error_str = "no attempt completed"
        delay = 0.0
        for attempt in range(MAX_ATTEMPTS):
            try:
                return call()
            except BaseException as exc:  # noqa: BLE001 — classifier decides
                classified = classify_error(exc)
                if classified is None:
                    raise
                last_status, explicit_delay = classified
                last_error_str = str(exc)
                delay = (
                    explicit_delay
                    if explicit_delay is not None
                    else backoff_seconds(attempt)
                )
            if attempt == MAX_ATTEMPTS - 1:
                raise RetryExhaustedError(
                    attempts=MAX_ATTEMPTS,
                    last_status=last_status,
                    last_error=last_error_str,
                )
            if on_attempt_failure is not None:
                on_attempt_failure(attempt, last_status, delay, last_error_str)
            else:
                logger.warning(
                    "benchmark-client retrying (attempt %d/%d, status=%s) after %.2fs: %s",
                    attempt + 1,
                    MAX_ATTEMPTS,
                    "net" if last_status is None else last_status,
                    delay,
                    last_error_str[:200],
                )
            sleep_fn(delay)
        # Unreachable in practice — the loop either returns, raises, or hits
        # the explicit RetryExhaustedError above.
        raise RetryExhaustedError(
            attempts=MAX_ATTEMPTS,
            last_status=last_status,
            last_error=last_error_str,
        )

    # ------------------------------------------------------------------
    # Subclass surface
    # ------------------------------------------------------------------

    @abstractmethod
    def _send(self, text: str, context: Mapping[str, object] | None) -> T:
        """Transport-specific send. Subclasses implement this.

        The base class invokes this from :meth:`send_message_tracked` with
        concurrency + telemetry wrapped around it. Subclasses that need their
        own retry/error handling can either:

          - call :meth:`run_with_retry` from inside ``_send``, or
          - implement retry inline (the Hermes / OpenClaw paths do this
            because their transports have their own SDK-shaped exceptions).
        """

    def send_message_tracked(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
        *,
        usage_extractor: Callable[[T], Mapping[str, object] | None] | None = None,
    ) -> T:
        """Run :meth:`_send` under the concurrency cap and record telemetry.

        Subclasses that prefer to keep their existing ``send_message`` shape
        can call this from their override; the base class doesn't force the
        wrapping but it's the recommended path for new code.
        """
        self.acquire_slot()
        started = time.time()
        try:
            result = self._send(text, context)
        finally:
            finished = time.time()
            self.release_slot()
        usage = usage_extractor(result) if usage_extractor is not None else None
        self.record_telemetry(
            started_at_epoch=started,
            finished_at_epoch=finished,
            usage=usage,
        )
        return result


def _coerce_token_count(payload: Mapping[str, object], keys: tuple[str, ...]) -> int:
    """Return the first integer-coerceable value under any of ``keys``, else 0."""
    for key in keys:
        value = payload.get(key)
        if isinstance(value, bool):
            # bool is a subclass of int — guard so True doesn't become 1 token.
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
    return 0


__all__ = [
    "BaseBenchmarkClient",
    "CEREBRAS_GPT_OSS_120B_PRICING",
    "MAX_ATTEMPTS",
    "ModelPricing",
    "RetryExhaustedError",
    "TurnTelemetry",
    "backoff_seconds",
    "compute_cost_usd",
    "is_retryable_status",
    "parse_retry_after",
]
