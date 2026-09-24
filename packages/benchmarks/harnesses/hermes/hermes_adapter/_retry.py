"""Shared retry-with-backoff helpers for hermes-adapter HTTP calls.

Cerebras's public inference endpoint returns 429 under bursty concurrent load.
We retry on:

  - HTTP 429 (rate limit)
  - HTTP 5xx (transient server failure)
  - network / connection errors raised by the underlying HTTP client

Other 4xx errors (auth, schema, bad request) surface immediately — retrying
them only delays the real failure.

The backoff schedule is exponential (1s, 2s, 4s, 8s, 16s) unless the response
carries a ``Retry-After`` header, in which case we honor that value.

Total attempts (including the initial call) are capped at
:data:`MAX_ATTEMPTS`. After exhaustion, :class:`RetryExhaustedError` is raised
with the attempt count and the last status / error so the caller can log it.
"""

from __future__ import annotations

import logging
import time
from email.utils import parsedate_to_datetime
from typing import Final

logger = logging.getLogger(__name__)


MAX_ATTEMPTS: Final[int] = 5
_BACKOFF_SECONDS: Final[tuple[float, ...]] = (1.0, 2.0, 4.0, 8.0, 16.0)
_MAX_RETRY_AFTER_SECONDS: Final[float] = 60.0


class RetryExhaustedError(RuntimeError):
    """Raised after ``MAX_ATTEMPTS`` failed attempts.

    Attributes
    ----------
    attempts:
        Total attempts made (always ``MAX_ATTEMPTS``).
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


__all__ = [
    "MAX_ATTEMPTS",
    "RetryExhaustedError",
    "backoff_seconds",
    "is_retryable_status",
    "parse_retry_after",
]
