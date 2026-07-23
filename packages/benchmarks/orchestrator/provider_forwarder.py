"""Loopback forwarder that keeps remote OpenAI-compatible cohorts publishable.

The hermes and openclaw native runtimes fail closed unless their model
endpoint is a loopback URL, so a cohort pointed at a remote OpenAI-compatible
upstream (an operator-exported ``CEREBRAS_BASE_URL`` / ``OPENAI_BASE_URL``
proxy such as the Eliza Cloud gateway) could previously only run as a
nonpublishable diagnostic. This forwarder restores publishability honestly:
it binds ``http://127.0.0.1:<port>/v1`` (satisfying openclaw's strict
``http://127.0.0.1:`` prefix check and hermes's loopback predicate),
authenticates each harness lane with its own ephemeral bearer token, and
pipes ``/v1/chat/completions``, ``/v1/embeddings``, and ``/v1/models``
byte-for-byte to the real upstream with the real credential attached only
inside the coordinator process. Harness legs therefore hold no real
credential, and their traffic genuinely traverses loopback.

The cohort coordinator owns the lifecycle — one forwarder per cohort, fresh
tokens each cohort, closed in the coordinator ``finally`` where a premature
death durably fails the group. Upstream errors pass through as HTTP errors:
the forwarder never fabricates a completion, never retries into a different
endpoint, and never falls back to handing a harness the upstream URL. Neither
the upstream key nor a lane token is ever logged or persisted; the on-disk
evidence carries only the upstream host and per-lane request counts, and is
deliberately not attached to run metrics so it can never enter the
subscription-gateway audit validators.
"""

from __future__ import annotations

import ipaddress
import json
import secrets
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.client import HTTPConnection, HTTPResponse, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .runner import PROVIDER_BASE_URL_ENV, PROVIDER_KEY_ENV

DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 600.0
DEFAULT_STOP_TIMEOUT_SECONDS = 30.0
_RELAY_CHUNK_BYTES = 65536
# Hop-by-hop and transport-framing headers are recomputed per hop; the
# credential headers are replaced with the coordinator-held upstream key.
# Accept-Encoding is pinned to identity so the relay stays a transparent byte
# pipe with no Content-Encoding to decode (SSE streams are never compressed).
_REQUEST_HEADER_STRIP = frozenset(
    {
        "accept-encoding",
        "authorization",
        "connection",
        "content-length",
        "expect",
        "host",
        "keep-alive",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
_RESPONSE_HEADER_STRIP = frozenset(
    {
        "connection",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)


class ForwarderLifecycleError(RuntimeError):
    """Reports a forwarder startup/serving/teardown contract failure."""


def is_loopback_url(value: object) -> bool:
    """Whether an http(s) URL resolves syntactically to a loopback host.

    Mirrors the hermes adapter's ``is_loopback_base_url`` so the coordinator's
    forwarder decision matches the strictest adapter-side publishability check
    it must satisfy (openclaw additionally requires plain-HTTP ``127.0.0.1`` /
    ``localhost``, which the forwarder's advertised URL always is).
    """

    if not isinstance(value, str) or not value.strip():
        return False
    # error-policy:J3 the URL is untrusted operator configuration; any parse
    # failure is an explicit not-loopback verdict, after which the forwarder's
    # own upstream validation raises with a clear message.
    try:
        parsed = urlsplit(value.strip())
        hostname = parsed.hostname
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or not hostname:
        return False
    hostname = hostname.rstrip(".").lower()
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True)
class _UpstreamTarget:
    scheme: str
    host: str
    port: int
    path_prefix: str


def _parse_upstream(base_url: str) -> _UpstreamTarget:
    parsed = urlsplit(base_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ForwarderLifecycleError(
            "Provider forwarder upstream base URL must be an http(s) URL"
        )
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ForwarderLifecycleError(
            "Provider forwarder upstream base URL must not carry "
            "query/fragment/credentials"
        )
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return _UpstreamTarget(
        scheme=parsed.scheme,
        host=parsed.hostname,
        port=port,
        path_prefix=parsed.path.rstrip("/"),
    )


@dataclass
class _ForwarderState:
    """Mutable serving-time counters shared between handler threads."""

    upstream: _UpstreamTarget
    upstream_api_key: str
    tokens_to_harness: dict[str, str]
    upstream_timeout_seconds: float
    lock: threading.Lock = field(default_factory=threading.Lock)
    lane_request_counts: dict[str, int] = field(default_factory=dict)
    unauthorized_requests: int = 0
    upstream_transport_failures: int = 0
    aborted_connections: int = 0


class _ForwarderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], state: _ForwarderState) -> None:
        super().__init__(address, _ForwarderHandler)
        self.state = state

    def handle_error(self, request: object, client_address: object) -> None:
        # error-policy:J1 per-connection boundary: a harness disconnecting
        # mid-stream (or a relay write failing) must not kill the shared
        # serving loop. The harness side observes its own aborted request and
        # fails its run; the abort is additionally counted in the evidence.
        with self.state.lock:
            self.state.aborted_connections += 1


class _ForwarderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _ForwarderServer

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        # Default stderr access logs could echo bearer-carrying request lines;
        # the forwarder's only durable output is its non-secret evidence file.
        return

    def do_GET(self) -> None:  # noqa: N802
        path, _, query = self.path.partition("?")
        normalized = path.rstrip("/") or "/"
        if normalized == "/health":
            self._write_json(200, {"status": "ok"})
            return
        if normalized == "/v1/models":
            harness = self._authorized_harness()
            if harness is None:
                return
            self._forward("GET", "/models", query, None)
            return
        self._write_json(
            404,
            {
                "error": {
                    "message": f"provider forwarder has no route for {normalized}",
                    "type": "provider_forwarder_not_found",
                }
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        path, _, query = self.path.partition("?")
        normalized = path.rstrip("/")
        subpath = {
            "/v1/chat/completions": "/chat/completions",
            "/v1/embeddings": "/embeddings",
        }.get(normalized)
        if subpath is None:
            self._write_json(
                404,
                {
                    "error": {
                        "message": f"provider forwarder has no route for {normalized}",
                        "type": "provider_forwarder_not_found",
                    }
                },
            )
            return
        harness = self._authorized_harness()
        if harness is None:
            return
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._write_json(
                411,
                {
                    "error": {
                        "message": "provider forwarder requires Content-Length",
                        "type": "provider_forwarder_length_required",
                    }
                },
            )
            return
        body = self.rfile.read(int(raw_length))
        self._forward("POST", subpath, query, body)

    def _authorized_harness(self) -> str | None:
        state = self.server.state
        header = self.headers.get("Authorization", "")
        token = header[len("Bearer ") :].strip() if header.startswith("Bearer ") else ""
        harness = state.tokens_to_harness.get(token) if token else None
        if harness is None:
            with state.lock:
                state.unauthorized_requests += 1
            self._write_json(
                401,
                {
                    "error": {
                        "message": "provider forwarder bearer token is missing or unknown",
                        "type": "provider_forwarder_unauthorized",
                    }
                },
                extra_headers={"WWW-Authenticate": "Bearer"},
            )
            return None
        with state.lock:
            state.lane_request_counts[harness] = (
                state.lane_request_counts.get(harness, 0) + 1
            )
        return harness

    def _forward(
        self,
        method: str,
        subpath: str,
        query: str,
        body: bytes | None,
    ) -> None:
        state = self.server.state
        target = state.upstream
        upstream_path = f"{target.path_prefix}{subpath}"
        if query:
            upstream_path = f"{upstream_path}?{query}"
        connection_cls = (
            HTTPSConnection if target.scheme == "https" else HTTPConnection
        )
        connection = connection_cls(
            target.host, target.port, timeout=state.upstream_timeout_seconds
        )
        try:
            headers = self._outbound_headers()
            headers["Authorization"] = f"Bearer {state.upstream_api_key}"
            connection.request(method, upstream_path, body=body, headers=headers)
            upstream_response = connection.getresponse()
        except (OSError, TimeoutError) as error:
            # error-policy:J1 the forwarder is the harness-to-upstream
            # transport boundary; a transport failure surfaces as an explicit
            # HTTP error the harness observes and fails its run on — never a
            # fabricated completion, never a fallback to a different endpoint.
            connection.close()
            with state.lock:
                state.upstream_transport_failures += 1
            self._write_json(
                502,
                {
                    "error": {
                        "message": (
                            "provider forwarder upstream request failed: "
                            f"{type(error).__name__}: {error}"
                        ),
                        "type": "provider_forwarder_upstream_error",
                    }
                },
            )
            return
        try:
            self._relay_response(upstream_response)
        finally:
            connection.close()

    def _outbound_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        for name, value in self.headers.items():
            if name.lower() in _REQUEST_HEADER_STRIP:
                continue
            headers[name] = value
        headers["Accept-Encoding"] = "identity"
        return headers

    def _relay_response(self, upstream_response: HTTPResponse) -> None:
        self.send_response(upstream_response.status)
        response_headers = upstream_response.headers
        for name, value in response_headers.items():
            if name.lower() in _RESPONSE_HEADER_STRIP:
                continue
            self.send_header(name, value)
        content_length = response_headers.get("Content-Length")
        if content_length is not None and not upstream_response.chunked:
            self.send_header("Content-Length", content_length)
        else:
            # Without a known length the relay streams until upstream EOF and
            # the closed connection delimits the body for the HTTP/1.1 client.
            # SSE (``"stream": true``) always takes this branch; each upstream
            # read is flushed immediately so tokens reach the harness as they
            # are produced instead of after the completion finishes.
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        # read1 performs at most one underlying socket read, so partial SSE
        # events are relayed the moment they arrive rather than after a full
        # amt-sized buffer fills.
        while True:
            chunk = upstream_response.read1(_RELAY_CHUNK_BYTES)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    def _write_json(
        self,
        status: int,
        payload: dict[str, object],
        *,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)


@dataclass
class ProviderForwarderProcess:
    """A running loopback forwarder plus its non-secret evidence location."""

    provider: str
    run_group_id: str
    origin: str
    base_url: str
    upstream_host: str
    evidence_file: Path
    _server: _ForwarderServer
    _thread: threading.Thread
    _state: _ForwarderState
    _harness_tokens: dict[str, str]
    _serve_failures: list[BaseException]
    _started_at: str
    _stop_timeout_seconds: float = DEFAULT_STOP_TIMEOUT_SECONDS
    _closed: bool = False

    def env_for_harness(self, harness: str) -> dict[str, str]:
        """Per-leg env pinning every base-URL/key name a harness resolves.

        Overriding both the generic OpenAI-compat names and the
        provider-native names makes the public-default fallbacks in every
        adapter unreachable, and the lane token — worthless upstream — is the
        only credential a harness process ever holds.
        """

        normalized = harness.strip().lower()
        token = self._harness_tokens.get(normalized)
        if not token:
            raise ForwarderLifecycleError(
                f"Provider forwarder has no {normalized} harness lane"
            )
        env = {
            "OPENAI_BASE_URL": self.base_url,
            "BENCHMARK_BASE_URL": self.base_url,
            "OPENAI_API_KEY": token,
        }
        provider_base_url_env = PROVIDER_BASE_URL_ENV.get(self.provider)
        if provider_base_url_env:
            env[provider_base_url_env] = self.base_url
        provider_key_env = PROVIDER_KEY_ENV.get(self.provider)
        if provider_key_env:
            env[provider_key_env] = token
        return env

    def close(self) -> Path:
        """Stop serving and finalize evidence; raise on a broken lifecycle.

        A serving thread that died before close means the harnesses lost their
        only route to the model mid-cohort — the raise lands in the
        coordinator's failure map so even a cohort whose workers all finished
        is durably failed rather than quietly published.
        """

        if self._closed:
            return self.evidence_file
        self._closed = True
        died_before_close = not self._thread.is_alive()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=self._stop_timeout_seconds)
        self._write_evidence(closed=True)
        if self._serve_failures:
            raise ForwarderLifecycleError(
                "Provider forwarder serving loop crashed before close"
            ) from self._serve_failures[0]
        if died_before_close:
            raise ForwarderLifecycleError(
                "Provider forwarder serving thread exited before close"
            )
        if self._thread.is_alive():
            raise ForwarderLifecycleError(
                "Provider forwarder did not stop within its deadline"
            )
        return self.evidence_file

    def _write_evidence(self, *, closed: bool) -> None:
        state = self._state
        with state.lock:
            payload = {
                "schema_version": 1,
                "kind": "provider-forwarder",
                "run_group_id": self.run_group_id,
                "provider": self.provider,
                "upstream_host": self.upstream_host,
                "listen_origin": self.origin,
                "harness_lanes": sorted(self._harness_tokens),
                "harness_request_counts": dict(state.lane_request_counts),
                "unauthorized_requests": state.unauthorized_requests,
                "upstream_transport_failures": state.upstream_transport_failures,
                "aborted_connections": state.aborted_connections,
                "started_at": self._started_at,
                "closed_at": _utc_now() if closed else None,
            }
        self.evidence_file.parent.mkdir(parents=True, exist_ok=True)
        self.evidence_file.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def __enter__(self) -> ProviderForwarderProcess:
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.close()


def start_provider_forwarder(
    *,
    run_group_id: str,
    provider: str,
    harnesses: tuple[str, ...],
    upstream_base_url: str,
    upstream_api_key: str,
    evidence_dir: Path,
    upstream_timeout_seconds: float = DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
    stop_timeout_seconds: float = DEFAULT_STOP_TIMEOUT_SECONDS,
) -> ProviderForwarderProcess:
    """Start a per-cohort loopback forwarder with per-harness bearer lanes.

    Fails closed before any worker can spend quota: a missing upstream key, a
    bind failure, or a failed self-health probe raises instead of returning a
    half-configured boundary.
    """

    normalized_provider = provider.strip().lower()
    if not normalized_provider:
        raise ValueError("Provider forwarder requires a provider label")
    if not run_group_id.strip():
        raise ValueError("Provider forwarder requires a run group id")
    normalized_harnesses = tuple(
        dict.fromkeys(value.strip().lower() for value in harnesses if value.strip())
    )
    if not normalized_harnesses:
        raise ValueError("At least one harness is required for the provider forwarder")
    if upstream_timeout_seconds <= 0 or stop_timeout_seconds <= 0:
        raise ValueError("Provider forwarder deadlines must be positive")
    if not isinstance(upstream_api_key, str) or not upstream_api_key.strip():
        raise ForwarderLifecycleError(
            "Provider forwarder requires a non-empty upstream API key"
        )
    upstream = _parse_upstream(upstream_base_url)

    harness_tokens = {
        harness: secrets.token_urlsafe(32) for harness in normalized_harnesses
    }
    if len(set(harness_tokens.values())) != len(harness_tokens):
        raise ForwarderLifecycleError(
            "Provider forwarder harness bearer lanes are not unique"
        )
    state = _ForwarderState(
        upstream=upstream,
        upstream_api_key=upstream_api_key.strip(),
        tokens_to_harness={token: harness for harness, token in harness_tokens.items()},
        upstream_timeout_seconds=upstream_timeout_seconds,
    )
    try:
        server = _ForwarderServer(("127.0.0.1", 0), state)
    except OSError as error:
        # error-policy:J2 a bind failure is a startup contract failure the
        # coordinator turns into a failed cohort; retain the OS-level cause.
        raise ForwarderLifecycleError(
            "Provider forwarder could not bind a loopback port"
        ) from error
    port = int(server.server_address[1])
    origin = f"http://127.0.0.1:{port}"
    serve_failures: list[BaseException] = []

    def _serve() -> None:
        try:
            server.serve_forever(poll_interval=0.1)
        except BaseException as error:  # noqa: BLE001
            # error-policy:J1 the serving loop is this thread's outermost
            # boundary; the failure is re-raised from close(), which the
            # coordinator turns into a durable cohort failure.
            serve_failures.append(error)

    thread = threading.Thread(
        target=_serve,
        name=f"provider-forwarder-{normalized_provider}",
        daemon=True,
    )
    thread.start()

    process = ProviderForwarderProcess(
        provider=normalized_provider,
        run_group_id=run_group_id.strip(),
        origin=origin,
        base_url=f"{origin}/v1",
        upstream_host=upstream.host,
        evidence_file=evidence_dir / "forwarder.json",
        _server=server,
        _thread=thread,
        _state=state,
        _harness_tokens=harness_tokens,
        _serve_failures=serve_failures,
        _started_at=_utc_now(),
        _stop_timeout_seconds=stop_timeout_seconds,
    )
    try:
        try:
            probe = HTTPConnection("127.0.0.1", port, timeout=5.0)
            try:
                probe.request("GET", "/health")
                response = probe.getresponse()
                response.read()
            finally:
                probe.close()
        except (OSError, TimeoutError) as error:
            # error-policy:J2 an unreachable just-bound socket is a startup
            # contract failure; retain the transport-level cause.
            raise ForwarderLifecycleError(
                "Provider forwarder failed its startup health probe"
            ) from error
        if response.status != 200:
            raise ForwarderLifecycleError(
                f"Provider forwarder health probe returned status {response.status}"
            )
        process._write_evidence(closed=False)
    except Exception:
        # error-policy:J1 startup is the forwarder's process boundary; stop
        # serving before surfacing the startup failure to the coordinator.
        server.shutdown()
        server.server_close()
        thread.join(timeout=stop_timeout_seconds)
        raise
    return process
