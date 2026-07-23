"""Validates the isolated OpenClaw config, tool bridge, and provenance boundary."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import pytest

from openclaw_adapter.native_runtime import (
    benchmark_runtime_env,
    inspect_native_session,
    normalize_benchmark_tools,
    prepare_native_runtime,
    read_captured_tool_calls,
    read_captured_tool_executions,
)


def _write_native_session(
    state_dir: Path,
    assistant_messages: list[dict[str, object]],
    *,
    thinking_level: str | None = None,
) -> Path:
    session_path = state_dir / "agents" / "benchmark" / "sessions" / "turn.jsonl"
    session_path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {"type": "session", "version": 3, "id": "turn"},
        *(
            [{"type": "thinking_level_change", "thinkingLevel": thinking_level}]
            if thinking_level is not None
            else []
        ),
        {
            "type": "message",
            "message": {"role": "user", "content": [{"type": "text", "text": "go"}]},
        },
        *({"type": "message", "message": message} for message in assistant_messages),
    ]
    session_path.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )
    return session_path


def _write_native_trajectory(
    session_path: Path,
    *,
    usage: dict[str, int],
    version: str = "2026.6.11",
    git_sha: str = "e085fa1",
    thinking_level: str = "medium",
) -> Path:
    path = session_path.with_name("turn.trajectory.jsonl")
    records = [
        {
            "type": "trace.metadata",
            "data": {
                "harness": {
                    "type": "openclaw",
                    "version": version,
                    "gitSha": git_sha,
                },
                "model": {
                    "thinkLevel": thinking_level,
                    "reasoningLevel": "off",
                },
            },
        },
        {"type": "model.completed", "data": {"usage": usage}},
        {
            "type": "session.ended",
            "data": {"status": "success", "aborted": False, "timedOut": False},
        },
    ]
    path.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )
    return path


def _tool(name: str = "record_probe") -> dict[str, object]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": "Record a probe value.",
            "parameters": {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
            },
        },
    }


def _lifecycle_tool() -> dict[str, object]:
    contract_path = (
        Path(__file__).resolve().parents[2]
        / "orchestrator_lifecycle"
        / "tasks-tool.json"
    )
    payload = json.loads(contract_path.read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def test_normalize_tools_preserves_safe_names_and_aliases_unsafe_names() -> None:
    tools = normalize_benchmark_tools([_tool(), _tool("calendar.lookup event")])

    assert tools[0].runtime_name == "record_probe"
    assert tools[0].original_name == "record_probe"
    assert tools[1].runtime_name != tools[1].original_name
    assert tools[1].runtime_name.startswith("calendar_lookup_event")
    assert "Original benchmark function name" in tools[1].description


def test_normalize_tools_rejects_non_function_schema() -> None:
    with pytest.raises(TypeError, match="not a function tool"):
        normalize_benchmark_tools([{"type": "command", "name": "run"}])


def test_prepare_runtime_is_key_free_and_forces_embedded_runtime(
    tmp_path: Path,
) -> None:
    paths = prepare_native_runtime(
        tools=normalize_benchmark_tools([_tool()]),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337",
        timeout_s=45,
        max_tokens=2048,
        temperature=0.25,
        system_prompt="Use the exact benchmark tool contract.",
        state_dir=tmp_path,
    )

    raw_config = paths.config_path.read_text(encoding="utf-8")
    config = json.loads(raw_config)
    assert "gateway-secret" not in raw_config
    assert (
        config["models"]["providers"]["eliza-benchmark-gateway"]["apiKey"]
        == "${CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN}"
    )
    assert (
        config["agents"]["defaults"]["models"][
            "eliza-benchmark-gateway/claude-opus-4-8"
        ]["agentRuntime"]["id"]
        == "openclaw"
    )
    assert config["agents"]["list"][0]["tools"]["allow"] == ["record_probe"]
    assert config["agents"]["list"][0]["params"] == {
        "maxTokens": 2048,
        "temperature": 0.25,
    }
    assert config["agents"]["defaults"]["contextInjection"] == "always"
    assert config["agents"]["defaults"]["thinkingDefault"] == "medium"
    assert config["agents"]["list"][0]["contextInjection"] == "always"
    assert (
        config["models"]["providers"]["eliza-benchmark-gateway"]["models"][0]["compat"][
            "supportsReasoningEffort"
        ]
        is True
    )
    assert paths.config_sha256
    assert paths.agents_path == paths.workspace_dir / "AGENTS.md"
    assert (
        paths.agents_path.read_text(encoding="utf-8")
        == "Use the exact benchmark tool contract."
    )
    assert paths.system_prompt_sha256 == (
        "d69a41188dfc1fd9b7f3fea223ad567f7272cc6e3ac28ebc521ea28491580069"
    )
    assert (paths.plugin_dir / "openclaw.plugin.json").is_file()


def test_generated_plugin_returns_shared_capture_only_result_in_sequence(
    tmp_path: Path,
) -> None:
    contract = _lifecycle_tool()
    tools = normalize_benchmark_tools([contract])
    assert tools[0].description == contract["function"]["description"]
    assert tools[0].parameters == contract["function"]["parameters"]
    paths = prepare_native_runtime(
        tools=tools,
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337",
        timeout_s=45,
        max_tokens=2048,
        state_dir=tmp_path,
    )
    plugin_path = paths.plugin_dir / "index.mjs"
    script = f"""
