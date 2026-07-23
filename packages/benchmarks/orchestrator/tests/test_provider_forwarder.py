"""Exercises the loopback provider forwarder against a real local HTTP
upstream stub (standing in for the external remote cloud endpoint): auth
lanes, JSON and SSE streaming passthrough, upstream-error passthrough, and
fail-closed lifecycle semantics."""

from __future__ import annotations

import json
import socket
import threading
import time
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from benchmarks.orchestrator.provider_forwarder import (
    ForwarderLifecycleError,
    is_loopback_url,
    start_provider_forwarder,
)

UPSTREAM_KEY = "real-upstream-secret-key"
CHAT_COMPLETION = {
    "id": "chatcmpl-upstream-1",
    "object": "chat.completion",
    "model": "gemma-4-31b",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "4"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 12, "completion_tokens": 1, "total_tokens": 13},
}
EMBEDDING_RESPONSE = {
    "object": "list",
    "data": [{"object": "embedding", "index": 0, "embedding": [0.25, -0.5]}],
    "model": "text-embed",
}
MODELS_RESPONSE = {"object": "list", "data": [{"id": "gemma-4-31b"}]}


class _UpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: "_UpstreamServer"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return

    def _record(self, payload: dict[str, object] | None = None) -> None:
        self.server.seen.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "accept_encoding": self.headers.get("Accept-Encoding"),
                "user_agent": self.headers.get("User-Agent"),
                "payload": payload,
            }
        )

    def _json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/v1/models":
            self._record()
            self._json(200, MODELS_RESPONSE)
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        self._record(payload)
        if self.path == "/api/v1/chat/completions":
            if self.server.fail_status is not None:
                self._json(
                    self.server.fail_status,
                    {"error": {"message": "quota exhausted", "type": "rate_limit"}},
                )
                return
            if payload.get("stream") is True:
                self.close_connection = True
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(
                    b'data: {"choices":[{"delta":{"content":"first-chunk"}}]}\n\n'
                )
                self.wfile.flush()
                # Held open until the test confirms the first chunk arrived at
                # the client, proving incremental piping rather than buffering.
                self.server.release_stream.wait(timeout=10)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            self._json(200, CHAT_COMPLETION)
            return
        if self.path == "/api/v1/embeddings":
            self._json(200, EMBEDDING_RESPONSE)
            return
        self.send_error(404)


class _UpstreamServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _UpstreamHandler)
        self.seen: list[dict[str, object]] = []
        self.fail_status: int | None = None
        self.release_stream = threading.Event()


@pytest.fixture()
def upstream() -> _UpstreamServer:
    server = _UpstreamServer()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def _start(upstream: _UpstreamServer, tmp_path: Path, **overrides: object):
    kwargs: dict[str, object] = {
        "run_group_id": "rgc_test_group",
        "provider": "cerebras",
        "harnesses": ("eliza", "hermes", "openclaw"),
        "upstream_base_url": f"http://127.0.0.1:{upstream.server_address[1]}/api/v1",
        "upstream_api_key": UPSTREAM_KEY,
        "evidence_dir": tmp_path / "provider-forwarder",
    }
    kwargs.update(overrides)
    return start_provider_forwarder(**kwargs)


