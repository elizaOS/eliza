"""Tests the OpenClaw client with subprocess and network boundaries mocked."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from openclaw_adapter.client import (
    MessageResponse,
    OpenClawClient,
    _extract_json_blob,
    _extract_usage_tokens,
    _parse_version_line,
    _response_from_payload,
)


def _fake_completed(
    *,
    stdout: str = "",
    stderr: str = "",
    rc: int = 0,
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["openclaw"],
        returncode=rc,
        stdout=stdout,
        stderr=stderr,
    )


@pytest.fixture
def fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "openclaw"
    binary.write_text("#!/bin/sh\nprintf 'OpenClaw 2026.5.7 (eeef486)\\n'\n")
    binary.chmod(0o755)
    return binary


@pytest.fixture
def client(
    fake_binary: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> OpenClawClient:
    monkeypatch.delenv("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", raising=False)
    return OpenClawClient(
        binary_path=fake_binary,
        repo_path=fake_binary.parent,
        provider="claude-subscription",
        model="claude-opus-4-8",
        api_key="gateway-sentinel",
        base_url="http://127.0.0.1:39999",
        native_state_root=fake_binary.parent / "state",
    )


def _write_native_session(
    env: dict[str, str],
    assistant_messages: list[dict[str, object]],
    *,
    thinking_level: str | None = None,
) -> Path:
    state_dir = Path(env["OPENCLAW_STATE_DIR"])
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
    version: str = "2026.5.7",
    build: str = "eeef486",
    thinking_level: str = "medium",
) -> Path:
    trajectory_path = session_path.with_name("turn.trajectory.jsonl")
    records = [
        {
            "type": "trace.metadata",
            "data": {
                "harness": {
                    "type": "openclaw",
                    "version": version,
                    "gitSha": build,
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
    trajectory_path.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )
    return trajectory_path


def test_message_response_dataclass_shape() -> None:
    r = MessageResponse(text="hi", thought=None, actions=[], params={})
    assert r.text == "hi"
    assert r.thought is None
    assert r.actions == []
    assert r.params == {}


def test_extract_usage_tokens_preserves_zero_and_nested_cache_details() -> None:
    tokens = _extract_usage_tokens(
        {
            "prompt_tokens": 0,
            "completion_tokens": 2,
            "total_tokens": 2,
            "prompt_tokens_details": {
                "cached_tokens": 0,
                "cache_write_tokens": 7,
            },
        }
    )
    assert tokens == {
        "prompt_tokens": 0,
        "completion_tokens": 2,
        "total_tokens": 2,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 7,
    }


def test_client_init_uses_provided_binary(fake_binary: Path) -> None:
    c = OpenClawClient(binary_path=fake_binary)
    assert c.binary_path == fake_binary


def test_client_inherits_campaign_provider_and_model_when_defaults_are_implicit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-opus-4-6")

    client = OpenClawClient()

    assert client.provider == "claude-subscription"
    assert client.model == "claude-opus-4-6"
    assert client.api_key_env == "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN"
    assert client.base_url_env == "CLAUDE_SUBSCRIPTION_GATEWAY_URL"


def test_subscription_auth_ignores_ambient_generic_provider_keys(
    fake_binary: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_API_KEY", "ambient-openclaw-key")
    monkeypatch.setenv("CEREBRAS_API_KEY", "ambient-provider-key")
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-openai-key")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", "gateway-bearer")

    client = OpenClawClient(
        binary_path=fake_binary,
        provider="claude-subscription",
    )
    assert client.api_key == "gateway-bearer"

    with pytest.raises(ValueError, match="does not match"):
        OpenClawClient(
            binary_path=fake_binary,
            provider="claude-subscription",
            api_key="different-explicit-bearer",
        )

    monkeypatch.delenv("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN")
    fail_closed = OpenClawClient(
        binary_path=fake_binary,
        provider="claude-subscription",
    )
    explicit = OpenClawClient(
        binary_path=fake_binary,
        provider="claude-subscription",
        api_key="explicit-gateway-bearer",
    )

    assert fail_closed.api_key == ""
    assert explicit.api_key == "explicit-gateway-bearer"


def test_client_init_default_binary_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """With no override, no manifest, and no ``openclaw`` on PATH, resolution
    lands on the pinned ~/.eliza/agents/openclaw/v2026.5.7/... fallback."""
    monkeypatch.delenv("OPENCLAW_BIN", raising=False)
    monkeypatch.setattr(
        "openclaw_adapter.client.DEFAULT_MANIFEST_PATH",
        tmp_path / "missing.json",
    )
    monkeypatch.setattr("openclaw_adapter.client.shutil.which", lambda _name: None)
    c = OpenClawClient()
    assert c.binary_path.parts[-3:] == ("node_modules", ".bin", "openclaw")


def test_client_init_resolves_openclaw_on_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A global ``openclaw`` on PATH is preferred over the pinned fallback, so
    a plain ``npm i -g openclaw`` install works without an OPENCLAW_BIN export."""
    monkeypatch.delenv("OPENCLAW_BIN", raising=False)
    monkeypatch.setattr(
        "openclaw_adapter.client.DEFAULT_MANIFEST_PATH",
        tmp_path / "missing.json",
    )
    on_path = tmp_path / "bin" / "openclaw"
    monkeypatch.setattr(
        "openclaw_adapter.client.shutil.which",
        lambda name: str(on_path) if name == "openclaw" else None,
    )
    c = OpenClawClient()
    assert c.binary_path == on_path


