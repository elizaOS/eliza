"""Unit tests for ``hermes_adapter.client.HermesClient``.

Every subprocess invocation is mocked — no actual venv spawn and no network.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from hermes_adapter.client import HermesClient, MessageResponse, _build_openai_messages


def _fake_completed(
    *,
    stdout: str = "",
    stderr: str = "",
    rc: int = 0,
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["python"],
        returncode=rc,
        stdout=stdout,
        stderr=stderr,
    )


@pytest.fixture
def client_with_fake_venv(tmp_path: Path) -> HermesClient:
    venv_bin = tmp_path / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    venv_python = venv_bin / "python"
    venv_python.write_text("# fake")
    venv_python.chmod(0o755)
    return HermesClient(
        repo_path=tmp_path,
        venv_python=venv_python,
        api_key="test-key",
        base_url="https://test.example/v1",
    )


def test_client_init_resolves_venv_python(tmp_path: Path) -> None:
    client = HermesClient(repo_path=tmp_path)
    assert client.venv_python == tmp_path / ".venv" / "bin" / "python"


def test_client_init_rejects_unknown_mode(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="mode"):
        HermesClient(repo_path=tmp_path, mode="banana")


def test_client_health_validates_venv(client_with_fake_venv: HermesClient) -> None:
    """health() spawns the venv interpreter and reports ready on rc=0."""
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout="ok\n", rc=0)
        result = client_with_fake_venv.health()
    assert result["status"] == "ready"
    assert result.get("stdout") == "ok"
    # Inspect the exact argv used for the health probe.
    call_args = mock_run.call_args
    cmd = call_args.args[0] if call_args.args else call_args.kwargs.get("args") or []
    assert cmd[0] == str(client_with_fake_venv.venv_python)
    assert "-c" in cmd
    assert "import openai" in cmd[cmd.index("-c") + 1]


def test_client_health_reports_error_on_missing_venv(tmp_path: Path) -> None:
    """health() must not raise when the venv interpreter is missing."""
    client = HermesClient(repo_path=tmp_path)
    result = client.health()
    assert result["status"] == "error"
    assert "not found" in str(result["error"])


def test_client_health_reports_error_on_nonzero_exit(
    client_with_fake_venv: HermesClient,
) -> None:
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stderr="boom", rc=1)
        result = client_with_fake_venv.health()
    assert result["status"] == "error"
    assert "exited 1" in str(result["error"])
    assert "boom" in str(result.get("stderr"))


def test_client_send_message_emits_subprocess_command(
    client_with_fake_venv: HermesClient,
) -> None:
    """send_message must spawn the venv python with -u -c <SCRIPT> and pass JSON on stdin."""
    response_json = json.dumps(
        {
            "text": "PONG",
            "thought": None,
            "actions": [],
            "params": {},
        }
    )
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=response_json + "\n", rc=0)
        result = client_with_fake_venv.send_message("say PONG")

    assert isinstance(result, MessageResponse)

    # Exactly one subprocess call.
    assert mock_run.call_count == 1
    call_args = mock_run.call_args
    cmd = call_args.args[0] if call_args.args else call_args.kwargs.get("args") or []
    assert cmd[0] == str(client_with_fake_venv.venv_python)
    assert cmd[1] == "-u"
    assert cmd[2] == "-c"
    # The script must reference openai + handle the stdin JSON payload.
    script = cmd[3]
    assert "from openai import OpenAI" in script
    assert "sys.stdin.read()" in script
    assert "chat.completions.create" in script

    # The JSON payload is passed via stdin.
    stdin_payload = call_args.kwargs.get("input") or ""
    parsed = json.loads(stdin_payload)
    assert parsed["text"] == "say PONG"
    assert parsed["model"] == "gpt-oss-120b"
    assert parsed["base_url"] == "https://test.example/v1"
    assert parsed["api_key"] == "test-key"


def test_client_send_message_parses_stdout_json(
    client_with_fake_venv: HermesClient,
) -> None:
    payload = {
        "text": "the answer is 42",
        "thought": "thinking about it",
        "actions": ["TOOL_FOO"],
        "params": {"tool_calls": [{"name": "TOOL_FOO", "arguments": '{"x": 1}', "id": "c1"}]},
    }
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=json.dumps(payload) + "\n", rc=0)
        result = client_with_fake_venv.send_message("hello")
    assert result.text == "the answer is 42"
    assert result.thought == "thinking about it"
    assert result.actions == ["TOOL_FOO"]
    assert result.params["tool_calls"][0]["name"] == "TOOL_FOO"


def test_client_parse_response_normalizes_openai_tool_calls(
    client_with_fake_venv: HermesClient,
) -> None:
    payload = {
        "text": "",
        "thought": None,
        "actions": [],
        "params": {
            "tool_calls": [
                {
                    "id": "call_native",
                    "type": "function",
                    "function": {
                        "name": "LOOKUP",
                        "arguments": '{"query":"orchid"}',
                    },
                }
            ]
        },
    }
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=json.dumps(payload) + "\n", rc=0)
        result = client_with_fake_venv.send_message("hello")

    assert result.params["tool_calls"] == [
        {"id": "call_native", "name": "LOOKUP", "arguments": '{"query":"orchid"}'}
    ]


def test_client_send_message_handles_multiline_stdout(
    client_with_fake_venv: HermesClient,
) -> None:
    """Prefix log noise must not break JSON parsing — we read the last line."""
    response = json.dumps({"text": "ok", "thought": None, "actions": [], "params": {}})
    stdout = "INFO: loading config\nWARN: cache miss\n" + response + "\n"
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout=stdout, rc=0)
        result = client_with_fake_venv.send_message("hi")
    assert result.text == "ok"


def test_client_send_message_raises_on_subprocess_failure(
    client_with_fake_venv: HermesClient,
) -> None:
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(
            stderr="ImportError: no module openai",
            rc=1,
        )
        with pytest.raises(RuntimeError, match="rc=1"):
            client_with_fake_venv.send_message("hi")


def test_client_reset_records_state(client_with_fake_venv: HermesClient) -> None:
    out = client_with_fake_venv.reset("task-1", "tblite")
    assert out["task_id"] == "task-1"
    # The recorded values flow into the next subprocess payload.
    payload = client_with_fake_venv.build_send_message_payload("hi", None)
    assert payload["task_id"] == "task-1"
    assert payload["benchmark"] == "tblite"


def test_client_send_message_passes_tools_in_payload(
    client_with_fake_venv: HermesClient,
) -> None:
    payload = client_with_fake_venv.build_send_message_payload(
        "do thing",
        {"tools": [{"type": "function", "function": {"name": "FOO"}}]},
    )
    assert payload["tools"][0]["function"]["name"] == "FOO"


def test_client_send_message_passes_system_prompt(
    client_with_fake_venv: HermesClient,
) -> None:
    payload = client_with_fake_venv.build_send_message_payload(
        "do thing",
        {"system_prompt": "You are a teapot."},
    )
    assert payload["system_prompt"] == "You are a teapot."


def test_client_send_message_payload_includes_generation_options(tmp_path: Path) -> None:
    client = HermesClient(
        repo_path=tmp_path,
        api_key="test-key",
        base_url="https://test.example/v1",
        mode="in_process",
        temperature=0.1,
        reasoning_effort="medium",
        max_tokens=2048,
    )

    payload = client.build_send_message_payload("hi", {"max_tokens": 1024})

    assert payload["temperature"] == 0.1
    assert payload["reasoning_effort"] == "medium"
    assert payload["max_tokens"] == 1024


def test_client_provider_specific_env_defaults(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "sk-cerebras")
    monkeypatch.setenv("CEREBRAS_BASE_URL", "https://cerebras.example/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://openai.example/v1")

    openai_client = HermesClient(repo_path=tmp_path, provider="openai")
    cerebras_client = HermesClient(repo_path=tmp_path, provider="cerebras")

    assert openai_client.api_key == "sk-openai"
    assert openai_client.base_url == "https://openai.example/v1"
    assert cerebras_client.api_key == "sk-cerebras"
    assert cerebras_client.base_url == "https://cerebras.example/v1"


def test_build_openai_messages_preserves_system_prompt_with_history() -> None:
    messages = _build_openai_messages(
        raw_messages=[{"role": "user", "content": "last turn"}],
        system_prompt="Benchmark instructions",
        fallback_user_text="fallback",
    )

    assert messages[0] == {"role": "system", "content": "Benchmark instructions"}
    assert messages[1] == {"role": "user", "content": "last turn"}


def test_build_openai_messages_does_not_duplicate_identical_system_prompt() -> None:
    messages = _build_openai_messages(
        raw_messages=[
            {"role": "system", "content": "Benchmark instructions"},
            {"role": "user", "content": "last turn"},
        ],
        system_prompt="Benchmark instructions",
        fallback_user_text="fallback",
    )

    assert [
        msg for msg in messages if msg.get("role") == "system"
    ] == [{"role": "system", "content": "Benchmark instructions"}]


def test_client_is_ready_returns_bool(client_with_fake_venv: HermesClient) -> None:
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout="ok", rc=0)
        assert client_with_fake_venv.is_ready() is True


def test_client_wait_until_ready_times_out(tmp_path: Path) -> None:
    client = HermesClient(repo_path=tmp_path)  # venv python does not exist
    with pytest.raises(TimeoutError):
        client.wait_until_ready(timeout=0.05, poll=0.01)


def test_message_response_dataclass_shape() -> None:
    """Ensure the public dataclass matches the eliza-adapter contract."""
    r = MessageResponse(text="hi", thought=None, actions=[], params={})
    assert r.text == "hi"
    assert r.thought is None
    assert r.actions == []
    assert r.params == {}


def test_client_send_message_passes_env(client_with_fake_venv: HermesClient) -> None:
    """The subprocess env must include OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
    and TERMINAL_ENV=local — even when the parent shell has no such vars set."""
    captured_env: dict[str, str] = {}

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured_env.update(kwargs.get("env") or {})
        return _fake_completed(
            stdout=json.dumps({"text": "ok", "thought": None, "actions": [], "params": {}}) + "\n",
            rc=0,
        )

    with patch("hermes_adapter.client.subprocess.run", side_effect=_fake_run):
        client_with_fake_venv.send_message("hi")

    assert captured_env["OPENAI_API_KEY"] == "test-key"
    assert captured_env["OPENAI_BASE_URL"] == "https://test.example/v1"
    assert captured_env["OPENAI_MODEL"] == "gpt-oss-120b"
    assert captured_env["TERMINAL_ENV"] == "local"


def test_client_health_runs_import_check(client_with_fake_venv: HermesClient) -> None:
    """health() verifies the one-shot OpenAI-compatible path used by smokes."""
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(stdout="ok\n", rc=0)
        client_with_fake_venv.health()
    cmd = mock_run.call_args.args[0]
    script = cmd[cmd.index("-c") + 1]
    assert "import openai" in script
