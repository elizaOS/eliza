"""OpenAI-compatible proxy that routes LOCA calls through benchmark harnesses."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import threading
from typing import Any, Mapping, Sequence
from uuid import uuid4

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


class HarnessOpenAIProxy:
    """Expose ``/v1/chat/completions`` backed by ``ElizaClient.send_message``.

    ``ElizaClient`` delegates to Hermes/OpenClaw when the orchestrator sets
    ``BENCHMARK_HARNESS``. LOCA only needs an OpenAI-compatible HTTP endpoint,
    so this proxy keeps LOCA's upstream runner intact while exercising the
    selected harness.
    """

    def __init__(self, host: str = "127.0.0.1") -> None:
        self.client = _build_client()
        self.client.reset("loca-bench", "loca_bench")
        self.session_id = f"loca-bench-{uuid4().hex[:12]}"
        self._server = _HarnessHTTPServer(
            (host, 0),
            _HarnessHandler,
            self.client,
            self.session_id,
        )
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="loca-harness-openai-proxy",
            daemon=True,
        )

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


class _HarnessHTTPServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler_class: type[BaseHTTPRequestHandler],
        client: ElizaClient,
        session_id: str,
    ) -> None:
        super().__init__(server_address, request_handler_class)
        self.client = client
        self.session_id = session_id


class _HarnessHandler(BaseHTTPRequestHandler):
    server: _HarnessHTTPServer

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._write_json(404, {"error": {"message": "unknown endpoint"}})
            return
        try:
            payload = self._read_json()
            response = self.server.client.send_message(
                _last_user_text(payload.get("messages")),
                context={
                    "benchmark": "loca_bench",
                    "messages": payload.get("messages", []),
                    "system_prompt": _first_system_text(payload.get("messages")),
                    "tools": payload.get("tools", []),
                    "session_id": self.server.session_id,
                },
            )
            self._write_json(200, _chat_completion_payload(payload, response))
        except Exception as exc:  # pragma: no cover - exercised by live harnesses
            logger.exception("LOCA harness proxy failed")
            self._write_json(500, {"error": {"message": str(exc)}})

    def log_message(self, fmt: str, *args: object) -> None:
        logger.debug("LOCA harness proxy: " + fmt, *args)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length).decode("utf-8")
        data = json.loads(raw) if raw else {}
        if not isinstance(data, dict):
            raise ValueError("expected JSON object")
        return data

    def _write_json(self, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _chat_completion_payload(payload: Mapping[str, Any], response: Any) -> dict[str, Any]:
    tool_calls = _openai_tool_calls(response.params.get("tool_calls"))
    message: dict[str, Any] = {
        "role": "assistant",
        "content": None if tool_calls else str(response.text or ""),
    }
    finish_reason = "stop"
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"
    usage = response.params.get("usage") if isinstance(response.params, Mapping) else None
    if not isinstance(usage, Mapping):
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    return {
        "id": "chatcmpl-loca-harness",
        "object": "chat.completion",
        "created": 0,
        "model": str(payload.get("model") or ""),
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": dict(usage),
    }


def _build_client() -> Any:
    harness = (
        os.environ.get("BENCHMARK_HARNESS")
        or os.environ.get("ELIZA_BENCH_HARNESS")
        or ""
    ).strip().lower()
    timeout_s = float(os.environ.get("LOCA_HARNESS_TIMEOUT_S", "90"))
    provider = (os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras").strip().lower()
    model = (
        os.environ.get("BENCHMARK_MODEL_NAME")
        or os.environ.get("MODEL_NAME")
        or os.environ.get("CEREBRAS_MODEL")
        or "gpt-oss-120b"
    ).strip()
    if harness == "hermes":
        from hermes_adapter.client import HermesClient

        return HermesClient(provider=provider, model=model, timeout_s=timeout_s)
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient

        return OpenClawClient(
            provider=provider,
            model=model,
            thinking_level=os.environ.get("LOCA_OPENCLAW_THINKING", "low"),
            timeout_s=timeout_s,
        )
    return ElizaClient()


def _openai_tool_calls(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return []
    calls: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, Mapping):
            continue
        function = item.get("function")
        if isinstance(function, Mapping):
            name = function.get("name")
            args = function.get("arguments", "{}")
        else:
            name = item.get("name") or item.get("tool")
            args = item.get("arguments", item.get("args", {}))
        if not isinstance(name, str) or not name:
            continue
        if not isinstance(args, str):
            args = json.dumps(args if args is not None else {}, ensure_ascii=False)
        calls.append(
            {
                "id": str(item.get("id") or f"call_loca_harness_{index}"),
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": args,
                },
            }
        )
    return calls


def _first_system_text(messages: object) -> str | None:
    if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes)):
        return None
    for item in messages:
        if isinstance(item, Mapping) and item.get("role") == "system":
            return _content_text(item.get("content"))
    return None


def _last_user_text(messages: object) -> str:
    if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes)):
        return ""
    for item in reversed(messages):
        if isinstance(item, Mapping) and item.get("role") == "user":
            text = _content_text(item.get("content"))
            if text:
                return text
    return ""


def _content_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, Mapping):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return str(value)


__all__ = ["HarnessOpenAIProxy"]
