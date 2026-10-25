"""Credential-free end-to-end diagnostic for the native Eliza benchmark lane.

The diagnostic launches the real TypeScript benchmark server and AgentRuntime,
but replaces the paid model and embedding backends with loopback fixtures. Its
artifacts are therefore explicitly nonpublishable; they prove harness plumbing,
not benchmark quality.
"""

from __future__ import annotations

import argparse
import json
import os
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from eliza_adapter.server_manager import ElizaServerManager


DIAGNOSTIC_MODEL = "eliza-native-loopback-diagnostic"
DIAGNOSTIC_REPLY = "DIAGNOSTIC_NATIVE_REPLY"
DIAGNOSTIC_TOOL = "diagnostic_lookup"
DIAGNOSTIC_TOOL_ARGUMENTS = {"query": "orchid"}
DIAGNOSTIC_SYSTEM_PROMPT = "ELIZA_ACTION_SYSTEM_SENTINEL_6D31"
FIXTURE_BEARER = "diagnostic-loopback-fixture"


@dataclass(frozen=True)
class UpstreamCall:
    method: str
    path: str
    body: Mapping[str, Any] | None
    authorization_valid: bool

    def summary(self) -> dict[str, object]:
        body = self.body or {}
        tools = body.get("tools")
        tool_names: list[str] = []
        if isinstance(tools, list):
            for tool in tools:
                if not isinstance(tool, Mapping):
                    continue
                function = tool.get("function")
                if isinstance(function, Mapping) and isinstance(
                    function.get("name"), str
                ):
                    tool_names.append(function["name"])
        response_format = body.get("response_format")
        response_format_type = (
            response_format.get("type")
            if isinstance(response_format, Mapping)
            else None
        )
        return {
            "method": self.method,
            "path": self.path,
            "model": body.get("model"),
            "message_count": len(body.get("messages", []))
            if isinstance(body.get("messages"), list)
            else 0,
            "tool_names": tool_names,
            "tool_choice": body.get("tool_choice"),
            "response_format_type": response_format_type,
            "authorization_present_and_valid": self.authorization_valid,
        }


class LoopbackOpenAiFixture:
    """Minimal OpenAI-compatible endpoint that records real runtime calls."""

    def __init__(self) -> None:
        self.calls: list[UpstreamCall] = []
        self._lock = threading.Lock()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: object) -> None:
                return

            def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
                fixture._record(self.command, self.path, None, self.headers)
                if self.path.rstrip("/") == "/v1/models":
                    self._write_json(
                        {
                            "object": "list",
                            "data": [
                                {
                                    "id": DIAGNOSTIC_MODEL,
                                    "object": "model",
                                    "owned_by": "loopback-diagnostic",
                                }
                            ],
                        }
                    )
                    return
                self.send_error(404)

            def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
                raw_length = self.headers.get("content-length")
                length = int(raw_length) if raw_length else 0
                raw = self.rfile.read(length)
                body = json.loads(raw.decode("utf-8"))
                if not isinstance(body, dict):
                    self.send_error(400)
                    return
                fixture._record(self.command, self.path, body, self.headers)
                if self.path.rstrip("/") != "/v1/chat/completions":
                    self.send_error(404)
                    return

                tool_names = _request_tool_names(body)
                if DIAGNOSTIC_TOOL in tool_names:
                    message: dict[str, object] = {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_diagnostic_lookup",
                                "type": "function",
                                "function": {
                                    "name": DIAGNOSTIC_TOOL,
                                    "arguments": json.dumps(
                                        DIAGNOSTIC_TOOL_ARGUMENTS,
                                        separators=(",", ":"),
                                    ),
                                },
                            }
                        ],
                    }
                    finish_reason = "tool_calls"
                else:
                    message = {"role": "assistant", "content": DIAGNOSTIC_REPLY}
                    finish_reason = "stop"

                self._write_json(
                    {
                        "id": f"chatcmpl-diagnostic-{len(fixture.calls)}",
                        "object": "chat.completion",
                        "created": 1,
                        "model": DIAGNOSTIC_MODEL,
                        "choices": [
                            {
                                "index": 0,
                                "message": message,
                                "finish_reason": finish_reason,
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 11,
                            "completion_tokens": 3,
                            "total_tokens": 14,
                        },
                    }
                )

            def _write_json(self, payload: Mapping[str, object]) -> None:
                encoded = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="eliza-native-loopback-upstream",
            daemon=True,
        )

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}/v1"

    def __enter__(self) -> LoopbackOpenAiFixture:
        self._thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def _record(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None,
        headers: Mapping[str, str],
    ) -> None:
        call = UpstreamCall(
            method=method,
            path=path,
            body=body,
            authorization_valid=(
                headers.get("authorization") == f"Bearer {FIXTURE_BEARER}"
            ),
        )
        with self._lock:
            self.calls.append(call)