import {{ pathToFileURL }} from "node:url";
const plugin = (await import(pathToFileURL({json.dumps(str(plugin_path))}).href)).default;
const registrations = [];
plugin.register({{ registerTool(tool) {{ registrations.push(tool); }} }});
const first = await registrations[0].execute("call-1", {{ action: "spawn_agent", task: "fix tests" }});
const second = await registrations[0].execute("call-2", {{ action: "list_agents" }});
process.stdout.write(JSON.stringify([first, second]));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        check=True,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "OPENCLAW_BENCHMARK_CAPTURE_PATH": str(paths.capture_path),
        },
    )

    results = json.loads(completed.stdout)
    assert [json.loads(result["content"][0]["text"]) for result in results] == [
        {
            "captured": True,
            "effect": "not_executed",
            "sequence": 0,
            "tool": "TASKS",
        },
        {
            "captured": True,
            "effect": "not_executed",
            "sequence": 1,
            "tool": "TASKS",
        },
    ]
    assert [
        call["arguments"]["action"]
        for call in read_captured_tool_calls(paths.capture_path)
    ] == [
        "spawn_agent",
        "list_agents",
    ]


def test_prepare_runtime_rejects_remote_completion_provider(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="loopback completion gateway"):
        prepare_native_runtime(
            tools=(),
            model="claude-opus-4-8",
            base_url="https://api.example.com",
            timeout_s=30,
            max_tokens=None,
            state_dir=tmp_path,
        )


def test_runtime_env_keeps_gateway_token_out_of_config(tmp_path: Path) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://localhost:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )

    env = benchmark_runtime_env(
        paths=paths,
        gateway_token="gateway-secret",
        parent={"PATH": "/usr/bin"},
    )

    assert env["CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN"] == "gateway-secret"
    assert env["OPENCLAW_STATE_DIR"] == str(tmp_path)
    assert "gateway-secret" not in paths.config_path.read_text(encoding="utf-8")


def test_native_session_evidence_is_missing_until_openclaw_writes_transcript(
    tmp_path: Path,
) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )

    evidence = inspect_native_session(paths)

    assert evidence.status == "missing"
    assert evidence.session_sha256 is None
    assert evidence.terminal_stop_reason is None


def test_native_session_evidence_attests_terminal_success(tmp_path: Path) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )
    _write_native_session(
        tmp_path,
        [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "stopReason": "stop",
            }
        ],
    )

    evidence = inspect_native_session(paths)

    assert evidence.status == "succeeded"
    assert evidence.terminal_stop_reason == "stop"
    assert isinstance(evidence.session_sha256, str)
    assert len(evidence.session_sha256) == 64


