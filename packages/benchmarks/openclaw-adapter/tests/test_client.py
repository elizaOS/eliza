"""Unit tests for ``openclaw_adapter.client.OpenClawClient``.

Every subprocess invocation is mocked — no actual OpenClaw spawn, no network.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from openclaw_adapter.client import (
    MessageResponse,
    OpenClawClient,
    _extract_json_blob,
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
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    return binary


@pytest.fixture
def client(fake_binary: Path) -> OpenClawClient:
    return OpenClawClient(binary_path=fake_binary, repo_path=fake_binary.parent, provider="openai")


def test_message_response_dataclass_shape() -> None:
    r = MessageResponse(text="hi", thought=None, actions=[], params={})
    assert r.text == "hi"
    assert r.thought is None
    assert r.actions == []
    assert r.params == {}


def test_client_init_uses_provided_binary(fake_binary: Path) -> None:
    c = OpenClawClient(binary_path=fake_binary)
    assert c.binary_path == fake_binary


def test_client_init_default_binary_falls_back(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """When no override and no manifest, the fallback path under
    ~/.eliza/agents/openclaw/v2026.5.7/... is used."""
    monkeypatch.delenv("OPENCLAW_BIN", raising=False)
    monkeypatch.setattr(
        "openclaw_adapter.client.DEFAULT_MANIFEST_PATH",
        tmp_path / "missing.json",
    )
    c = OpenClawClient()
    assert str(c.binary_path).endswith("node_modules/.bin/openclaw")


def test_client_init_reads_manifest(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("OPENCLAW_BIN", raising=False)
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps({"binary_path": "/custom/path/openclaw"})
    )
    monkeypatch.setattr(
        "openclaw_adapter.client.DEFAULT_MANIFEST_PATH",
        manifest_path,
    )
    c = OpenClawClient()
    assert c.binary_path == Path("/custom/path/openclaw")


def test_client_init_honors_openclaw_bin_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENCLAW_BIN", "/override/openclaw")
    c = OpenClawClient()
    assert c.binary_path == Path("/override/openclaw")


def test_client_health_calls_version(client: OpenClawClient, monkeypatch: pytest.MonkeyPatch) -> None:
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


def test_client_is_ready_checks_path(fake_binary: Path, tmp_path: Path) -> None:
    assert OpenClawClient(binary_path=fake_binary, repo_path=fake_binary.parent).is_ready() is True
    assert OpenClawClient(binary_path=tmp_path / "absent", repo_path=tmp_path).is_ready() is False


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
    assert argv[argv.index("--model") + 1] == "openai/gpt-oss-120b"
    assert "--thinking" in argv
    assert argv[argv.index("--thinking") + 1] == "medium"
    assert "--message" in argv
    assert argv[argv.index("--message") + 1] == "say PONG"


def test_build_argv_does_not_double_prefix_model(fake_binary: Path) -> None:
    """When ``model`` already contains '/', no extra provider prefix is added."""
    c = OpenClawClient(binary_path=fake_binary, model="anthropic/claude-3-5-sonnet")
    argv = c.build_argv("hi", None)
    assert argv[argv.index("--model") + 1] == "anthropic/claude-3-5-sonnet"


def test_build_argv_passes_session_and_agent(client: OpenClawClient) -> None:
    argv = client.build_argv("hi", {"session_id": "abc-123", "agent_id": "ops"})
    assert "--session-id" in argv
    assert argv[argv.index("--session-id") + 1] == "abc-123"
    assert "--agent" in argv
    assert argv[argv.index("--agent") + 1] == "ops"


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


def test_client_send_message_passes_env(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The spawned env must include CEREBRAS_API_KEY mirrored into OPENAI_API_KEY,
    and --model and --thinking present in argv."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    monkeypatch.setenv("CEREBRAS_API_KEY", "sk-test-key")
    monkeypatch.setenv("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1")
    captured: dict[str, object] = {}

    def _fake_run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["argv"] = argv
        captured["env"] = dict(kwargs.get("env") or {})
        return _fake_completed(stdout=json.dumps({"reply": "ok"}), rc=0)

    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        client.send_message("hi")

    env = captured["env"]
    assert env["CEREBRAS_API_KEY"] == "sk-test-key"
    assert env["OPENAI_API_KEY"] == "sk-test-key"
    assert env["OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"
    argv = captured["argv"]
    assert "--model" in argv
    assert "--thinking" in argv


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


def test_client_handles_warnings_before_json(
    client: OpenClawClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stdout that begins with config warnings before the JSON blob must parse."""
    monkeypatch.setenv("OPENCLAW_USE_CLI", "1")
    stdout = (
        'Config warnings:\n'
        '- plugins.entries.eliza-adapter: plugin not found\n'
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