def _request_tool_names(body: Mapping[str, Any]) -> list[str]:
    tools = body.get("tools")
    if not isinstance(tools, list):
        return []
    names: list[str] = []
    for tool in tools:
        if not isinstance(tool, Mapping):
            continue
        function = tool.get("function")
        if isinstance(function, Mapping) and isinstance(function.get("name"), str):
            names.append(function["name"])
    return names


@contextmanager
def _diagnostic_environment(
    *, upstream_base_url: str, output_dir: Path
) -> Iterator[None]:
    scrubbed_provider_keys = {
        "ANTHROPIC_API_KEY": "",
        "CEREBRAS_API_KEY": "",
        "GOOGLE_GENERATIVE_AI_API_KEY": "",
        "GROQ_API_KEY": "",
        "OPENROUTER_API_KEY": "",
        "XAI_API_KEY": "",
    }
    values = {
        **scrubbed_provider_keys,
        "BENCHMARK_HARNESS": "eliza",
        "BENCHMARK_MODEL_PROVIDER": "openai",
        "BENCHMARK_MODEL_NAME": DIAGNOSTIC_MODEL,
        "OPENAI_API_KEY": FIXTURE_BEARER,
        "OPENAI_BASE_URL": upstream_base_url,
        "OPENAI_SMALL_MODEL": DIAGNOSTIC_MODEL,
        "OPENAI_LARGE_MODEL": DIAGNOSTIC_MODEL,
        "OPENAI_RESPONSE_HANDLER_MODEL": DIAGNOSTIC_MODEL,
        "OPENAI_ACTION_PLANNER_MODEL": DIAGNOSTIC_MODEL,
        "ELIZA_PROVIDER": "openai",
        "ELIZA_BENCH_ALLOW_STUB_EMBEDDING": "1",
        "ELIZA_BENCH_SKIP_EMBEDDING": "1",
        "ELIZA_BENCH_MOCK": "false",
        "ELIZA_BENCH_LOG_DIR": str(output_dir),
        "BENCHMARK_RUN_DIR": str(output_dir),
        "BENCHMARK_TELEMETRY_JSONL": str(output_dir / "telemetry.jsonl"),
        "ELIZA_BENCH_HTTP_TIMEOUT": "90",
    }
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, prior in previous.items():
            if prior is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prior


def _assert_runtime_metadata(
    metadata: Mapping[str, object],
    *,
    api: str,
    tool_bridge: str,
) -> None:
    assert metadata["agent_label"] == "eliza"
    assert metadata["native_runtime_class"] == "@elizaos/core.AgentRuntime"
    assert metadata["native_runtime_api"] == api
    assert metadata["transport"] == "eliza_benchmark_http"
    assert metadata["tool_bridge"] == tool_bridge
    assert metadata["direct_model_bypass"] is False
    assert metadata["stand_in"] is True
    assert metadata["release_evidence"] is False
    assert str(metadata["trajectory_endpoint"]).startswith("/api/benchmark/trajectory")


