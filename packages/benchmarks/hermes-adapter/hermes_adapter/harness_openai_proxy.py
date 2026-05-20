"""OpenAI-compatible bridge from Hermes-native envs to benchmark harnesses.

The Hermes-native terminal/simulation envs drive their rollout loop through an
OpenAI chat-completions endpoint. For cross-harness runs we keep that real env
and scorer, but point the model endpoint at this local bridge so model turns
    are answered by the selected harness adapter instead of bypassing the
harness label.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Mapping


class HarnessOpenAIProxy:
    """Small local ``/chat/completions`` server backed by a harness client."""

    def __init__(
        self,
        *,
        harness: str,
        provider: str,
        model: str,
        upstream_base_url: str | None = None,
    ) -> None:
        harness = harness.strip().lower()
        if harness not in {"eliza", "hermes", "openclaw"}:
            raise ValueError(f"unsupported proxy harness: {harness!r}")
        self.harness = harness
        self.provider = provider or "cerebras"
        self.model = model
        self.upstream_base_url = upstream_base_url
        self._client: Any | None = None
        self._server_handle: Any | None = None
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.base_url: str | None = None

    def start(self) -> "HarnessOpenAIProxy":
        self._client, self._server_handle = _build_client(
            harness=self.harness,
            provider=self.provider,
            model=self.model,
            upstream_base_url=self.upstream_base_url,
        )

        proxy = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:  # noqa: N802
                if self.path.rstrip("/") in {"", "/v1", "/health"}:
                    self._write_json({"status": "ok", "harness": proxy.harness})
                    return
                self.send_error(404)

            def do_POST(self) -> None:  # noqa: N802
                path = self.path.rstrip("/")
                if path not in {"/chat/completions", "/v1/chat/completions"}:
                    self.send_error(404)
                    return
                try:
                    payload = self._read_json()
                    response = proxy.complete(payload)
                    self._write_json(response)
                except Exception as exc:  # noqa: BLE001
                    self._write_json(
                        {
                            "error": {
                                "message": f"{exc.__class__.__name__}: {exc}",
                                "type": "harness_proxy_error",
                            }
                        },
                        status=500,
                    )

            def log_message(self, format: str, *args: Any) -> None:
                return

            def _read_json(self) -> dict[str, Any]:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length) if length else b"{}"
                data = json.loads(raw.decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("request body must be a JSON object")
                return data

            def _write_json(self, payload: Mapping[str, Any], *, status: int = 200) -> None:
                body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        host = "127.0.0.1"
        self._httpd = ThreadingHTTPServer((host, _free_port(host)), Handler)
        self.base_url = f"http://{host}:{self._httpd.server_port}/v1"
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name=f"{self.harness}-openai-proxy",
            daemon=True,
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        stop = getattr(self._server_handle, "stop", None)
        if callable(stop):
            stop()
        self._server_handle = None
        self._client = None

    def complete(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if self._client is None:
            raise RuntimeError("proxy client is not started")
        messages = _messages(payload.get("messages"))
        text = _last_user_text(messages)
        context: dict[str, Any] = {
            "benchmark": "hermes_native_env",
            "source_benchmark": "hermes_native_env",
            "harness_proxy": self.harness,
            "messages": messages,
            "tools": payload.get("tools") if isinstance(payload.get("tools"), list) else [],
            "tool_choice": payload.get("tool_choice"),
            "temperature": payload.get("temperature"),
            "max_tokens": payload.get("max_tokens"),
        }
        response = self._client.send_message(text, context=context)
        content = str(getattr(response, "text", "") or "")
        params = getattr(response, "params", {}) or {}
        tool_calls = _normalize_tool_calls(params.get("tool_calls"))
        message: dict[str, Any] = {"role": "assistant", "content": content}
        if tool_calls:
            message["tool_calls"] = tool_calls
            message["content"] = content or None
        now = int(time.time())
        return {
            "id": f"chatcmpl-{self.harness}-{now}",
            "object": "chat.completion",
            "created": now,
            "model": self.model,
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
            "usage": _usage(params.get("usage")),
        }


def _build_client(
    *,
    harness: str,
    provider: str,
    model: str,
    upstream_base_url: str | None,
) -> tuple[Any, Any | None]:
    if harness == "eliza":
        from eliza_adapter import ElizaClient, ElizaServerManager  # noqa: WPS433

        if not os.environ.get("ELIZA_BENCH_URL"):
            server = ElizaServerManager()
            server.start()
            return server.client, server
        client = ElizaClient()
        client.wait_until_ready(timeout=180)
        return client, None
    if harness == "hermes":
        from hermes_adapter.client import HermesClient  # noqa: WPS433

        return (
            HermesClient(
                provider=provider or "cerebras",
                model=model,
                base_url=upstream_base_url,
                mode="in_process",
            ),
            None,
        )
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient  # noqa: WPS433

        return (
            OpenClawClient(
                provider=provider or "cerebras",
                model=model,
                base_url=upstream_base_url,
                direct_openai_compatible=True,
            ),
            None,
        )
    raise ValueError(f"unsupported proxy harness: {harness!r}")


def _free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _messages(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    rows: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, dict):
            rows.append(dict(item))
    return rows


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts: list[str] = []
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        parts.append(part["text"])
                return "\n".join(parts)
    return json.dumps(messages, ensure_ascii=True)


def _normalize_tool_calls(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    calls: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        if not isinstance(function, dict):
            name = item.get("name")
            arguments = item.get("arguments")
            if isinstance(name, str):
                function = {
                    "name": name,
                    "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments or {}),
                }
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            continue
        arguments = function.get("arguments")
        calls.append(
            {
                "id": str(item.get("id") or f"call_{index}"),
                "type": "function",
                "function": {
                    "name": function["name"],
                    "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments or {}),
                },
            }
        )
    return calls


def _usage(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    usage: dict[str, int] = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        raw = value.get(key)
        usage[key] = int(raw) if isinstance(raw, (int, float)) else 0
    return usage


__all__ = ["HarnessOpenAIProxy"]
