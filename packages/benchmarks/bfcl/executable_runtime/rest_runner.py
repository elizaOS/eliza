"""
REST HTTP runner for BFCL ``rest_api`` category.

Upstream BFCL REST tests target public HTTP endpoints (geocoding, weather
demos, etc.) and score by comparing the response against the expected
output. This is a faithful but lightweight executor — it uses ``httpx``
(synchronous client by default; async variant available) and:

  * Hits the URL with the method/params/body/headers extracted from the
    model's tool call.
  * Returns a structured :class:`RESTResponse` (status code, parsed JSON,
    raw text, elapsed seconds).
  * 10-second per-call timeout.
  * 429 responses raise :class:`RESTRateLimited` so the runner can bucket
    them under ``SKIPPED_RATE_LIMITED`` instead of failing the test.

Gating: the runner refuses to make outbound calls unless constructed with
``enable_network=True``. Without it, every ``execute`` call raises
:class:`RESTExecutionError` and the caller is expected to translate that
into ``SKIPPED_NO_CREDENTIALS``.

Apache-2.0 attribution preserved for compatibility with upstream semantics.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional


# httpx is an optional dep; we only require it when actually executing.
try:  # pragma: no cover — import guard
    import httpx as _httpx_module
    _HAS_HTTPX = True
except ImportError:  # pragma: no cover
    _httpx_module = None  # type: ignore[assignment]
    _HAS_HTTPX = False


DEFAULT_TIMEOUT_SECONDS = 10.0


class RESTExecutionError(RuntimeError):
    """Raised when a REST call cannot be executed (network disabled,
    missing httpx, validation error)."""


class RESTRateLimited(RuntimeError):
    """Raised when the upstream API returns HTTP 429. Caller should map
    this to ``SKIPPED_RATE_LIMITED``."""


@dataclass
class RESTCallSpec:
    """A single REST request derived from a model tool call."""

    method: str = "GET"
    url: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    json_body: Optional[Any] = None
    data: Optional[Any] = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_call(
        cls,
        url: str,
        method: str = "GET",
        params: Optional[dict[str, Any]] = None,
        headers: Optional[dict[str, str]] = None,
        json_body: Optional[Any] = None,
        data: Optional[Any] = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> "RESTCallSpec":
        return cls(
            method=method.upper(),
            url=url,
            params=dict(params or {}),
            headers=dict(headers or {}),
            json_body=json_body,
            data=data,
            timeout_seconds=timeout_seconds,
        )


@dataclass
class RESTResponse:
    """Structured response returned by :class:`RESTRunner.execute`."""

    status_code: int
    json_body: Any
    text: str
    elapsed_seconds: float
    headers: dict[str, str] = field(default_factory=dict)

    def matches(self, expected: Any) -> bool:
        """Loose containment match against an expected JSON body.

        Upstream's REST eval uses an expected-output comparison that's
        either a full structural match or a substring match for text
        responses. We implement the same semantics: dicts/lists must be
        deep-equal (or contain expected as a subset), strings must appear
        somewhere in the response text.
        """
        if expected is None:
            return True
        if isinstance(expected, str):
            return expected in self.text
        if isinstance(expected, dict):
            return _is_subset(expected, self.json_body)
        if isinstance(expected, list):
            return expected == self.json_body
        return expected == self.json_body


def _is_subset(expected: Any, actual: Any) -> bool:
    """Deep-subset comparison: every key in ``expected`` exists in
    ``actual`` and matches. Used to make REST scoring tolerant of extra
    fields that public APIs add over time."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        for k, v in expected.items():
            if k not in actual:
                return False
            if not _is_subset(v, actual[k]):
                return False
        return True
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return False
        if len(expected) != len(actual):
            return False
        return all(_is_subset(e, a) for e, a in zip(expected, actual))
    return expected == actual


class RESTRunner:
    """Synchronous REST call executor with the gating + timeout policy
    described in this module's docstring."""

    def __init__(
        self,
        *,
        enable_network: bool = False,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        client: Optional[Any] = None,
    ) -> None:
        self.enable_network = enable_network
        self.timeout_seconds = timeout_seconds
        # Allow the caller to inject a pre-built httpx.Client (used in
        # tests with a MockTransport). When ``client`` is None we lazily
        # build one on first use.
        self._client = client

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        if not _HAS_HTTPX:
            raise RESTExecutionError(
                "REST execution requires the `httpx` package. "
                "Install with `pip install httpx`."
            )
        self._client = _httpx_module.Client(timeout=self.timeout_seconds)
        return self._client

    def execute(self, spec: RESTCallSpec) -> RESTResponse:
        """Make the request. Raises :class:`RESTExecutionError` if the
        runner was constructed without ``enable_network`` (the caller
        should pre-check ``enable_network`` and bucket as
        ``SKIPPED_NO_CREDENTIALS`` rather than relying on this exception
        in the hot path)."""
        if not self.enable_network:
            raise RESTExecutionError(
                "Network is disabled. Pass enable_network=True to allow "
                "live REST execution."
            )

        client = self._ensure_client()

        started = time.perf_counter()
        try:
            response = client.request(
                spec.method,
                spec.url,
                params=spec.params or None,
                headers=spec.headers or None,
                json=spec.json_body,
                data=spec.data,
                timeout=spec.timeout_seconds,
            )
        except Exception as exc:
            # httpx-specific timeout / connect / decode errors all funnel
            # through here. We surface them as RESTExecutionError so the
            # caller can fail the test (not skip it — a network error on
            # an opt-in run is a real signal).
            raise RESTExecutionError(f"REST request failed: {exc}") from exc

        elapsed_seconds = time.perf_counter() - started

        try:
            response.read()
        except Exception:
            pass

        if response.status_code == 429:
            raise RESTRateLimited(
                f"Rate-limited (HTTP 429) by {spec.url}"
            )

        try:
            json_body = response.json()
        except Exception:
            json_body = None

        return RESTResponse(
            status_code=response.status_code,
            json_body=json_body,
            text=response.text,
            elapsed_seconds=elapsed_seconds,
            headers=dict(response.headers),
        )

    def close(self) -> None:
        if self._client is not None and hasattr(self._client, "close"):
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "RESTCallSpec",
    "RESTExecutionError",
    "RESTRateLimited",
    "RESTResponse",
    "RESTRunner",
]