def test_client_init_reads_manifest(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("OPENCLAW_BIN", raising=False)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({"binary_path": "/custom/path/openclaw"}))
    monkeypatch.setattr(
        "openclaw_adapter.client.DEFAULT_MANIFEST_PATH",
        manifest_path,
    )
    c = OpenClawClient()
    assert c.binary_path == Path("/custom/path/openclaw")


def test_client_init_rejects_malformed_manifest(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("OPENCLAW_BIN", raising=False)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text("{", encoding="utf-8")
    monkeypatch.setattr(
        "openclaw_adapter.client.DEFAULT_MANIFEST_PATH",
        manifest_path,
    )

    with pytest.raises(json.JSONDecodeError):
        OpenClawClient()


def test_client_init_rejects_manifest_without_binary_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("OPENCLAW_BIN", raising=False)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        "openclaw_adapter.client.DEFAULT_MANIFEST_PATH",
        manifest_path,
    )

    with pytest.raises(ValueError, match="binary_path"):
        OpenClawClient()


def test_client_init_honors_openclaw_bin_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENCLAW_BIN", "/override/openclaw")
    c = OpenClawClient()
    assert c.binary_path == Path("/override/openclaw")


def test_client_health_calls_version(
    client: OpenClawClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """health() spawns ``<binary> --version`` and parses the version string."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(
            stdout="OpenClaw 2026.5.7 (eeef486)\n", rc=0
        )
        result = client.health()
    assert result["status"] == "ready"
    assert result["version"] == "2026.5.7"
    assert result["build"] == "eeef486"
    cmd = mock_run.call_args.args[0]
    assert cmd == [str(client.binary_path), "--version"]


def test_client_health_reports_missing_binary(tmp_path: Path) -> None:
    c = OpenClawClient(binary_path=tmp_path / "missing")
    result = c.health()
    assert result["status"] == "error"
    assert "not found" in str(result["error"])


def test_client_health_allows_direct_openai_compatible_without_binary(
    tmp_path: Path,
) -> None:
    c = OpenClawClient(
        binary_path=tmp_path / "missing",
        provider="cerebras",
        model="gpt-oss-120b",
        direct_openai_compatible=True,
    )

    result = c.health()

    assert result["status"] == "ready"
    assert result["transport"] == "direct_openai_compatible"
    assert result["provider"] == "cerebras"
    assert result["model"] == "gpt-oss-120b"


def test_client_health_reports_error_on_nonzero(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stderr="boom", rc=1)
        result = client.health()
    assert result["status"] == "error"
    assert "boom" in str(result["error"])


@pytest.mark.parametrize(
    "stdout",
    [
        "OpenClaw 2026.5.7\n",
        "OpenClaw not-a-version (eeef486)\n",
        "OpenClaw 2026.5.7 (not-a-commit)\n",
        "unexpected version output\n",
    ],
)
def test_client_health_rejects_unattestable_runtime_identity(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
    stdout: str,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=stdout, rc=0)
        result = client.health()

    assert result["status"] == "error"
    assert "version or build" in str(result["error"])


@pytest.mark.skipif(
    sys.platform == "win32",
    reason=(
        "health() spawns the binary; on Windows a fixture file without a "
        ".cmd/.exe extension isn't executable. Production binary resolution "
        "picks .cmd via OPENCLAW_BIN/manifest."
    ),
)
def test_client_is_ready_checks_path(fake_binary: Path, tmp_path: Path) -> None:
    assert (
        OpenClawClient(binary_path=fake_binary, repo_path=fake_binary.parent).is_ready()
        is True
    )
    assert (
        OpenClawClient(binary_path=tmp_path / "absent", repo_path=tmp_path).is_ready()
        is False
    )


def test_client_wait_until_ready_times_out(tmp_path: Path) -> None:
    c = OpenClawClient(binary_path=tmp_path / "missing")
    with pytest.raises(TimeoutError):
        c.wait_until_ready(timeout=0.05, poll=0.01)


def test_client_reset_records_state(client: OpenClawClient) -> None:
    out = client.reset("task-1", "clawbench", extra="ignored")
    assert out == {"task_id": "task-1", "benchmark": "clawbench", "ready": True}


def test_build_argv_includes_model_thinking_message(client: OpenClawClient) -> None:
    argv = client.build_argv("say PONG", None)
    assert argv[0] == str(client.binary_path)
    assert argv[1] == "agent"
    assert "--local" in argv
    assert "--json" in argv
    assert "--model" in argv
    assert argv[argv.index("--model") + 1] == "eliza-benchmark-gateway/claude-opus-4-8"
    assert "--thinking" in argv
    assert argv[argv.index("--thinking") + 1] == "medium"
    assert "--message" in argv
    assert argv[argv.index("--message") + 1] == "say PONG"


def test_build_argv_excludes_system_role_and_tools(client: OpenClawClient) -> None:
    argv = client.build_argv(
        "latest request",
        {
            "messages": [
                {"role": "system", "content": "system rules"},
                {"role": "user", "content": "first request"},
                {"role": "assistant", "content": "first answer"},
                {"role": "user", "content": "latest request"},
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_order",
                        "parameters": {"type": "object"},
                    },
                }
            ],
            "session_id": "loca-session",
        },
    )

    message = argv[argv.index("--message") + 1]
    assert "lookup_order" not in message
    assert "system rules" not in message
    assert "assistant: first answer" in message
    assert "user: latest request" in message


def test_build_argv_appends_current_turn_to_explicit_benchmark_history(
    client: OpenClawClient,
) -> None:
    argv = client.build_argv(
        "Undo cancel and continue.",
        {
            "benchmark_messages": [
                {"role": "user", "content": "Cancel this task."},
                {"role": "assistant", "content": "The task is cancelled."},
            ],
            "system_hint": "Use lifecycle tools when needed.",
        },
    )

    message = argv[argv.index("--message") + 1]
    assert "Use lifecycle tools when needed." not in message
    assert message.count("user: Cancel this task.") == 1
    assert message.count("assistant: The task is cancelled.") == 1
    assert message.count("user: Undo cancel and continue.") == 1


def test_build_argv_maps_prefixed_model_to_gateway_catalog(fake_binary: Path) -> None:
    """The embedded runtime always selects the isolated gateway provider."""
    c = OpenClawClient(binary_path=fake_binary, model="anthropic/claude-3-5-sonnet")
    argv = c.build_argv("hi", None)
    assert (
        argv[argv.index("--model") + 1] == "eliza-benchmark-gateway/claude-3-5-sonnet"
    )


def test_build_argv_passes_session_and_agent(client: OpenClawClient) -> None:
    argv = client.build_argv("hi", {"session_id": "abc-123", "agent_id": "ops"})
    assert "--session-id" in argv
    assert argv[argv.index("--session-id") + 1] == "abc-123"
    assert "--agent" in argv
    assert argv[argv.index("--agent") + 1] == "ops"


def test_build_openai_body_includes_generation_options(fake_binary: Path) -> None:
    c = OpenClawClient(
        binary_path=fake_binary,
        model="gpt-oss-120b",
        temperature=0.2,
        reasoning_effort="low",
        max_tokens=512,
    )
    body = c.build_openai_compatible_body(
        "hi",
        {
            "max_tokens": 256,
            "tool_choice": "none",
            "tools": [{"type": "function", "function": {"name": "LOOKUP"}}],
        },
    )
    assert body["temperature"] == 0.2
    assert body["reasoning_effort"] == "low"
    assert body["max_completion_tokens"] == 256
    assert body["tool_choice"] == "none"
    assert body["tools"] == [{"type": "function", "function": {"name": "LOOKUP"}}]


def test_build_openai_body_drops_non_openai_tool_inventory(fake_binary: Path) -> None:
    c = OpenClawClient(binary_path=fake_binary, direct_openai_compatible=True)
    body = c.build_openai_compatible_body(
        "triage inbox",
        {"tools": ["exec", "slack", "read"], "tool_choice": "auto"},
    )

    assert "tools" not in body
    assert "tool_choice" not in body


def test_build_openai_body_embeds_benchmark_context(fake_binary: Path) -> None:
    c = OpenClawClient(binary_path=fake_binary, direct_openai_compatible=True)
    body = c.build_openai_compatible_body(
        "choose the best option",
        {
            "benchmark": "visualwebbench",
            "task_id": "action_prediction_1",
            "options": ["A page", "B page"],
            "elem_desc": "Search button",
            "bbox": [0.1, 0.2, 0.3, 0.4],
        },
    )

    messages = body["messages"]
    assert isinstance(messages, list)
    assert messages[0]["role"] == "system"
    assert "Benchmark context:" in messages[0]["content"]
    assert "Search button" in messages[0]["content"]
    assert messages[-1] == {"role": "user", "content": "choose the best option"}


def test_build_openai_body_preserves_messages_and_tool_pairs(fake_binary: Path) -> None:
    c = OpenClawClient(binary_path=fake_binary, direct_openai_compatible=True)
    body = c.build_openai_compatible_body(
        "ignored when messages are present",
        {
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "look up order 12"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "function": {
                                "name": "lookup_order",
                                "arguments": '{"order_id":12}',
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "shipped"},
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "lookup_order",
                        "parameters": {"type": "object"},
                    },
                }
            ],
        },
    )

    messages = body["messages"]
    assert isinstance(messages, list)
    assert messages[0] == {"role": "system", "content": "system"}
    assert messages[2]["content"] is None
    assert messages[2]["tool_calls"][0]["function"]["name"] == "lookup_order"
    assert messages[3]["tool_call_id"] == "call_1"


def test_build_openai_body_preserves_multimodal_user_content(fake_binary: Path) -> None:
    c = OpenClawClient(binary_path=fake_binary, direct_openai_compatible=True)
    image_content = [
        {"type": "text", "text": "What text is visible?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abcd"}},
    ]

    body = c.build_openai_compatible_body(
        "ignored when messages are present",
        {"messages": [{"role": "user", "content": image_content}]},
    )

    assert body["messages"] == [{"role": "user", "content": image_content}]


def test_client_session_id_passed(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: context with session_id makes it into the spawned argv."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    response_json = json.dumps({"reply": "PONG"})
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=response_json, rc=0)
        client.send_message("hi", context={"session_id": "abc"})
    argv = mock_run.call_args.args[0]
    assert "--session-id" in argv
    assert argv[argv.index("--session-id") + 1] == "abc"


def test_client_send_message_passes_isolated_gateway_env(
    fake_binary: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The embedded runtime receives isolated state and ephemeral gateway auth."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    client = OpenClawClient(
        binary_path=fake_binary,
        provider="claude-subscription",
        model="claude-opus-4-8",
        api_key="gateway-sentinel",
        base_url="http://127.0.0.1:39999",
        native_state_root=fake_binary.parent / "state",
    )
    captured: dict[str, object] = {}

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        captured["argv"] = argv
        captured["env"] = dict(kwargs.get("env") or {})
        return _fake_completed(stdout=json.dumps({"reply": "ok"}), rc=0)

    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        client.send_message("hi")

    env = captured["env"]
    assert env["CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN"] == "gateway-sentinel"
    assert env["BENCHMARK_HARNESS"] == "openclaw"
    assert Path(env["OPENCLAW_STATE_DIR"]).is_dir()
    assert Path(env["OPENCLAW_CONFIG_PATH"]).is_file()
    assert "gateway-sentinel" not in Path(env["OPENCLAW_CONFIG_PATH"]).read_text()
    argv = captured["argv"]
    assert "--model" in argv
    assert "--thinking" in argv


def test_native_turn_requires_terminal_session_evidence_for_publication(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        if argv[1:] == ["--version"]:
            return _fake_completed(stdout="OpenClaw 2026.5.7 (eeef486)\n")
        env = dict(kwargs.get("env") or {})
        session_path = _write_native_session(
            env,
            [
                {
                    "role": "assistant",
                    "content": [{"type": "toolCall", "name": "TASKS"}],
                    "stopReason": "toolUse",
                    "usage": {
                        "input": 4518,
                        "output": 477,
                        "totalTokens": 4995,
                        "cacheRead": 0,
                        "cacheWrite": 0,
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
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            ],
            thinking_level="medium",
        )
        _write_native_trajectory(
            session_path,
            usage={
                "input": 9510,
                "output": 819,
                "total": 10329,
                "cacheRead": 0,
                "cacheWrite": 0,
            },
        )
        return _fake_completed(
            stdout=json.dumps(
                {
                    "payloads": [{"text": "done"}],
                    "meta": {
                        "agentMeta": {
                            "lastCallUsage": {
                                "promptTokens": 4992,
                                "completionTokens": 342,
                                "totalTokens": 5334,
                            }
                        }
                    },
                }
            ),
            rc=0,
        )

    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        assert client.health()["status"] == "ready"
        response = client.send_message("hi")

    metadata = response.params["_meta"]["openclaw_adapter"]
    assert metadata["publishable_native"] is True
    assert metadata["native_session_evidence"] == "succeeded"
    assert metadata["native_session_terminal_stop_reason"] == "stop"
    assert len(metadata["native_session_sha256"]) == 64
    assert metadata["native_session_assistant_model_call_count"] == 2
    assert metadata["native_trajectory_evidence"] == "succeeded"
    assert metadata["native_runtime_identity_attested"] is True
    assert metadata["thinking_level_attested"] is True
    assert metadata["native_usage_scope"] == "full_native_turn_aggregate"
    assert response.params["usage"] == {
        "prompt_tokens": 9510,
        "completion_tokens": 819,
        "total_tokens": 10329,
        "prompt_tokens_details": {
            "cached_tokens": 0,
            "cache_write_tokens": 0,
        },
    }


def test_native_turn_rejects_zero_exit_when_terminal_session_has_connection_error(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    telemetry_path = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry_path))

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        del argv
        env = dict(kwargs.get("env") or {})
        _write_native_session(
            env,
            [
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "On it; starting a worker."}],
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
        return _fake_completed(
            stdout=json.dumps(
                {
                    "payloads": [
                        {"text": "On it; starting a worker.", "mediaUrl": None},
                        {"text": "Connection error.", "mediaUrl": None},
                    ],
                    "meta": {"durationMs": 25_000},
                }
            ),
            rc=0,
        )

    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        with pytest.raises(RuntimeError, match="Connection error"):
            client.send_message("Implement the login timeout fix.")

    telemetry = json.loads(telemetry_path.read_text(encoding="utf-8").splitlines()[0])
    assert telemetry["error_if_any"].endswith("Connection error.")


def test_native_turn_without_session_evidence_is_explicitly_nonpublishable(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(
            stdout=json.dumps({"payloads": [{"text": "unattested"}]}),
            rc=0,
        )
        response = client.send_message("hi")

    metadata = response.params["_meta"]["openclaw_adapter"]
    assert metadata["publishable_native"] is False
    assert metadata["native_session_evidence"] == "missing"
    assert metadata["native_session_sha256"] is None


def test_native_turn_applies_per_turn_generation_parameters(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    captured_config: dict[str, object] = {}

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        del argv
        env = dict(kwargs.get("env") or {})
        config = json.loads(
            Path(env["OPENCLAW_CONFIG_PATH"]).read_text(encoding="utf-8")
        )
        captured_config.update(config)
        return _fake_completed(stdout=json.dumps({"reply": "ok"}), rc=0)

    tool = {
        "type": "function",
        "function": {
            "name": "lookup",
            "description": "Look up one record.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }
    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        response = client.send_message(
            "find the orchid",
            context={
                "messages": [
                    {"role": "system", "content": "Use the listed tool."},
                    {"role": "user", "content": "find the orchid"},
                ],
                "tools": [tool],
                "tool_choice": "auto",
                "max_tokens": 512,
                "temperature": 0.0,
            },
        )

    assert captured_config["agents"]["list"][0]["params"] == {
        "maxTokens": 512,
        "temperature": 0.0,
    }
    meta = response.params["_meta"]["openclaw_adapter"]
    assert meta["requested_max_tokens"] == 512
    assert meta["requested_temperature"] == 0.0
    assert meta["requested_tool_choice"] == "auto"
    assert meta["tool_choice_native_policy"] == "native_default_auto"
    assert meta["capture_stop_after_scored_action"] is False
    assert len(meta["benchmark_messages_sha256"]) == 64
    assert len(meta["tool_schema_sha256"]) == 64


def test_env_owned_tool_contract_enables_capture_stop(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``capture_stop`` in context generates a terminating bridge plugin and
    is attested in provenance; without tools the flag stays inert."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    plugin_sources: list[str] = []

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        del argv
        env = dict(kwargs.get("env") or {})
        plugin_path = (
            Path(env["OPENCLAW_STATE_DIR"]) / "benchmark-tool-bridge" / "index.mjs"
        )
        plugin_sources.append(
            plugin_path.read_text(encoding="utf-8") if plugin_path.is_file() else ""
        )
        return _fake_completed(stdout=json.dumps({"reply": "ok"}), rc=0)

    tool = {
        "type": "function",
        "function": {
            "name": "lookup",
            "description": "Look up one record.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }
    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        tooled = client.send_message(
            "find the orchid",
            context={"tools": [tool], "capture_stop": True},
        )
        toolless = client.send_message(
            "just reply",
            context={"capture_stop": True},
        )

    tooled_meta = tooled.params["_meta"]["openclaw_adapter"]
    assert tooled_meta["capture_stop_after_scored_action"] is True
    assert 'const captureStop = true;' in plugin_sources[0]
    assert "terminate: true" in plugin_sources[0]
    toolless_meta = toolless.params["_meta"]["openclaw_adapter"]
    assert toolless_meta["capture_stop_after_scored_action"] is False


def test_native_turn_loads_system_prompt_once_through_agents_md(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    captured: dict[str, object] = {}

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        if argv[0] == "git":
            return _fake_completed(stdout="a" * 40 + "\n")
        env = dict(kwargs.get("env") or {})
        state_dir = Path(env["OPENCLAW_STATE_DIR"])
        captured["message"] = argv[argv.index("--message") + 1]
        captured["agents"] = (state_dir / "workspace" / "AGENTS.md").read_text(
            encoding="utf-8"
        )
        return _fake_completed(stdout=json.dumps({"reply": "ok"}), rc=0)

    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        response = client.send_message(
            "find the orchid",
            context={
                "messages": [
                    {"role": "system", "content": "Use the listed tool."},
                    {"role": "user", "content": "find the orchid"},
                ],
                "system_prompt": "Use the listed tool.",
            },
        )

    assert captured["agents"] == "Use the listed tool."
    assert "Use the listed tool." not in str(captured["message"])
    assert str(captured["message"]).count("user: find the orchid") == 1
    meta = response.params["_meta"]["openclaw_adapter"]
    assert meta["native_system_prompt_surface"] == "workspace/AGENTS.md"
    assert meta["native_system_prompt_in_cli_message"] is False
    assert len(meta["native_system_prompt_sha256"]) == 64


def test_native_turn_routes_system_hint_through_agents_md(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    captured: dict[str, object] = {}

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        if argv[0] == "git":
            return _fake_completed(stdout="a" * 40 + "\n")
        env = dict(kwargs.get("env") or {})
        state_dir = Path(env["OPENCLAW_STATE_DIR"])
        captured["message"] = argv[argv.index("--message") + 1]
        captured["agents"] = (state_dir / "workspace" / "AGENTS.md").read_text(
            encoding="utf-8"
        )
        return _fake_completed(stdout=json.dumps({"reply": "ok"}), rc=0)

    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        response = client.send_message(
            "Undo cancel and continue.",
            context={
                "benchmark_messages": [
                    {"role": "user", "content": "Cancel this task."},
                    {"role": "assistant", "content": "Cancelled."},
                ],
                "system_hint": "Use lifecycle tools when needed.",
                "benchmark_workspace_path": str(client.repo_path),
            },
        )

    assert captured["agents"] == "Use lifecycle tools when needed."
    assert "Use lifecycle tools when needed." not in str(captured["message"])
    assert str(client.repo_path) not in str(captured["message"])
    assert str(captured["message"]).count("user: Undo cancel and continue.") == 1
    metadata = response.params["_meta"]["openclaw_adapter"]
    assert metadata["benchmark_workspace_path"] == str(client.repo_path.resolve())
    assert metadata["benchmark_workspace_git_sha"] == "a" * 40
    assert metadata["native_system_prompt_matches_requested"] is True


def test_client_send_message_returns_two_sequential_tasks_calls(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The native capture boundary preserves every tool round in order."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")

    def _fake_run(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        del argv
        env = dict(kwargs.get("env") or {})
        capture_path = Path(env["OPENCLAW_BENCHMARK_CAPTURE_PATH"])
        capture_path.write_text(
            "\n".join(
                json.dumps(record)
                for record in (
                    {
                        "call_id": "call-spawn",
                        "runtime_name": "TASKS",
                        "original_name": "TASKS",
                        "arguments": {
                            "action": "spawn_agent",
                            "task": "fix tests",
                        },
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
        return _fake_completed(stdout=json.dumps({"reply": "done"}), rc=0)

    tool = {
        "type": "function",
        "function": {
            "name": "TASKS",
            "description": "Manage task lifecycle.",
            "parameters": {
                "type": "object",
                "properties": {"action": {"type": "string"}},
                "required": ["action"],
            },
        },
        "x-eliza-benchmark": {
            "mode": "capture_only",
            "result": {"captured": True, "effect": "not_executed"},
        },
    }
    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        result = client.send_message(
            "Start a worker and report its status.",
            context={"tools": [tool], "tool_choice": "auto"},
        )

    assert result.actions == ["TASKS", "TASKS"]
    assert [call["arguments"]["action"] for call in result.params["tool_calls"]] == [
        "spawn_agent",
        "list_agents",
    ]
    assert [entry["result"] for entry in result.params["lifecycle_results"]] == [
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


def test_client_send_message_parses_json(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    payload = json.dumps({"reply": "PONG", "actions": []})
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=payload, rc=0)
        result = client.send_message("hi")
    assert isinstance(result, MessageResponse)
    assert result.text == "PONG"
    assert result.actions == []


def test_client_rejects_non_loopback_native_provider(
    fake_binary: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Publishable native runs cannot silently target a remote provider."""
    monkeypatch.delenv("OPENCLAW_DIRECT_OPENAI_COMPAT", raising=False)
    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)
    c = OpenClawClient(
        binary_path=fake_binary,
        repo_path=fake_binary.parent,
        base_url="https://api.cerebras.ai/v1",
    )
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        with pytest.raises(ValueError, match="loopback completion gateway"):
            c.send_message("hi")
    mock_run.assert_not_called()


