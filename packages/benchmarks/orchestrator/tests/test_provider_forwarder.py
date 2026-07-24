"""Exercises the loopback provider forwarder against a real local HTTP
upstream stub (standing in for the external remote cloud endpoint): auth
lanes, JSON relaying, the de-stream-by-default SSE adaptation (including
immunity to the elizacloud streamed-tool-call duplication bug the stub
reproduces), the raw-passthrough escape hatch, upstream-error passthrough,
and fail-closed lifecycle semantics."""

from __future__ import annotations

import json
import socket
import threading
import time
from http.client import HTTPConnection, HTTPResponse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from benchmarks.orchestrator.provider_forwarder import (
    MAX_UPSTREAM_ATTEMPTS_ENV,
    PASSTHROUGH_STREAMING_ENV,
    RETRY_BUDGET_SECONDS_ENV,
    ForwarderLifecycleError,
    _parse_retry_after,
    is_loopback_url,
    start_provider_forwarder,
)

UPSTREAM_KEY = "real-upstream-secret-key"
CHAT_COMPLETION = {
    "id": "chatcmpl-upstream-1",
    "object": "chat.completion",
    "created": 1750000000,
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
TOOL_ARGUMENTS = json.dumps({"city": "Paris", "unit": "celsius"})
TOOL_CHAT_COMPLETION = {
    "id": "chatcmpl-upstream-tool-1",
    "object": "chat.completion",
    "created": 1750000123,
    "model": "gemma-4-31b",
    "system_fingerprint": "fp_upstream_stub",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_weather_1",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": TOOL_ARGUMENTS,
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }
    ],
    "usage": {"prompt_tokens": 41, "completion_tokens": 9, "total_tokens": 50},
}
# The deployed elizacloud proxy's streamed-tool-call duplication bug, captured
# from raw SSE: incremental argument deltas AND a consolidated chunk that
# re-serializes the full arguments. Spec-mandated per-index concatenation
# yields TOOL_ARGUMENTS twice back-to-back — invalid JSON.
BUGGY_STREAM_TOOL_CHUNKS = [
    {
        "id": "chatcmpl-upstream-tool-1",
        "object": "chat.completion.chunk",
        "created": 1750000123,
        "model": "gemma-4-31b",
        "choices": [
            {"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}
        ],
    },
    {
        "id": "chatcmpl-upstream-tool-1",
        "object": "chat.completion.chunk",
        "created": 1750000123,
        "model": "gemma-4-31b",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_weather_1",
                            "type": "function",
                            "function": {"name": "get_weather", "arguments": ""},
                        }
                    ]
                },
                "finish_reason": None,
            }
        ],
    },
    {
        "id": "chatcmpl-upstream-tool-1",
        "object": "chat.completion.chunk",
        "created": 1750000123,
        "model": "gemma-4-31b",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "function": {"arguments": TOOL_ARGUMENTS[: len(TOOL_ARGUMENTS) // 2]},
                        }
                    ]
                },
                "finish_reason": None,
            }
        ],
    },
    {
        "id": "chatcmpl-upstream-tool-1",
        "object": "chat.completion.chunk",
        "created": 1750000123,
        "model": "gemma-4-31b",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "function": {"arguments": TOOL_ARGUMENTS[len(TOOL_ARGUMENTS) // 2 :]},
                        }
                    ]
                },
                "finish_reason": None,
            }
        ],
    },
    # The bug: a consolidated chunk repeating the already-streamed arguments.
    {
        "id": "chatcmpl-upstream-tool-1",
        "object": "chat.completion.chunk",
        "created": 1750000123,
        "model": "gemma-4-31b",
        "choices": [
            {
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_weather_1",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": TOOL_ARGUMENTS,
                            },
                        }
                    ]
                },
                "finish_reason": None,
            }
        ],
    },
    {
        "id": "chatcmpl-upstream-tool-1",
        "object": "chat.completion.chunk",
        "created": 1750000123,
        "model": "gemma-4-31b",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
    },
]
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
            with self.server.counter_lock:
                self.server.chat_calls += 1
                drop = self.server.transport_fail_remaining > 0
                if drop:
                    self.server.transport_fail_remaining -= 1
                transient = (not drop) and self.server.transient_fail_remaining > 0
                if transient:
                    self.server.transient_fail_remaining -= 1
                    status = self.server.transient_fail_status
                    retry_after = self.server.transient_retry_after
            if drop:
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.connection.close()
                return
            if transient:
                body = json.dumps(
                    {"error": {"message": "overloaded", "type": "server_error"}}
                ).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                if retry_after is not None:
                    self.send_header("Retry-After", retry_after)
                self.end_headers()
                self.wfile.write(body)
                return
            if self.server.fail_status is not None:
                self._json(
                    self.server.fail_status,
                    {"error": {"message": "quota exhausted", "type": "rate_limit"}},
                )
                return
            has_tools = isinstance(payload, dict) and bool(payload.get("tools"))
            if isinstance(payload, dict) and payload.get("stream") is True:
                if has_tools:
                    # Reproduce the deployed cloud proxy's duplication bug so
                    # tests can prove raw passthrough corrupts arguments while
                    # the de-streamed path never sees this response shape.
                    self._sse(
                        [
                            f"data: {json.dumps(chunk)}\n\n".encode("utf-8")
                            for chunk in BUGGY_STREAM_TOOL_CHUNKS
                        ]
                        + [b"data: [DONE]\n\n"]
                    )
                    return
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
            if self.server.invalid_json_completion:
                body = b"upstream-returned-not-json"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._json(200, TOOL_CHAT_COMPLETION if has_tools else CHAT_COMPLETION)
            return
        if self.path == "/api/v1/embeddings":
            self._json(200, EMBEDDING_RESPONSE)
            return
        self.send_error(404)

    def _sse(self, frames: list[bytes]) -> None:
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for frame in frames:
            self.wfile.write(frame)
            self.wfile.flush()