def run_diagnostic(output_dir: Path) -> dict[str, object]:
    """Run both native Eliza paths and return the reviewed artifact payload."""
    output_dir.mkdir(parents=True, exist_ok=False)
    repo_root = Path(__file__).resolve().parents[3]

    with LoopbackOpenAiFixture() as upstream:
        with _diagnostic_environment(
            upstream_base_url=upstream.base_url,
            output_dir=output_dir,
        ):
            manager = ElizaServerManager(timeout=180, repo_root=repo_root)
            try:
                manager.start()
                health = manager.client.health()
                assert health["status"] == "ready"
                assert health["native_runtime_class"] == "@elizaos/core.AgentRuntime"
                assert health["native_runtime_api"] == "messageService.handleMessage"
                assert health["native_model_api"] == "useModel"
                assert health["transport"] == "eliza_benchmark_http"
                assert health["standIn"] is True
                assert health["stubEmbedding"] is True
                assert health["releaseEvidence"] is False

                generic_task = "native-runtime-generic"
                generic_benchmark = "native-runtime-diagnostic"
                manager.client.reset(
                    task_id=generic_task,
                    benchmark=generic_benchmark,
                )
                generic_response = manager.client.send_message(
                    f"Reply with the exact token {DIAGNOSTIC_REPLY}.",
                    {
                        "benchmark": generic_benchmark,
                        "task_id": generic_task,
                    },
                )
                assert generic_response.text == DIAGNOSTIC_REPLY
                _assert_runtime_metadata(
                    generic_response.metadata,
                    api="messageService.handleMessage",
                    tool_bridge="native_action_capture",
                )
                generic_trajectory = manager.client.trajectory(
                    benchmark=generic_benchmark,
                    task_id=generic_task,
                )
                generic_steps = generic_trajectory.get("steps")
                assert isinstance(generic_steps, list) and len(generic_steps) == 1
                assert generic_steps[0]["responseText"] == DIAGNOSTIC_REPLY
                assert generic_steps[0]["usage"]["callCount"] >= 1

                action_task = "native-runtime-action"
                action_benchmark = "action-calling"
                manager.client.reset(
                    task_id=action_task,
                    benchmark=action_benchmark,
                )
                action_response = manager.client.send_message(
                    "Look up orchid with the diagnostic tool.",
                    {
                        "benchmark": action_benchmark,
                        "task_id": action_task,
                        "messages": [
                            {
                                "role": "system",
                                "content": DIAGNOSTIC_SYSTEM_PROMPT,
                            },
                            {
                                "role": "user",
                                "content": "Look up orchid with the diagnostic tool.",
                            },
                        ],
                        "tools": [
                            {
                                "type": "function",
                                "function": {
                                    "name": DIAGNOSTIC_TOOL,
                                    "description": "Look up a diagnostic query.",
                                    "parameters": {
                                        "type": "object",
                                        "properties": {"query": {"type": "string"}},
                                        "required": ["query"],
                                        "additionalProperties": False,
                                    },
                                },
                            }
                        ],
                        "tool_choice": "required",
                        "max_tokens": 128,
                        "temperature": 0,
                    },
                )
                _assert_runtime_metadata(
                    action_response.metadata,
                    api="useModel",
                    tool_bridge="runtime_model_native_tools",
                )
                tool_calls = action_response.params.get("tool_calls")
                assert isinstance(tool_calls, list) and len(tool_calls) == 1
                function = tool_calls[0]["function"]
                assert function["name"] == DIAGNOSTIC_TOOL
                assert json.loads(function["arguments"]) == DIAGNOSTIC_TOOL_ARGUMENTS
                action_trajectory = manager.client.trajectory(
                    benchmark=action_benchmark,
                    task_id=action_task,
                )
                action_steps = action_trajectory.get("steps")
                assert isinstance(action_steps, list) and len(action_steps) == 1
                assert action_steps[0]["usage"]["callCount"] == 1
            finally:
                manager.stop()

        post_calls = [call for call in upstream.calls if call.method == "POST"]
        assert post_calls
        assert all(call.authorization_valid for call in upstream.calls)
        assert any(
            "HANDLE_RESPONSE" in _request_tool_names(call.body or {})
            for call in post_calls
        )
        assert any(
            DIAGNOSTIC_TOOL in _request_tool_names(call.body or {})
            for call in post_calls
        )
        action_model_calls = [
            call
            for call in post_calls
            if DIAGNOSTIC_TOOL in _request_tool_names(call.body or {})
        ]
        assert action_model_calls
        for call in action_model_calls:
            messages = (call.body or {}).get("messages")
            assert isinstance(messages, list)
            system_contents = [
                str(message.get("content") or "")
                for message in messages
                if isinstance(message, Mapping) and message.get("role") == "system"
            ]
            user_contents = [
                str(message.get("content") or "")
                for message in messages
                if isinstance(message, Mapping) and message.get("role") == "user"
            ]
            assert (
                sum(
                    content.count(DIAGNOSTIC_SYSTEM_PROMPT)
                    for content in system_contents
                )
                == 1
            )
            assert all(
                DIAGNOSTIC_SYSTEM_PROMPT not in content for content in user_contents
            )

    telemetry_path = output_dir / "telemetry.jsonl"
    telemetry = [
        json.loads(line)
        for line in telemetry_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(telemetry) == 2
    assert [
        record["runtime_provenance"]["native_runtime_api"] for record in telemetry
    ] == ["messageService.handleMessage", "useModel"]
    assert all(
        record["runtime_provenance"]["publishable_native"] is False
        and record["runtime_provenance"]["direct_model_bypass"] is False
        and record["runtime_provenance"]["stand_in"] is True
        and record["runtime_provenance"]["release_evidence"] is False
        for record in telemetry
    )

    artifact: dict[str, object] = {
        "diagnostic": "eliza_native_runtime_e2e",
        "publishable": False,
        "nonpublishable_reasons": [
            "loopback fake OpenAI-compatible model",
            "zero-vector stub embedding",
        ],
        "health": health,
        "generic": {
            "response": generic_response.text,
            "metadata": generic_response.metadata,
            "trajectory": generic_trajectory,
        },
        "action_calling": {
            "response": action_response.text,
            "metadata": action_response.metadata,
            "tool_calls": tool_calls,
            "trajectory": action_trajectory,
        },
        "upstream_calls": [call.summary() for call in upstream.calls],
        "telemetry": telemetry,
    }
    (output_dir / "diagnostic.json").write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return artifact


def _default_output_dir() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return (
        Path(__file__).resolve().parent.parent
        / "benchmark_results"
        / "eliza-native-runtime-diagnostic"
        / stamp
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=_default_output_dir())
    args = parser.parse_args()
    artifact = run_diagnostic(args.output_dir.resolve())
    print(
        json.dumps(
            {
                "status": "passed",
                "publishable": artifact["publishable"],
                "output_dir": str(args.output_dir.resolve()),
                "upstream_call_count": len(artifact["upstream_calls"]),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