def test_client_handles_warnings_before_json(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stdout that begins with config warnings before the JSON blob must parse."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    stdout = (
        "Config warnings:\n"
        "- plugins.entries.eliza-adapter: plugin not found\n"
        '{"reply": "x", "actions": []}\n'
    )
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=stdout, rc=0)
        result = client.send_message("hi")
    assert result.text == "x"


def test_client_send_message_parses_chat_style_payload(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OpenClaw sometimes returns a nested ``message.content`` shape."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    payload = json.dumps(
        {
            "message": {"content": "hello there"},
            "tool_calls": [
                {"id": "c1", "name": "GREET", "arguments": {"who": "world"}}
            ],
        }
    )
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=payload, rc=0)
        result = client.send_message("hi")
    assert result.text == "hello there"
    assert result.actions == ["GREET"]
    assert result.params["GREET"] == {"who": "world"}
    assert isinstance(result.params["tool_calls"], list)


def test_client_send_message_raises_on_nonzero(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(
            stdout="partial",
            stderr="boom: provider auth failed",
            rc=2,
        )
        with pytest.raises(RuntimeError) as excinfo:
            client.send_message("hi")
    msg = str(excinfo.value)
    assert "rc=2" in msg
    assert "boom" in msg
    assert "stdout:" in msg


def test_client_send_message_raises_on_no_json(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout="not json here", rc=0)
        with pytest.raises(RuntimeError, match="no JSON"):
            client.send_message("hi")


def test_client_send_message_raises_on_empty_stdout(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout="", stderr="auth?", rc=0)
        with pytest.raises(RuntimeError, match="no stdout"):
            client.send_message("hi")


def test_client_send_message_propagates_timeout(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = subprocess.TimeoutExpired(
            cmd=["openclaw"], timeout=1.0, output=b"", stderr=b""
        )
        with pytest.raises(RuntimeError, match="timed out"):
            client.send_message("hi")


def test_parse_version_line_extracts_components() -> None:
    v, b = _parse_version_line("OpenClaw 2026.5.7 (eeef486)\n")
    assert v == "2026.5.7"
    assert b == "eeef486"


def test_parse_version_line_handles_no_build() -> None:
    v, b = _parse_version_line("OpenClaw 1.0.0")
    assert v == "1.0.0"
    assert b is None


def test_extract_json_blob_strips_prefix_warnings() -> None:
    out = _extract_json_blob('Warning: x\n{"reply": "ok"}\n', "")
    assert out == {"reply": "ok"}


def test_extract_json_blob_raises_with_context_on_failure() -> None:
    with pytest.raises(RuntimeError) as excinfo:
        _extract_json_blob("not json", "stderr-detail")
    assert "stderr-detail" in str(excinfo.value)


def test_response_from_payload_normalizes_tool_calls() -> None:
    payload = {
        "reply": "ok",
        "tool_calls": [
            {"id": "c1", "function": {"name": "FOO", "arguments": '{"x":1}'}},
            {"name": "BAR", "args": {"y": 2}},
            {"function": {"name": ""}},  # invalid
        ],
    }
    r = _response_from_payload(payload)
    assert r.text == "ok"
    assert r.actions == ["FOO", "BAR"]
    assert r.params["FOO"] == {"x": 1}
    assert r.params["BAR"] == {"y": 2}


def test_response_from_payload_does_not_count_text_embedded_tool_call_by_default() -> (
    None
):
    payload = {
        "reply": 'Need lookup. {"tool": "SEARCH", "args": {"query": "approvals"}}'
    }
    r = _response_from_payload(payload)
    assert r.text == payload["reply"]
    assert r.actions == []
    assert "tool_calls" not in r.params
    assert set(r.params["_meta"]["openclaw_adapter"]) == {
        "transport",
        "path_label",
        "native_openai_tool_calls",
        "preserves_full_messages",
        "passes_benchmark_tools",
        "publishable_native",
    }


def test_response_from_payload_preserves_scalar_arguments() -> None:
    payload = {
        "reply": "ok",
        "tool_calls": [{"id": "c1", "name": "RUN", "arguments": "echo hello"}],
    }
    r = _response_from_payload(payload)
    assert r.params["RUN"] == "echo hello"
    assert r.params["tool_calls"][0]["arguments"] == "echo hello"


def test_response_from_payload_stashes_usage_under_meta() -> None:
    payload = {
        "reply": "ok",
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        "sessionId": "sess-1",
    }
    r = _response_from_payload(payload)
    meta = r.params.get("_meta")
    assert isinstance(meta, dict)
    assert meta["usage"]["prompt_tokens"] == 10
    assert meta["sessionId"] == "sess-1"


def test_response_from_payload_preserves_zero_usage_cache_metadata() -> None:
    payload = {
        "reply": "ok",
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
            "cache_read_input_tokens": 0,
            "prompt_tokens_details": {"cached_tokens": 25, "cache_write_tokens": 7},
        },
    }
    r = _response_from_payload(payload)
    meta = r.params.get("_meta")
    assert isinstance(meta, dict)
    usage = meta["usage"]
    assert usage["prompt_tokens"] == 10
    assert usage["completion_tokens"] == 5
    assert usage["total_tokens"] == 15
    assert usage["prompt_tokens_details"]["cached_tokens"] == 0
    assert usage["prompt_tokens_details"]["cache_write_tokens"] == 7