def _request(
    base_url: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    payload: dict[str, object] | None = None,
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    parsed_port = int(base_url.rsplit(":", 1)[1].split("/", 1)[0])
    connection = HTTPConnection("127.0.0.1", parsed_port, timeout=10)
    try:
        headers: dict[str, str] = dict(extra_headers or {})
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        return (
            response.status,
            response.read(),
            {name.lower(): value for name, value in response.headers.items()},
        )
    finally:
        connection.close()


def test_is_loopback_url_matches_adapter_semantics() -> None:
    assert is_loopback_url("http://127.0.0.1:8001/v1")
    assert is_loopback_url("http://localhost:9000/v1")
    assert is_loopback_url("https://[::1]:9000/v1")
    assert not is_loopback_url("https://elizacloud.ai/api/v1")
    assert not is_loopback_url("https://api.cerebras.ai/v1")
    assert not is_loopback_url("http://10.0.0.5:8001/v1")
    assert not is_loopback_url("")
    assert not is_loopback_url(None)
    assert not is_loopback_url("ftp://127.0.0.1/v1")


def test_forwarder_advertises_openclaw_compatible_loopback_url(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        assert forwarder.base_url.startswith("http://127.0.0.1:")
        assert forwarder.base_url.endswith("/v1")
        assert is_loopback_url(forwarder.base_url)
        status, body, _headers = _request(forwarder.base_url, "GET", "/health")
        assert status == 200
        assert json.loads(body) == {"status": "ok"}
    finally:
        forwarder.close()


def test_missing_or_unknown_bearer_is_rejected_without_upstream_contact(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        for token in (None, "not-a-lane-token", UPSTREAM_KEY):
            status, body, headers = _request(
                forwarder.base_url,
                "POST",
                "/v1/chat/completions",
                token=token,
                payload={"model": "gemma-4-31b", "messages": []},
            )
            assert status == 401
            assert (
                json.loads(body)["error"]["type"]
                == "provider_forwarder_unauthorized"
            )
            assert headers.get("www-authenticate") == "Bearer"
        assert upstream.seen == []
    finally:
        forwarder.close()


def test_chat_completion_passthrough_swaps_credentials(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        request_payload = {
            "model": "gemma-4-31b",
            "messages": [{"role": "user", "content": "2+2?"}],
        }
        status, body, headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload=request_payload,
            extra_headers={"User-Agent": "OpenAI/JS 6.45.0"},
        )
        assert status == 200
        assert headers["content-type"] == "application/json"
        assert json.loads(body) == CHAT_COMPLETION
        assert len(upstream.seen) == 1
        seen = upstream.seen[0]
        assert seen["path"] == "/api/v1/chat/completions"
        assert seen["payload"] == request_payload
        # The upstream sees the coordinator-held key, never the lane token;
        # identity encoding keeps the relay a transparent byte pipe.
        assert seen["authorization"] == f"Bearer {UPSTREAM_KEY}"
        assert seen["accept_encoding"] == "identity"
        # The forwarder is the client on the upstream hop: harness SDK product
        # tokens (``OpenAI/...``) never reach upstream, where edge bot rules
        # 403 them (Cloudflare AI-crawler blocking at elizacloud.ai).
        assert seen["user_agent"] == "eliza-benchmark-provider-forwarder/1"
    finally:
        forwarder.close()


def test_streaming_chat_completion_is_piped_incrementally(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
        port = int(forwarder.base_url.rsplit(":", 1)[1].split("/", 1)[0])
        connection = HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            body = json.dumps(
                {"model": "gemma-4-31b", "messages": [], "stream": True}
            ).encode("utf-8")
            connection.request(
                "POST",
                "/v1/chat/completions",
                body=body,
                headers={
                    "Authorization": f"Bearer {lane_token}",
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            assert response.status == 200
            assert response.headers["Content-Type"] == "text/event-stream"
            # The upstream holds the stream open until release_stream is set,
            # so receiving the first chunk here proves both hops relayed it
            # before the upstream finished the response.
            first = b""
            deadline = time.monotonic() + 10
            while b"first-chunk" not in first and time.monotonic() < deadline:
                first += response.read1(65536)
            assert b"first-chunk" in first
            assert b"[DONE]" not in first
            upstream.release_stream.set()
            rest = first
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                rest += chunk
            assert b"data: [DONE]" in rest
        finally:
            connection.close()
    finally:
        forwarder.close()


def test_models_and_embeddings_passthrough(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
        status, body, _headers = _request(
            forwarder.base_url, "GET", "/v1/models", token=lane_token
        )
        assert status == 200
        assert json.loads(body) == MODELS_RESPONSE
        status, body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/embeddings",
            token=lane_token,
            payload={"model": "text-embed", "input": "hello"},
        )
        assert status == 200
        assert json.loads(body) == EMBEDDING_RESPONSE
    finally:
        forwarder.close()


def test_unknown_routes_are_404(upstream: _UpstreamServer, tmp_path: Path) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
        for method, path in (
            ("GET", "/v1/other"),
            ("POST", "/health"),
            ("POST", "/v1/completions"),
            ("GET", "/"),
        ):
            status, _body, _headers = _request(
                forwarder.base_url, method, path, token=lane_token, payload={}
            )
            assert status == 404, (method, path)
        assert upstream.seen == []
    finally:
        forwarder.close()


def test_upstream_error_passes_through_verbatim(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    upstream.fail_status = 429
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("openclaw")["OPENAI_API_KEY"]
        status, body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload={"model": "gemma-4-31b", "messages": []},
        )
        assert status == 429
        assert json.loads(body) == {
            "error": {"message": "quota exhausted", "type": "rate_limit"}
        }
    finally:
        forwarder.close()


def test_unreachable_upstream_becomes_502_never_a_completion(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
    forwarder = _start(
        upstream,
        tmp_path,
        upstream_base_url=f"http://127.0.0.1:{dead_port}/api/v1",
    )
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        status, body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload={"model": "gemma-4-31b", "messages": []},
        )
        assert status == 502
        error = json.loads(body)["error"]
        assert error["type"] == "provider_forwarder_upstream_error"
    finally:
        forwarder.close()


def test_env_for_harness_covers_every_resolution_name_with_unique_tokens(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        tokens: set[str] = set()
        for harness in ("eliza", "hermes", "openclaw"):
            env = forwarder.env_for_harness(harness)
            assert env["OPENAI_BASE_URL"] == forwarder.base_url
            assert env["BENCHMARK_BASE_URL"] == forwarder.base_url
            assert env["CEREBRAS_BASE_URL"] == forwarder.base_url
            assert env["OPENAI_API_KEY"] == env["CEREBRAS_API_KEY"]
            assert env["OPENAI_API_KEY"] != UPSTREAM_KEY
            tokens.add(env["OPENAI_API_KEY"])
        assert len(tokens) == 3
        with pytest.raises(ForwarderLifecycleError):
            forwarder.env_for_harness("smithers")
    finally:
        forwarder.close()


def test_startup_rejects_missing_key_and_invalid_upstream(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    with pytest.raises(ForwarderLifecycleError):
        _start(upstream, tmp_path, upstream_api_key="")
    with pytest.raises(ForwarderLifecycleError):
        _start(upstream, tmp_path, upstream_base_url="not-a-url")
    with pytest.raises(ForwarderLifecycleError):
        _start(
            upstream,
            tmp_path,
            upstream_base_url="https://elizacloud.ai/api/v1?key=oops",
        )
    with pytest.raises(ValueError):
        _start(upstream, tmp_path, harnesses=())


def test_close_stops_serving_and_writes_secret_free_evidence(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    hermes_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
    eliza_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
    for _ in range(2):
        _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=hermes_token,
            payload={"model": "gemma-4-31b", "messages": []},
        )
    _request(forwarder.base_url, "GET", "/v1/models", token=eliza_token)
    _request(
        forwarder.base_url,
        "POST",
        "/v1/chat/completions",
        token="bogus",
        payload={},
    )
    evidence_file = forwarder.close()

    with pytest.raises(ConnectionRefusedError):
        _request(forwarder.base_url, "GET", "/health")

    raw = evidence_file.read_text(encoding="utf-8")
    assert UPSTREAM_KEY not in raw
    assert hermes_token not in raw
    assert eliza_token not in raw
    evidence = json.loads(raw)
    assert evidence["upstream_host"] == "127.0.0.1"
    assert evidence["harness_request_counts"] == {"hermes": 2, "eliza": 1}
    assert evidence["unauthorized_requests"] == 1
    assert evidence["harness_lanes"] == ["eliza", "hermes", "openclaw"]
    assert evidence["closed_at"] is not None

    # Idempotent close keeps returning the evidence path.
    assert forwarder.close() == evidence_file


def test_close_raises_when_serving_thread_died_before_close(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    forwarder._server.shutdown()
    deadline = time.monotonic() + 5
    while forwarder._thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not forwarder._thread.is_alive()
    with pytest.raises(ForwarderLifecycleError, match="exited before close"):
        forwarder.close()