def test_native_session_evidence_aggregates_every_model_call_and_trajectory(
    tmp_path: Path,
) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        thinking_level="medium",
        state_dir=tmp_path,
    )
    session_path = _write_native_session(
        tmp_path,
        [
            {
                "role": "assistant",
                "content": [{"type": "toolCall", "name": "TASKS"}],
                "stopReason": "toolUse",
                "usage": {
                    "input": 4518,
                    "output": 477,
                    "totalTokens": 4995,
                    "cacheRead": 10,
                    "cacheWrite": 2,
                },
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "stopReason": "stop",
                "usage": {
                    "input": 4992,
                    "output": 342,
                    "totalTokens": 5334,
                    "cacheRead": 20,
                    "cacheWrite": 3,
                },
            },
        ],
        thinking_level="medium",
    )
    trajectory_path = _write_native_trajectory(
        session_path,
        usage={
            "input": 9510,
            "output": 819,
            "total": 10329,
            "cacheRead": 30,
            "cacheWrite": 5,
        },
    )

    evidence = inspect_native_session(
        paths,
        expected_thinking_level="medium",
        expected_runtime_version="2026.6.11",
        expected_runtime_git_sha="e085fa1",
    )

    assert evidence.status == "succeeded"
    assert evidence.assistant_model_call_count == 2
    assert evidence.effective_thinking_level == "medium"
    assert evidence.usage == {
        "prompt_tokens": 9510,
        "completion_tokens": 819,
        "total_tokens": 10329,
        "prompt_tokens_details": {
            "cached_tokens": 30,
            "cache_write_tokens": 5,
        },
    }
    assert evidence.trajectory_status == "succeeded"
    assert evidence.trajectory_sha256
    assert evidence.trajectory_sha256 != evidence.session_sha256
    assert trajectory_path.is_file()


def test_native_session_evidence_rejects_trajectory_identity_drift(
    tmp_path: Path,
) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )
    session_path = _write_native_session(
        tmp_path,
        [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "stopReason": "stop",
                "usage": {
                    "input": 10,
                    "output": 2,
                    "totalTokens": 12,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                },
            }
        ],
        thinking_level="medium",
    )
    _write_native_trajectory(
        session_path,
        usage={
            "input": 10,
            "output": 2,
            "total": 12,
            "cacheRead": 0,
            "cacheWrite": 0,
        },
        git_sha="wrongsha",
    )

    with pytest.raises(RuntimeError, match="commit does not match CLI health"):
        inspect_native_session(
            paths,
            expected_thinking_level="medium",
            expected_runtime_version="2026.6.11",
            expected_runtime_git_sha="e085fa1",
        )


def test_native_session_evidence_rejects_terminal_connection_error(
    tmp_path: Path,
) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )
    _write_native_session(
        tmp_path,
        [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "On it"}],
                "stopReason": "toolUse",
            },
            {
                "role": "assistant",
                "content": [],
                "stopReason": "error",
                "errorMessage": "Connection error.",
            },
        ],
    )

    with pytest.raises(RuntimeError, match="Connection error"):
        inspect_native_session(paths)


def test_native_session_evidence_allows_recovery_after_intermediate_error(
    tmp_path: Path,
) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )
    _write_native_session(
        tmp_path,
        [
            {
                "role": "assistant",
                "content": [],
                "stopReason": "error",
                "errorMessage": "transient provider error",
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "recovered"}],
                "stopReason": "stop",
            },
        ],
    )

    evidence = inspect_native_session(paths)

    assert evidence.status == "succeeded"
    assert evidence.terminal_stop_reason == "stop"