class _UpstreamServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _UpstreamHandler)
        self.seen: list[dict[str, object]] = []
        self.fail_status: int | None = None
        self.invalid_json_completion = False
        self.release_stream = threading.Event()
        # Transient-failure model for the retry tests: the next
        # ``transient_fail_remaining`` chat-completion calls answer with
        # ``transient_fail_status`` (and an optional ``Retry-After``), then the
        # upstream recovers — the realistic shape of an overload/throttle spike.
        self.counter_lock = threading.Lock()
        self.transient_fail_remaining = 0
        self.transient_fail_status = 503
        self.transient_retry_after: str | None = None
        # The next ``transport_fail_remaining`` chat calls drop the connection
        # before answering, so the forwarder sees a transport-layer failure
        # (RemoteDisconnected) rather than an HTTP status — the "connect/read
        # died" transient class, distinct from a 5xx.
        self.transport_fail_remaining = 0
        self.chat_calls = 0


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
    raw_body: bytes | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    parsed_port = int(base_url.rsplit(":", 1)[1].split("/", 1)[0])
    connection = HTTPConnection("127.0.0.1", parsed_port, timeout=10)
    try:
        headers: dict[str, str] = dict(extra_headers or {})
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        body = raw_body
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


def _open_stream(
    base_url: str,
    token: str,
    payload: dict[str, object],
) -> tuple[HTTPConnection, HTTPResponse]:
    port = int(base_url.rsplit(":", 1)[1].split("/", 1)[0])
    connection = HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request(
        "POST",
        "/v1/chat/completions",
        body=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    return connection, connection.getresponse()


def _read_sse_data(response: HTTPResponse) -> list[str]:
    """All ``data:`` payloads of an SSE body, read to EOF."""

    raw = response.read()
    events: list[str] = []
    for block in raw.decode("utf-8").split("\n\n"):
        for line in block.splitlines():
            if line.startswith("data: "):
                events.append(line[len("data: ") :])
    return events


def _accumulate_openai_stream(events: list[str]) -> dict[str, object]:
    """Reassemble a chat completion the way real SSE consumers do.

    Mirrors the hermes chat-completions accumulator (which the OpenAI JS SDK
    inside OpenClaw matches): text deltas concatenate, tool-call names are
    assigned, and tool-call ``arguments`` fragments concatenate per index —
    the exact contract the elizacloud duplication bug corrupts.
    """

    assert events, "stream produced no data events"
    assert events[-1] == "[DONE]", "stream did not terminate with [DONE]"
    content_parts: list[str] = []
    tool_calls: dict[int, dict[str, object]] = {}
    finish_reason = None
    usage = None
    for raw_event in events[:-1]:
        chunk = json.loads(raw_event)
        assert chunk["object"] == "chat.completion.chunk"
        if not chunk.get("choices"):
            if chunk.get("usage"):
                usage = chunk["usage"]
            continue
        choice = chunk["choices"][0]
        delta = choice.get("delta") or {}
        if delta.get("content"):
            content_parts.append(delta["content"])
        for tc_delta in delta.get("tool_calls") or []:
            entry = tool_calls.setdefault(
                tc_delta.get("index", 0),
                {"id": "", "name": "", "arguments": ""},
            )
            if tc_delta.get("id"):
                entry["id"] = tc_delta["id"]
            function = tc_delta.get("function") or {}
            if function.get("name"):
                entry["name"] = function["name"]
            if function.get("arguments"):
                entry["arguments"] = str(entry["arguments"]) + function["arguments"]
        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]
    return {
        "content": "".join(content_parts),
        "tool_calls": [tool_calls[index] for index in sorted(tool_calls)],
        "finish_reason": finish_reason,
        "usage": usage,
    }


