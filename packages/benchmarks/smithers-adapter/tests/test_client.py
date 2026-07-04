"""Offline unit tests for SmithersClient payload/response handling."""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_TEST_DIR = Path(__file__).resolve().parent
if str(_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR))

from live_harness import materialize_live_smithers_install
from smithers_adapter.client import (
    MessageResponse,
    SmithersClient,
    resolve_install_dir,
)


def _client(tmp_path: Path) -> SmithersClient:
    # Point at a throwaway dir so no real install is required for offline tests.
    return SmithersClient(install_dir=tmp_path, provider="cerebras", model="gpt-oss-120b", api_key="k")


def test_build_payload_defaults_reasoning_low_for_gpt_oss(tmp_path: Path) -> None:
    client = _client(tmp_path)
    payload = client.build_payload("hi", None)
    assert payload["model"] == "gpt-oss-120b"
    assert payload["provider"] == "cerebras"
    assert payload["base_url"] == "https://api.cerebras.ai/v1"
    assert payload["reasoning_effort"] == "low"
    assert payload["api_key"] == "k"


def test_build_payload_passes_tools_and_tool_choice(tmp_path: Path) -> None:
    client = _client(tmp_path)
    tools = [{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}]
    payload = client.build_payload(
        "do it",
        {"tools": tools, "tool_choice": "required", "temperature": 0.0, "system_prompt": "sp"},
    )
    assert payload["tools"] == tools
    assert payload["tool_choice"] == "required"
    assert payload["temperature"] == 0.0
    assert payload["system_prompt"] == "sp"


def test_parse_response_extracts_fields() -> None:
    raw = {
        "text": "hello",
        "thought": "thinking",
        "actions": ["get_weather"],
        "params": {"tool_calls": [{"id": "1", "name": "get_weather", "arguments": "{}"}], "usage": {}},
    }
    resp = SmithersClient._parse_response(raw)
    assert isinstance(resp, MessageResponse)
    assert resp.text == "hello"
    assert resp.thought == "thinking"
    assert resp.actions == ["get_weather"]
    assert resp.params["tool_calls"][0]["name"] == "get_weather"


def test_parse_response_falls_back_to_thought_when_text_empty() -> None:
    resp = SmithersClient._parse_response({"text": "", "thought": "reasoned", "actions": [], "params": {}})
    assert resp.text == "reasoned"


def test_reset_records_task_and_benchmark(tmp_path: Path) -> None:
    client = _client(tmp_path)
    out = client.reset(task_id="t1", benchmark="bfcl")
    assert out["task_id"] == "t1"
    assert client._task_id == "t1"
    assert client._benchmark == "bfcl"


def test_resolve_install_dir_prefers_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SMITHERS_DIR", str(tmp_path))
    assert resolve_install_dir() == tmp_path


def test_materialize_script_writes_harness(tmp_path: Path) -> None:
    client = _client(tmp_path)
    target = client.materialize_script()
    assert target.name == "smithers_turn.mjs"
    assert target.exists()
    assert "OpenAIAgent" in target.read_text(encoding="utf-8")
    assert (tmp_path / "optimization.mjs").exists()


def test_build_command_shape(tmp_path: Path) -> None:
    client = _client(tmp_path)
    # bun may be absent in CI; only assert structure when resolvable.
    try:
        cmd = client.build_command()
    except FileNotFoundError:
        return
    assert cmd[1] == "run"
    assert cmd[-1].endswith("smithers_turn.mjs")


def test_send_message_runs_real_smithers_harness_against_local_chat_server(
    tmp_path: Path,
) -> None:
    install_dir = tmp_path / "smithers-install"
    materialize_live_smithers_install(install_dir)
    received: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            body["_path"] = self.path
            received.append(body)
            if self.path.endswith("/responses"):
                payload = {
                    "id": "resp-smithers-local",
                    "object": "response",
                    "created_at": 1,
                    "status": "completed",
                    "model": body.get("model", "local-smithers"),
                    "output": [
                        {
                            "id": "msg-smithers-local",
                            "type": "message",
                            "status": "completed",
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "local smithers benchmark proof",
                                    "annotations": [],
                                }
                            ],
                        }
                    ],
                    "usage": {
                        "input_tokens": 7,
                        "output_tokens": 5,
                        "total_tokens": 12,
                    },
                }
            else:
                payload = {
                    "id": "chatcmpl-smithers-local",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body.get("model", "local-smithers"),
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "local smithers benchmark proof",
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 7,
                        "completion_tokens": 5,
                        "total_tokens": 12,
                    },
                }
            data = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = SmithersClient(
            install_dir=install_dir,
            provider="openai",
            model="local-smithers",
            api_key="local-key",
            base_url=f"http://127.0.0.1:{server.server_port}/v1",
            timeout_s=60,
        )
        response = client.send_message(
            "run the Smithers benchmark harness",
            {"benchmark": "smithers-adapter-live-proof"},
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)

    assert response.text == "local smithers benchmark proof"
    assert response.params["usage"] == {
        "prompt_tokens": 7,
        "completion_tokens": 5,
        "total_tokens": 12,
        "cached_tokens": 0,
        "reasoning_tokens": 0,
    }
    assert received
    assert received[0]["model"] == "local-smithers"
    assert received[0]["_path"] in {"/v1/chat/completions", "/v1/responses"}