@pytest.mark.parametrize("stop_reason", [None, "unknown-terminal-state"])
def test_native_session_evidence_rejects_unknown_terminal_reason(
    tmp_path: Path,
    stop_reason: str | None,
) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )
    assistant: dict[str, object] = {
        "role": "assistant",
        "content": [{"type": "text", "text": "done"}],
    }
    if stop_reason is not None:
        assistant["stopReason"] = stop_reason
    _write_native_session(tmp_path, [assistant])

    with pytest.raises(RuntimeError, match="unknown assistant stop reason"):
        inspect_native_session(paths)


def test_native_session_evidence_rejects_malformed_error_message(
    tmp_path: Path,
) -> None:
    paths = prepare_native_runtime(
        tools=(),
        model="claude-opus-4-8",
        base_url="http://127.0.0.1:31337/v1",
        timeout_s=30,
        max_tokens=None,
        state_dir=tmp_path,
    )
    _write_native_session(
        tmp_path,
        [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "stopReason": "stop",
                "errorMessage": {"unexpected": "shape"},
            }
        ],
    )

    with pytest.raises(RuntimeError, match="malformed assistant errorMessage"):
        inspect_native_session(paths)


def test_capture_reader_restores_original_tool_name(tmp_path: Path) -> None:
    capture = tmp_path / "tool-calls.jsonl"
    capture.write_text(
        json.dumps(
            {
                "call_id": "call-native",
                "runtime_name": "calendar_lookup_event_1_deadbeef",
                "original_name": "calendar.lookup event",
                "arguments": {"value": "sentinel"},
                "result": {
                    "captured": True,
                    "sequence": 0,
                    "tool": "calendar.lookup event",
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    assert read_captured_tool_calls(capture) == [
        {
            "id": "call-native",
            "name": "calendar.lookup event",
            "arguments": {"value": "sentinel"},
        }
    ]


def test_capture_reader_preserves_sequential_tasks_calls(tmp_path: Path) -> None:
    capture = tmp_path / "tool-calls.jsonl"
    capture.write_text(
        "\n".join(
            json.dumps(record)
            for record in (
                {
                    "call_id": "call-spawn",
                    "runtime_name": "TASKS",
                    "original_name": "TASKS",
                    "arguments": {"action": "spawn_agent", "task": "fix tests"},
                    "result": {
                        "captured": True,
                        "effect": "not_executed",
                        "sequence": 0,
                        "tool": "TASKS",
                    },
                },
                {
                    "call_id": "call-status",
                    "runtime_name": "TASKS",
                    "original_name": "TASKS",
                    "arguments": {"action": "list_agents"},
                    "result": {
                        "captured": True,
                        "effect": "not_executed",
                        "sequence": 1,
                        "tool": "TASKS",
                    },
                },
            )
        )
        + "\n",
        encoding="utf-8",
    )

    calls = read_captured_tool_calls(capture)

    assert [call["id"] for call in calls] == ["call-spawn", "call-status"]
    assert [call["arguments"]["action"] for call in calls] == [
        "spawn_agent",
        "list_agents",
    ]
    assert [
        execution["result"] for execution in read_captured_tool_executions(capture)
    ] == [
        {
            "captured": True,
            "effect": "not_executed",
            "sequence": 0,
            "tool": "TASKS",
        },
        {
            "captured": True,
            "effect": "not_executed",
            "sequence": 1,
            "tool": "TASKS",
        },
    ]


def test_capture_reader_fails_closed_on_corruption(tmp_path: Path) -> None:
    capture = tmp_path / "tool-calls.jsonl"
    capture.write_text("not-json\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="invalid JSON"):
        read_captured_tool_calls(capture)


def test_capture_reader_rejects_missing_handler_result(tmp_path: Path) -> None:
    capture = tmp_path / "tool-calls.jsonl"
    capture.write_text(
        json.dumps(
            {
                "call_id": "call-native",
                "runtime_name": "TASKS",
                "original_name": "TASKS",
                "arguments": {"action": "spawn_agent"},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="invalid handler result"):
        read_captured_tool_executions(capture)