STREAMING_TOOL_REQUEST: dict[str, object] = {
    "model": "gemma-4-31b",
    "messages": [{"role": "user", "content": "weather in paris?"}],
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {"type": "string"},
                        "unit": {"type": "string"},
                    },
                    "required": ["city"],
                },
            },
        }
    ],
    "tool_choice": "required",
    "stream": True,
    "stream_options": {"include_usage": True},
}


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


def test_passthrough_mode_pipes_streaming_incrementally(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    """Raw relay behavior, kept reachable through the escape hatch."""

    forwarder = _start(upstream, tmp_path, passthrough_streaming=True)
    try:
        lane_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            forwarder.base_url,
            lane_token,
            {"model": "gemma-4-31b", "messages": [], "stream": True},
        )
        try:
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
        # The passthrough escape hatch sends stream:true upstream untouched.
        assert upstream.seen[0]["payload"]["stream"] is True
    finally:
        forwarder.close()


def test_destream_default_rewrites_upstream_and_synthesizes_compliant_sse(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    """Downstream stream:true → upstream stream:false → spec-compliant SSE."""

    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            forwarder.base_url, lane_token, STREAMING_TOOL_REQUEST
        )
        try:
            assert response.status == 200
            assert response.headers["Content-Type"].startswith("text/event-stream")
            events = _read_sse_data(response)
        finally:
            connection.close()

        # The upstream saw exactly one non-streaming request with
        # stream_options removed (it is invalid on stream:false requests).
        assert len(upstream.seen) == 1
        upstream_payload = upstream.seen[0]["payload"]
        assert upstream_payload["stream"] is False
        assert "stream_options" not in upstream_payload
        assert upstream_payload["tools"] == STREAMING_TOOL_REQUEST["tools"]
        assert upstream_payload["tool_choice"] == "required"

        chunks = [json.loads(event) for event in events[:-1]]
        assert events[-1] == "[DONE]"
        # id/model/created/system_fingerprint survive from the upstream
        # completed response on every chunk.
        for chunk in chunks:
            assert chunk["id"] == TOOL_CHAT_COMPLETION["id"]
            assert chunk["model"] == TOOL_CHAT_COMPLETION["model"]
            assert chunk["created"] == TOOL_CHAT_COMPLETION["created"]
            assert (
                chunk["system_fingerprint"]
                == TOOL_CHAT_COMPLETION["system_fingerprint"]
            )
            assert chunk["object"] == "chat.completion.chunk"

        # Canonical sequence mirrored from the claude-subscription gateway:
        # role chunk, one indexed tool-call delta with the arguments emitted
        # exactly once, finish chunk, usage chunk, [DONE].
        role_chunk, tool_chunk, finish_chunk, usage_chunk = chunks
        assert role_chunk["choices"][0]["delta"] == {"role": "assistant"}
        assert role_chunk["choices"][0]["finish_reason"] is None

        tool_delta = tool_chunk["choices"][0]["delta"]["tool_calls"]
        assert tool_delta == [
            {
                "index": 0,
                "id": "call_weather_1",
                "type": "function",
                "function": {"name": "get_weather", "arguments": TOOL_ARGUMENTS},
            }
        ]

        assert finish_chunk["choices"][0]["delta"] == {}
        assert finish_chunk["choices"][0]["finish_reason"] == "tool_calls"

        assert usage_chunk["choices"] == []
        assert usage_chunk["usage"] == TOOL_CHAT_COMPLETION["usage"]

        # A real consumer's accumulation yields valid JSON arguments.
        accumulated = _accumulate_openai_stream(events)
        assert accumulated["finish_reason"] == "tool_calls"
        assert accumulated["tool_calls"][0]["name"] == "get_weather"
        assert json.loads(accumulated["tool_calls"][0]["arguments"]) == {
            "city": "Paris",
            "unit": "celsius",
        }
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["stream_mode"] == "de-stream"
    assert evidence["destreamed_requests"] == 1


