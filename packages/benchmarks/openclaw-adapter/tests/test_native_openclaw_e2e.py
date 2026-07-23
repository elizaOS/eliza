"""Exercises the installed OpenClaw loop and generated plugin against a local model stub.

The tool-bearing contract here is the capture-stop regression guard: the stub
model demands a benchmark tool call on *every* completion, so a runtime that
iterates on the bridge's placeholder acknowledgements would loop until the
context/token budget dies (observed as ~90 billed completions per env turn on
tblite). The fixed contract is exactly one provider completion per turn, a
``toolUse``-terminated session, and a successful, publishable trajectory.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from openclaw_adapter.client import OpenClawClient


_SYSTEM_SENTINEL = "OPENCLAW_BENCHMARK_SYSTEM_SENTINEL_7B9F"


def _completion(body: dict[str, Any], *, final: bool) -> dict[str, object]:
    message: dict[str, object]
    finish_reason: str
    if final:
        message = {"role": "assistant", "content": "probe complete"}
        finish_reason = "stop"
    else:
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_probe",
                    "type": "function",
                    "function": {
                        "name": "record_probe",
                        "arguments": json.dumps({"value": "sentinel"}),
                    },
                }
            ],
        }
        finish_reason = "tool_calls"
    return {
        "id": "chatcmpl-openclaw-probe",
        "object": "chat.completion",
        "created": 1,
        "model": body.get("model", "claude-opus-4-8"),
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15},
    }


def _stream_chunks(body: dict[str, Any], *, final: bool) -> list[dict[str, object]]:
    if final:
        deltas = [
            ({"role": "assistant", "content": "probe complete"}, None),
            ({}, "stop"),
        ]
    else:
        deltas = [
            (
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_probe",
                            "type": "function",
                            "function": {
                                "name": "record_probe",
                                "arguments": json.dumps({"value": "sentinel"}),
                            },
                        }
                    ],
                },
                None,
            ),
            ({}, "tool_calls"),
        ]
    chunks = [
        {
            "id": "chatcmpl-openclaw-probe",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": body.get("model", "claude-opus-4-8"),
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        for delta, finish_reason in deltas
    ]
    stream_options = body.get("stream_options")
    if isinstance(stream_options, dict) and stream_options.get("include_usage") is True:
        prompt_tokens = 17 if final else 11
        completion_tokens = 3 if final else 4
        chunks.append(
            {
                "id": "chatcmpl-openclaw-probe",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": body.get("model", "claude-opus-4-8"),
                "choices": [],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                    "prompt_tokens_details": {"cached_tokens": 0},
                },
            }
        )
    return chunks


def _serve_stub(
    requests: list[dict[str, Any]],
    *,
    final_fn,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            requests.append(body)
            final = final_fn(body)
            if body.get("stream") is True:
                chunks = _stream_chunks(body, final=final)
                encoded = (
                    "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
                    + "data: [DONE]\n\n"
                )
                raw = encoded.encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
            else:
                raw = json.dumps(_completion(body, final=final)).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _make_client(server: ThreadingHTTPServer, tmp_path: Path) -> OpenClawClient:
    return OpenClawClient(
        binary_path=Path(os.environ["OPENCLAW_E2E_BIN"]),
        provider="claude-subscription",
        model="claude-opus-4-8",
        api_key="gateway-sentinel",
        base_url=f"http://127.0.0.1:{server.server_port}",
        native_state_root=tmp_path / "state",
        thinking_level="medium",
        timeout_s=120,
    )


@pytest.mark.skipif(
    not os.environ.get("OPENCLAW_E2E_BIN"),
    reason="set OPENCLAW_E2E_BIN to run the installed OpenClaw contract",
)
def test_installed_openclaw_captures_tool_batch_in_one_completion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[dict[str, Any]] = []
    telemetry_path = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry_path))

    # The stub never yields a final text turn: every completion demands
    # another tool call. Only a loop that stops after the first captured
    # batch can finish this turn with a single request.
    server = _serve_stub(requests, final_fn=lambda body: False)
    try:
        client = _make_client(server, tmp_path)
        assert client.health()["status"] == "ready"
        client.reset("probe-1", "native-openclaw-e2e")
        response = client.send_message(
            "Call record_probe with value sentinel.",
            context={
                "messages": [
                    {"role": "system", "content": _SYSTEM_SENTINEL},
                    {
                        "role": "user",
                        "content": "Call record_probe with value sentinel.",
                    },
                ],
                "system_hint": _SYSTEM_SENTINEL,
                "reasoning_effort": "medium",
                "tool_choice": "required",
                "capture_stop": True,
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "record_probe",
                            "description": "Record one probe value.",
                            "parameters": {
                                "type": "object",
                                "properties": {"value": {"type": "string"}},
                                "required": ["value"],
                            },
                        },
                    }
                ],
            },
        )
    finally:
        server.shutdown()
        server.server_close()

    assert response.actions == ["record_probe"]
    assert response.params["record_probe"] == {"value": "sentinel"}
    metadata = response.params["_meta"]["openclaw_adapter"]
    assert metadata["agent_runtime"] == "openclaw"
    assert metadata["native_runtime_class"] == "openclaw.agent.embedded"
    assert metadata["native_runtime_api"] == "openclaw agent --local --json"
    assert metadata["tool_bridge"] == "native_plugin"
    assert metadata["capture_stop_after_scored_action"] is True
    assert metadata["publishable_native"] is True
    assert metadata["native_system_prompt_surface"] == "workspace/AGENTS.md"
    assert metadata["native_system_prompt_in_cli_message"] is False
    # Exactly one billed completion for the whole turn — the amplifier
    # regression this test exists to catch.
    assert len(requests) == 1
    assert requests[0]["tools"][0]["function"]["name"] == "record_probe"
    assert requests[0]["stream"] is True
    assert requests[0]["stream_options"] == {"include_usage": True}
    assert requests[0]["reasoning_effort"] == "medium"
    messages = requests[0].get("messages")
    assert isinstance(messages, list)
    system_contents = [
        str(message.get("content") or "")
        for message in messages
        if isinstance(message, dict) and message.get("role") == "system"
    ]
    user_contents = [
        str(message.get("content") or "")
        for message in messages
        if isinstance(message, dict) and message.get("role") == "user"
    ]
    assert sum(content.count(_SYSTEM_SENTINEL) for content in system_contents) == 1, (
        json.dumps(messages, ensure_ascii=True)
    )
    assert all(_SYSTEM_SENTINEL not in content for content in user_contents)
    expected_usage = {
        "prompt_tokens": 11,
        "completion_tokens": 4,
        "total_tokens": 15,
        "prompt_tokens_details": {
            "cached_tokens": 0,
            "cache_write_tokens": 0,
        },
    }
    assert response.params["usage"] == expected_usage
    assert metadata["native_session_assistant_model_call_count"] == 1
    assert metadata["native_session_terminal_stop_reason"] == "toolUse"
    assert metadata["native_usage_scope"] == "full_native_turn_aggregate"
    assert len(metadata["native_usage_sha256"]) == 64
    assert metadata["native_trajectory_evidence"] == "succeeded"
    assert len(metadata["native_trajectory_sha256"]) == 64
    assert metadata["native_runtime_identity_attested"] is True
    assert metadata["thinking_level_attested"] is True
    trajectory_paths = list((tmp_path / "state").glob("**/*.trajectory.jsonl"))
    assert len(trajectory_paths) == 1
    trajectory_records = [
        json.loads(line)
        for line in trajectory_paths[0].read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    session_ended = [
        record for record in trajectory_records if record.get("type") == "session.ended"
    ]
    assert len(session_ended) == 1
    assert session_ended[0]["data"]["status"] == "success"
    model_completed = [
        record
        for record in trajectory_records
        if record.get("type") == "model.completed"
    ]
    assert len(model_completed) == 1
    assert model_completed[0]["data"]["usage"] == {
        "input": 11,
        "output": 4,
        "total": 15,
    }
    telemetry = json.loads(telemetry_path.read_text(encoding="utf-8").splitlines()[0])
    assert telemetry["usage"] == expected_usage
    assert telemetry["runtime_provenance"]["agent_runtime"] == "openclaw"
    assert telemetry["runtime_provenance"]["publishable_native"] is True
    assert telemetry["runtime_provenance"]["native_usage_scope"] == (
        "full_native_turn_aggregate"
    )


@pytest.mark.skipif(
    not os.environ.get("OPENCLAW_E2E_BIN"),
    reason="set OPENCLAW_E2E_BIN to run the installed OpenClaw contract",
)
def test_installed_openclaw_text_turn_stays_single_round(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tool-free turns (the AGENT_SMOKE shape) keep the plain text contract:
    one completion, terminal ``stop``, and no capture-stop involvement."""
    requests: list[dict[str, Any]] = []
    telemetry_path = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry_path))

    server = _serve_stub(requests, final_fn=lambda body: True)
    try:
        client = _make_client(server, tmp_path)
        assert client.health()["status"] == "ready"
        client.reset("probe-2", "native-openclaw-e2e")
        response = client.send_message("Reply with the words: probe complete")
    finally:
        server.shutdown()
        server.server_close()

    assert response.text == "probe complete"
    metadata = response.params["_meta"]["openclaw_adapter"]
    assert metadata["capture_stop_after_scored_action"] is False
    assert metadata["publishable_native"] is True
    assert metadata["native_session_terminal_stop_reason"] == "stop"
    assert metadata["native_session_assistant_model_call_count"] == 1
    assert len(requests) == 1
