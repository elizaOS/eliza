"""OpenAI-compatible proxy that routes LOCA calls through benchmark harnesses."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import threading
from typing import Any, Mapping, Sequence
from uuid import uuid4

logger = logging.getLogger(__name__)


class UnsupportedHarnessPath(RuntimeError):
    """Raised when a requested cross-agent harness path is not comparable."""


class HarnessOpenAIProxy:
    """Expose ``/v1/chat/completions`` backed by ``ElizaClient.send_message``.

    ``ElizaClient`` delegates to Hermes/OpenClaw when the orchestrator sets
    ``BENCHMARK_HARNESS``. LOCA only needs an OpenAI-compatible HTTP endpoint,
    so this proxy keeps LOCA's upstream runner intact while exercising the
    selected harness.
    """

    def __init__(self, host: str = "127.0.0.1") -> None:
        self.harness_name = _selected_harness_name()
        self.client = _build_client()
        self.client.reset("loca-bench", "loca_bench")
        self.session_id = f"loca-bench-{uuid4().hex[:12]}"
        self._server = _HarnessHTTPServer(
            (host, 0),
            _HarnessHandler,
            self.client,
            self.session_id,
            self.harness_name,
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
        client: Any,
        session_id: str,
        harness_name: str,
    ) -> None:
        super().__init__(server_address, request_handler_class)
        self.client = client
        self.session_id = session_id
        self.harness_name = harness_name


class _HarnessHandler(BaseHTTPRequestHandler):
    server: _HarnessHTTPServer

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._write_json(404, {"error": {"message": "unknown endpoint"}})
            return
        try:
            payload = self._read_json()
            context = _context_from_payload(payload, self.server.session_id)
            response = self.server.client.send_message(
                _eliza_prompt_from_payload(payload),
                context=context,
            )
            self._write_json(
                200,
                _chat_completion_payload(
                    payload,
                    response,
                    harness_name=self.server.harness_name,
                ),
            )
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


def _chat_completion_payload(
    payload: Mapping[str, Any],
    response: Any,
    *,
    harness_name: str = "",
) -> dict[str, Any]:
    tool_calls = _openai_tool_calls(response.params.get("tool_calls"))
    message: dict[str, Any] = {
        "role": "assistant",
        "content": None if tool_calls else str(response.text or ""),
    }
    finish_reason = "stop"
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"
    metadata = response.params.get("eliza_metadata")
    if isinstance(metadata, Mapping):
        message["metadata"] = dict(metadata)
    usage = response.params.get("usage") if isinstance(response.params, Mapping) else None
    if not isinstance(usage, Mapping):
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    out = {
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
    metadata = _response_metadata(harness_name, response)
    if metadata:
        out["benchmark_metadata"] = metadata
    return out


def _selected_harness_name() -> str:
    return (
        os.environ.get("BENCHMARK_HARNESS")
        or os.environ.get("ELIZA_BENCH_HARNESS")
        or "eliza"
    ).strip().lower()


def _context_from_payload(
    payload: Mapping[str, Any],
    session_id: str,
) -> dict[str, object]:
    messages = payload.get("messages", [])
    tools = _normalize_tool_manifest(
        payload.get("tools", payload.get("functions", []))
    )
    context: dict[str, object] = {
        "benchmark": "loca_bench",
        "task_id": session_id,
        "messages": messages if isinstance(messages, list) else [],
        "system_prompt": _first_system_text(messages),
        "tools": tools,
        "session_id": session_id,
    }
    for key in (
        "tool_choice",
        "temperature",
        "top_p",
        "max_tokens",
        "max_completion_tokens",
        "reasoning_effort",
    ):
        value = payload.get(key)
        if value is not None:
            context[key] = value
    return context


def _normalize_tool_manifest(raw_tools: object) -> list[dict[str, Any]]:
    """Return OpenAI function tools as a flat list.

    LOCA's wrapper normally sends ``tools`` as a list of function definitions,
    but some upstream paths use ``functions`` or accidentally pass a nested
    ``[tools]`` shape. The benchmark proxy is the last bridge before Eliza, so
    it normalizes those equivalent OpenAI-compatible shapes instead of letting
    the planner see an empty tool inventory and invent helper calls.
    """

    if not isinstance(raw_tools, Sequence) or isinstance(
        raw_tools, (str, bytes, bytearray)
    ):
        return []
    normalized: list[dict[str, Any]] = []
    for item in raw_tools:
        if isinstance(item, Mapping):
            normalized.append(dict(item))
        elif isinstance(item, Sequence) and not isinstance(
            item, (str, bytes, bytearray)
        ):
            for nested in item:
                if isinstance(nested, Mapping):
                    normalized.append(dict(nested))
    return normalized


def _response_metadata(harness_name: str, response: Any) -> dict[str, Any]:
    if harness_name == "hermes":
        from eliza_loca.hermes_harness import hermes_loca_metadata

        return hermes_loca_metadata(response)
    if harness_name == "openclaw":
        params = getattr(response, "params", {})
        meta = params.get("_meta") if isinstance(params, Mapping) else {}
        adapter_meta = meta.get("openclaw_adapter") if isinstance(meta, Mapping) else None
        return {
            "benchmark_harness": "openclaw",
            "adapter": "openclaw-adapter",
            "openclaw_adapter": adapter_meta if isinstance(adapter_meta, Mapping) else {},
        }
    return {
        "benchmark_harness": harness_name or "eliza",
        "adapter": f"{harness_name or 'eliza'}-adapter",
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
        from eliza_loca.hermes_harness import build_hermes_loca_client

        return build_hermes_loca_client(
            provider=provider,
            model=model,
            timeout_s=timeout_s,
        )
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient

        mode = os.environ.get("LOCA_OPENCLAW_MODE", "").strip().lower()
        if mode not in {"direct-openai-compatible", "native-openai", "native"}:
            raise UnsupportedHarnessPath(
                "OpenClaw LOCA native path is not enabled: the documented "
                "OpenClaw CLI accepts a single --message turn and does not "
                "preserve LOCA's full OpenAI messages/tools payload. Set "
                "LOCA_OPENCLAW_MODE=direct-openai-compatible only for an "
                "explicit provider-level smoke path; do not score it as "
                "OpenClaw agent parity."
            )
        return OpenClawClient(
            provider=provider,
            model=model,
            thinking_level=os.environ.get("LOCA_OPENCLAW_THINKING", "low"),
            timeout_s=timeout_s,
            direct_openai_compatible=True,
        )
    from eliza_adapter.client import ElizaClient

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


def _eliza_prompt_from_payload(payload: Mapping[str, Any]) -> str:
    messages = payload.get("messages")
    user_text = _last_user_text(messages)
    tools = _normalize_tool_manifest(payload.get("tools", payload.get("functions", [])))
    tool_names = [_tool_name(tool) for tool in tools]
    tool_names = [name for name in tool_names if name]
    if not tool_names:
        return user_text

    return "\n\n".join(
        [
            user_text,
            "LOCA tool contract: call only one of the exact available function tool names below. "
            "Do not invent aggregate helper tools such as process_assignments_and_quizzes. "
            "If work remains, call a filesystem, memory, Canvas, python_execute, or claim_done tool.",
            "Available LOCA function tools:\n" + "\n".join(f"- {name}" for name in tool_names),
        ]
    )


def _tool_name(tool: Mapping[str, Any]) -> str:
    function = tool.get("function")
    if isinstance(function, Mapping):
        name = function.get("name")
        return name if isinstance(name, str) else ""
    name = tool.get("name")
    return name if isinstance(name, str) else ""


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


__all__ = ["HarnessOpenAIProxy", "UnsupportedHarnessPath"]