def test_destream_is_immune_to_upstream_tool_argument_duplication_bug(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    """The bug is real under raw passthrough and gone under the default.

    The stub reproduces the deployed elizacloud proxy stream: incremental
    argument deltas plus a consolidated chunk repeating the full arguments.
    Raw passthrough hands that stream to the client, whose spec-mandated
    concatenation produces invalid JSON; the de-stream default never lets the
    buggy streaming path execute upstream.
    """

    passthrough = _start(upstream, tmp_path / "passthrough", passthrough_streaming=True)
    try:
        lane_token = passthrough.env_for_harness("openclaw")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            passthrough.base_url, lane_token, STREAMING_TOOL_REQUEST
        )
        try:
            events = _read_sse_data(response)
        finally:
            connection.close()
        corrupted = _accumulate_openai_stream(events)
        assert (
            corrupted["tool_calls"][0]["arguments"]
            == TOOL_ARGUMENTS + TOOL_ARGUMENTS
        )
        with pytest.raises(json.JSONDecodeError):
            json.loads(corrupted["tool_calls"][0]["arguments"])
    finally:
        passthrough.close()

    destream = _start(upstream, tmp_path / "destream")
    try:
        lane_token = destream.env_for_harness("openclaw")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            destream.base_url, lane_token, STREAMING_TOOL_REQUEST
        )
        try:
            events = _read_sse_data(response)
        finally:
            connection.close()
        clean = _accumulate_openai_stream(events)
        assert json.loads(clean["tool_calls"][0]["arguments"]) == {
            "city": "Paris",
            "unit": "celsius",
        }
    finally:
        destream.close()


def test_destream_streams_plain_content_completions_too(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            forwarder.base_url,
            lane_token,
            {"model": "gemma-4-31b", "messages": [], "stream": True},
        )
        try:
            assert response.status == 200
            events = _read_sse_data(response)
        finally:
            connection.close()
        assert upstream.seen[0]["payload"]["stream"] is False
        accumulated = _accumulate_openai_stream(events)
        assert accumulated["content"] == "4"
        assert accumulated["finish_reason"] == "stop"
        assert accumulated["usage"] == CHAT_COMPLETION["usage"]
        assert accumulated["tool_calls"] == []
        first_chunk = json.loads(events[0])
        assert first_chunk["id"] == CHAT_COMPLETION["id"]
        assert first_chunk["choices"][0]["delta"]["role"] == "assistant"
    finally:
        forwarder.close()


def test_passthrough_escape_hatch_env_restores_raw_streaming(
    upstream: _UpstreamServer,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(PASSTHROUGH_STREAMING_ENV, "1")
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        upstream.release_stream.set()
        connection, response = _open_stream(
            forwarder.base_url,
            lane_token,
            {"model": "gemma-4-31b", "messages": [], "stream": True},
        )
        try:
            assert response.status == 200
            raw = response.read()
        finally:
            connection.close()
        assert b"first-chunk" in raw
        assert b"data: [DONE]" in raw
        assert upstream.seen[0]["payload"]["stream"] is True
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["stream_mode"] == "passthrough"
    assert evidence["destreamed_requests"] == 0


def test_destream_relays_upstream_errors_without_fabricating_a_stream(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    upstream.fail_status = 429
    # Single-attempt: this test pins the verbatim relay of one upstream error.
    # The transient-error retry envelope is exercised separately below.
    forwarder = _start(upstream, tmp_path, max_upstream_attempts=1)
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            forwarder.base_url, lane_token, STREAMING_TOOL_REQUEST
        )
        try:
            assert response.status == 429
            assert response.headers["Content-Type"] == "application/json"
            body = response.read()
        finally:
            connection.close()
        assert json.loads(body) == {
            "error": {"message": "quota exhausted", "type": "rate_limit"}
        }
    finally:
        forwarder.close()


def test_destream_turns_unparseable_upstream_completion_into_502(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    upstream.invalid_json_completion = True
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            forwarder.base_url,
            lane_token,
            {"model": "gemma-4-31b", "messages": [], "stream": True},
        )
        try:
            assert response.status == 502
            body = response.read()
        finally:
            connection.close()
        error = json.loads(body)["error"]
        assert error["type"] == "provider_forwarder_upstream_error"
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["upstream_invalid_completions"] == 1
    assert evidence["destreamed_requests"] == 0


def test_destream_leaves_non_streaming_and_odd_bodies_untouched(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    forwarder = _start(upstream, tmp_path)
    try:
        lane_token = forwarder.env_for_harness("eliza")["OPENAI_API_KEY"]
        # stream:false and stream-absent requests relay unchanged.
        for payload in (
            {"model": "gemma-4-31b", "messages": [], "stream": False},
            {"model": "gemma-4-31b", "messages": []},
        ):
            status, body, headers = _request(
                forwarder.base_url,
                "POST",
                "/v1/chat/completions",
                token=lane_token,
                payload=payload,
            )
            assert status == 200
            assert headers["content-type"] == "application/json"
            assert json.loads(body) == CHAT_COMPLETION
        assert upstream.seen[0]["payload"]["stream"] is False
        assert "stream" not in upstream.seen[1]["payload"]
        # A non-object JSON body is not de-streamable; the upstream stays the
        # authority on accepting or rejecting it.
        status, body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload=None,
            extra_headers={"Content-Type": "application/json"},
            raw_body=b'["not", "a", "chat", "request"]',
        )
        assert status == 200
        assert upstream.seen[2]["payload"] == ["not", "a", "chat", "request"]
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
    # Single-attempt: verbatim relay of one upstream error (retries below).
    forwarder = _start(upstream, tmp_path, max_upstream_attempts=1)
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
        max_upstream_attempts=1,
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


# --- Transient upstream-error retry envelope (long-run reliability) ----------
# Regression coverage for the adhdbench hermes-leg progressive failure: a
# sustained upstream throttle/overload window is relayed verbatim, and because
# the native agent's tiny per-turn retry budget exhausts every turn, the leg
# fails contiguously to the end. The forwarder now rides transient upstream
# errors so a recoverable spike never cascades into a permanent leg failure.

_FAST_RETRY: dict[str, object] = {
    "retry_base_delay_seconds": 0.001,
    "retry_max_delay_seconds": 0.01,
    "retry_budget_seconds": 5.0,
}


def _fd_count() -> int | None:
    """Open file-descriptor count for this process, or None off Linux."""

    fd_dir = Path(f"/proc/{__import__('os').getpid()}/fd")
    if not fd_dir.is_dir():
        return None
    try:
        return len(list(fd_dir.iterdir()))
    except OSError:
        return None


def test_parse_retry_after_accepts_both_rfc7231_forms() -> None:
    from email.utils import format_datetime
    from datetime import datetime, timedelta, timezone

    assert _parse_retry_after("2") == 2.0
    assert _parse_retry_after("0") == 0.0
    # A past HTTP-date clamps to a non-negative wait.
    past = format_datetime(datetime.now(timezone.utc) - timedelta(seconds=30))
    assert _parse_retry_after(past) == 0.0
    future = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=5))
    assert 0.0 < _parse_retry_after(future) <= 6.0
    # A malformed negative delay clamps to an immediate (zero) wait.
    assert _parse_retry_after("-3") == 0.0
    # Unusable inputs yield no hint (caller falls back to its own backoff).
    for junk in (None, "", "   ", "soon", "1.5", 5):
        assert _parse_retry_after(junk) is None


def test_transient_upstream_error_is_retried_and_absorbed(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    upstream.transient_fail_remaining = 3
    upstream.transient_fail_status = 503
    forwarder = _start(
        upstream, tmp_path, max_upstream_attempts=4, **_FAST_RETRY
    )
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        # stream:false → de-stream path is bypassed; goes through _forward.
        status, body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload={"model": "gemma-4-31b", "messages": [], "stream": False},
        )
        # The client never saw the three 503s — the fourth attempt succeeded.
        assert status == 200
        assert json.loads(body) == CHAT_COMPLETION
        assert upstream.chat_calls == 4
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["upstream_retries"] == 3
    assert evidence["upstream_retry_exhaustions"] == 0
    assert evidence["upstream_transport_failures"] == 0


def test_transient_error_on_destream_path_is_absorbed(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    upstream.transient_fail_remaining = 2
    upstream.transient_fail_status = 429
    upstream.transient_retry_after = "1"  # capped by retry_max_delay_seconds
    forwarder = _start(
        upstream, tmp_path, max_upstream_attempts=4, **_FAST_RETRY
    )
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        connection, response = _open_stream(
            forwarder.base_url,
            lane_token,
            {"model": "gemma-4-31b", "messages": [], "stream": True},
        )
        try:
            assert response.status == 200
            events = _read_sse_data(response)
        finally:
            connection.close()
        accumulated = _accumulate_openai_stream(events)
        assert accumulated["content"] == "4"
        assert upstream.chat_calls == 3
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["upstream_retries"] == 2
    assert evidence["destreamed_requests"] == 1


def test_persistent_upstream_error_surfaces_the_real_status_after_exhaustion(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    upstream.fail_status = 503
    forwarder = _start(
        upstream, tmp_path, max_upstream_attempts=3, **_FAST_RETRY
    )
    try:
        lane_token = forwarder.env_for_harness("openclaw")["OPENAI_API_KEY"]
        status, body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload={"model": "gemma-4-31b", "messages": [], "stream": False},
        )
        # Retries were tried and exhausted; the harness sees the real 503, not
        # a fabricated 502 — its own failure handling stays authoritative.
        assert status == 503
        assert json.loads(body) == {
            "error": {"message": "quota exhausted", "type": "rate_limit"}
        }
        assert upstream.chat_calls == 3
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["upstream_retries"] == 2
    assert evidence["upstream_retry_exhaustions"] == 1


def test_transient_transport_failure_recovers_then_succeeds(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    """Upstream connections dropped mid-flight are retried through to a 200.

    A read/connect failure (no HTTP status) is the other transient class: it
    must be retried like a 5xx, not turned straight into a 502.
    """

    upstream.transport_fail_remaining = 2
    forwarder = _start(
        upstream,
        tmp_path,
        max_upstream_attempts=4,
        retry_base_delay_seconds=0.001,
        retry_max_delay_seconds=0.01,
        retry_budget_seconds=5.0,
    )
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        status, body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload={"model": "gemma-4-31b", "messages": [], "stream": False},
        )
        assert status == 200
        assert json.loads(body) == CHAT_COMPLETION
        assert upstream.chat_calls == 3
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["upstream_transport_failures"] == 2
    assert evidence["upstream_retries"] == 2
    assert evidence["upstream_retry_exhaustions"] == 0


def test_retry_envelope_reads_env_overrides(
    upstream: _UpstreamServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(MAX_UPSTREAM_ATTEMPTS_ENV, "2")
    monkeypatch.setenv(RETRY_BUDGET_SECONDS_ENV, "3.5")
    upstream.fail_status = 500
    forwarder = _start(
        upstream,
        tmp_path,
        retry_base_delay_seconds=0.001,
        retry_max_delay_seconds=0.01,
    )
    try:
        assert forwarder._state.max_upstream_attempts == 2
        assert forwarder._state.retry_budget_seconds == 3.5
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        status, _body, _headers = _request(
            forwarder.base_url,
            "POST",
            "/v1/chat/completions",
            token=lane_token,
            payload={"model": "gemma-4-31b", "messages": [], "stream": False},
        )
        assert status == 500
        assert upstream.chat_calls == 2  # env-capped attempts honored
    finally:
        forwarder.close()


def test_invalid_retry_env_fails_closed(
    upstream: _UpstreamServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(MAX_UPSTREAM_ATTEMPTS_ENV, "0")
    with pytest.raises(ValueError, match="positive integer"):
        _start(upstream, tmp_path)
    monkeypatch.setenv(MAX_UPSTREAM_ATTEMPTS_ENV, "3")
    monkeypatch.setenv(RETRY_BUDGET_SECONDS_ENV, "not-a-number")
    with pytest.raises(ValueError, match="positive number"):
        _start(upstream, tmp_path)


def test_forwarder_soak_rides_recurring_transient_windows_without_leaking(
    upstream: _UpstreamServer, tmp_path: Path
) -> None:
    """Long-run regression: thousands of requests through recurring transient
    upstream windows keep succeeding with stable threads/fds — the property the
    3.5h adhdbench cohort violated when a throttle window cascaded to a solid
    block of failures."""

    total = 2400
    burst_every = 300
    burst_size = 3  # < max_upstream_attempts so every burst is fully absorbed
    forwarder = _start(
        upstream,
        tmp_path,
        max_upstream_attempts=5,
        retry_base_delay_seconds=0.001,
        retry_max_delay_seconds=0.005,
        retry_budget_seconds=5.0,
    )
    try:
        lane_token = forwarder.env_for_harness("hermes")["OPENAI_API_KEY"]
        base_threads = threading.active_count()
        base_fd = _fd_count()
        thread_samples: list[int] = []
        fd_samples: list[int] = []
        non_200 = 0
        for i in range(1, total + 1):
            if i % burst_every == 0:
                with upstream.counter_lock:
                    upstream.transient_fail_remaining = burst_size
                    upstream.transient_fail_status = 503 if i % 2 else 429
            status, _body, _headers = _request(
                forwarder.base_url,
                "POST",
                "/v1/chat/completions",
                token=lane_token,
                payload={"model": "gemma-4-31b", "messages": [], "stream": False},
            )
            if status != 200:
                non_200 += 1
            if i % 400 == 0:
                thread_samples.append(threading.active_count())
                fd = _fd_count()
                if fd is not None:
                    fd_samples.append(fd)
        # Every transient burst was fully absorbed: zero client-visible failures.
        assert non_200 == 0
        # Threads never accumulate — the serving loop reaps every handler.
        assert max(thread_samples) <= base_threads + 4, thread_samples
        if base_fd is not None and fd_samples:
            # No descriptor leak across the whole run.
            assert max(fd_samples) <= base_fd + 8, (base_fd, fd_samples)
    finally:
        evidence_file = forwarder.close()
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    assert evidence["harness_request_counts"]["hermes"] == total
    # Retries actually fired (each burst) but none exhausted.
    assert evidence["upstream_retries"] >= (total // burst_every) * burst_size
    assert evidence["upstream_retry_exhaustions"] == 0
