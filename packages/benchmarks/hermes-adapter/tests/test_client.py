"""Unit tests for ``hermes_adapter.client.HermesClient``.

Every subprocess invocation is mocked — no actual venv spawn and no network.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from hermes_adapter.client import (
    HermesClient,
    MessageResponse,
    _assistant_text_and_thought,
    _build_openai_messages,
)
from hermes_adapter.native_runtime import (
    NATIVE_RUNTIME_API,
    NATIVE_RUNTIME_CLASS,
    NATIVE_TRANSPORT,
    PLUGIN_API,
    PLUGIN_ID,
    PLUGIN_TOOLSET,
)


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


def _fake_native_run(
    response: dict[str, object] | None = None,
    *,
    prefix: str = "",
    extra_meta: dict[str, object] | None = None,
):
    """Build a subprocess fake that derives provenance from the stdin bridge."""

    def _run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        payload = json.loads(str(kwargs.get("input") or "{}"))
        bridge = payload["bridge"]
        provenance = {
            "agent_runtime": "hermes",
            "native_runtime_class": NATIVE_RUNTIME_CLASS,
            "native_runtime_api": NATIVE_RUNTIME_API,
            "native_runtime_module_file": str(
                Path(payload["repo_path"]) / "run_agent.py"
            ),
            "native_agent_instantiated": True,
            "tool_bridge_plugin": PLUGIN_ID,
            "tool_bridge_api": PLUGIN_API,
            "tool_bridge_toolset": PLUGIN_TOOLSET,
            "tool_bridge_digest": bridge["digest"],
            "tool_bridge_loaded_tools": bridge["tool_names"],
            "benchmark_workspace_path": payload["workspace_path"],
            "native_process_cwd": payload["workspace_path"],
            "transport": NATIVE_TRANSPORT,
            "hermes_home_isolated": True,
            "legacy_raw_openai_bypass": False,
            "publishable_native": True,
        }
        if "--health" in cmd:
            output: dict[str, object] = {
                "status": "ready",
                **provenance,
                "tool_bridge_captured_calls": 0,
            }
        else:
            output = dict(
                response or {"text": "ok", "thought": None, "actions": [], "params": {}}
            )
            params = dict(output.get("params") or {})
            tool_calls = params.get("tool_calls")
            captured = len(tool_calls) if isinstance(tool_calls, list) else 0
            params["_meta"] = {
                **provenance,
                "tool_bridge_captured_calls": captured,
                **(extra_meta or {}),
            }
            output["params"] = params
        return _fake_completed(
            stdout=prefix + json.dumps(output, ensure_ascii=True) + "\n",
            rc=0,
        )

    return _run


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
        base_url="http://127.0.0.1:8765/v1",
    )


def test_client_init_resolves_venv_python(tmp_path: Path) -> None:
    client = HermesClient(repo_path=tmp_path)
    assert client.venv_python == tmp_path / ".venv" / "bin" / "python"


def test_native_turn_uses_benchmark_workspace_not_hermes_source(
    tmp_path: Path,
) -> None:
    source_checkout = tmp_path / "hermes-source"
    venv_python = source_checkout / ".venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("# fake")
    workspace = tmp_path / "benchmark-workspace"
    workspace.mkdir()
    client = HermesClient(
        repo_path=source_checkout,
        venv_python=venv_python,
        workspace_path=workspace,
        api_key="test-key",
        base_url="http://127.0.0.1:8765/v1",
    )
    native_run = _fake_native_run()

    def checked_run(
        cmd: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        assert kwargs["cwd"] == str(workspace.resolve())
        env = kwargs["env"]
        assert isinstance(env, dict)
        assert env["TERMINAL_CWD"] == str(workspace.resolve())
        payload = json.loads(str(kwargs["input"]))
        assert payload["workspace_path"] == str(workspace.resolve())
        assert payload["repo_path"] == str(source_checkout.resolve())
        assert str(workspace.resolve()) not in str(payload["system_prompt"])
        return native_run(cmd, **kwargs)

    with patch("hermes_adapter.client.subprocess.run", side_effect=checked_run):
        response = client.send_message(
            "inspect the current workspace",
            context={
                "system_hint": "Inspect the benchmark repository.",
                "benchmark_workspace_path": str(workspace.resolve()),
            },
        )

    meta = response.params["_meta"]
    assert meta["benchmark_workspace_path"] == str(workspace.resolve())
    assert meta["native_process_cwd"] == str(workspace.resolve())


def test_client_rejects_missing_benchmark_workspace(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="workspace is not a directory"):
        HermesClient(
            repo_path=tmp_path,
            workspace_path=tmp_path / "missing-workspace",
        )


def test_client_init_rejects_unknown_mode(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="mode"):
        HermesClient(repo_path=tmp_path, mode="banana")


def test_client_init_resolves_shared_campaign_mode_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HERMES_MODE", "subprocess")
    monkeypatch.setenv("HERMES_ADAPTER_MODE", "subprocess")

    client = HermesClient(repo_path=tmp_path)

    assert client.mode == "subprocess"


def test_client_init_rejects_conflicting_campaign_mode_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HERMES_MODE", "subprocess")
    monkeypatch.setenv("HERMES_ADAPTER_MODE", "in_process")

    with pytest.raises(ValueError, match="disagree"):
        HermesClient(repo_path=tmp_path)


def test_subscription_campaign_overrides_cli_provider_alias_and_uses_gateway(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-opus-4-6")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", "lane-token")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_GATEWAY_URL", "http://127.0.0.1:43123")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.setenv("HERMES_MODE", "subprocess")
    monkeypatch.setenv("HERMES_ADAPTER_MODE", "subprocess")

    client = HermesClient(
        repo_path=tmp_path,
        provider="openai",
        model=None,
    )

    assert client.provider == "claude-subscription"
    assert client.model == "claude-opus-4-6"
    assert client.api_key == "lane-token"
    assert client.base_url == "http://127.0.0.1:43123/v1"
    assert client.mode == "subprocess"

    with pytest.raises(ValueError, match="does not match"):
        HermesClient(
            repo_path=tmp_path,
            provider="openai",
            api_key="different-explicit-bearer",
        )


def test_subscription_auth_ignores_ambient_generic_openai_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:49999/v1")
    monkeypatch.delenv("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", raising=False)
    monkeypatch.delenv("CLAUDE_SUBSCRIPTION_GATEWAY_URL", raising=False)
    monkeypatch.setenv("HERMES_MODE", "subprocess")
    monkeypatch.setenv("HERMES_ADAPTER_MODE", "subprocess")

    fail_closed = HermesClient(repo_path=tmp_path, provider="openai")
    explicit = HermesClient(
        repo_path=tmp_path,
        provider="openai",
        api_key="explicit-gateway-bearer",
        base_url="http://127.0.0.1:43123/v1",
    )

    assert fail_closed.api_key == ""
    assert fail_closed.base_url == ""
    assert explicit.api_key == "explicit-gateway-bearer"
    assert explicit.base_url == "http://127.0.0.1:43123/v1"


def test_subscription_campaign_normalizes_explicit_gateway_origin(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-sonnet-4-6")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", "lane-token")

    client = HermesClient(
        repo_path=tmp_path,
        provider="openai",
        model=None,
        base_url="http://127.0.0.1:43123",
    )

    assert client.provider == "claude-subscription"
    assert client.model == "claude-sonnet-4-6"
    assert client.base_url == "http://127.0.0.1:43123/v1"
    assert client.build_send_message_payload("hello", None)["base_url"] == (
        "http://127.0.0.1:43123/v1"
    )


def test_subscription_campaign_has_no_remote_provider_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.delenv("CLAUDE_SUBSCRIPTION_GATEWAY_URL", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)

    client = HermesClient(repo_path=tmp_path, provider="openai")
    payload = client.build_send_message_payload("hello", None)

    assert client.base_url == ""
    assert payload["request_publishable_native"] is False
    assert payload["nonpublishable_reason"] == "gateway base URL is not loopback"


@pytest.mark.parametrize(
    "base_url",
    (
        "http://127.0.0.1:43123/proxy",
        "http://127.0.0.1:43123/v1?lane=hermes",
    ),
)
def test_subscription_campaign_rejects_noncanonical_loopback_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    base_url: str,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")

    with pytest.raises(ValueError, match="origin or its /v1"):
        HermesClient(repo_path=tmp_path, provider="openai", base_url=base_url)


def test_subscription_campaign_rejects_legacy_in_process_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")

    with pytest.raises(ValueError, match="require mode='subprocess'"):
        HermesClient(repo_path=tmp_path, mode="in_process")


def test_client_health_validates_venv(client_with_fake_venv: HermesClient) -> None:
    """health() requires native AIAgent and scoped-plugin provenance."""
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run()
        result = client_with_fake_venv.health()
    assert result["status"] == "ready"
    assert result["native_runtime_class"] == "run_agent.AIAgent"
    assert result["publishable_native"] is True
    # Inspect the exact argv used for the health probe.
    call_args = mock_run.call_args
    cmd = call_args.args[0] if call_args.args else call_args.kwargs.get("args") or []
    assert cmd[0] == str(client_with_fake_venv.venv_python)
    assert cmd[1] == "-u"
    assert cmd[2].endswith("native_runtime.py")
    assert cmd[3] == "--health"


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


def test_client_send_message_emits_native_subprocess_command(
    client_with_fake_venv: HermesClient,
) -> None:
    """send_message must execute the native runner and pass isolated metadata."""
    response = {"text": "PONG", "thought": None, "actions": [], "params": {}}
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run(response)
        result = client_with_fake_venv.send_message("say PONG")

    assert isinstance(result, MessageResponse)

    # Exactly one subprocess call.
    assert mock_run.call_count == 1
    call_args = mock_run.call_args
    cmd = call_args.args[0] if call_args.args else call_args.kwargs.get("args") or []
    assert cmd[0] == str(client_with_fake_venv.venv_python)
    assert cmd[1] == "-u"
    assert cmd[2].endswith("native_runtime.py")
    assert "-c" not in cmd

    # The JSON payload is passed via stdin.
    stdin_payload = call_args.kwargs.get("input") or ""
    parsed = json.loads(stdin_payload)
    assert parsed["text"] == "say PONG"
    assert parsed["model"] == "gemma-4-31b"
    assert parsed["base_url"] == "http://127.0.0.1:8765/v1"
    assert parsed["api_key"] == "test-key"
    assert parsed["hermes_home"] == str(client_with_fake_venv.hermes_home)
    assert parsed["bridge"]["plugin_id"] == PLUGIN_ID


def test_client_send_message_parses_stdout_json(
    client_with_fake_venv: HermesClient,
) -> None:
    payload = {
        "text": "the answer is 42",
        "thought": "thinking about it",
        "actions": ["TOOL_FOO"],
        "params": {
            "tool_calls": [{"name": "TOOL_FOO", "arguments": '{"x": 1}', "id": "c1"}]
        },
    }
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run(payload)
        result = client_with_fake_venv.send_message(
            "hello",
            context={"tools": [{"type": "function", "function": {"name": "TOOL_FOO"}}]},
        )
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
        mock_run.side_effect = _fake_native_run(payload)
        result = client_with_fake_venv.send_message(
            "hello",
            context={"tools": [{"type": "function", "function": {"name": "LOOKUP"}}]},
        )

    assert result.params["tool_calls"] == [
        {"id": "call_native", "name": "LOOKUP", "arguments": '{"query":"orchid"}'}
    ]


def test_client_send_message_handles_multiline_stdout(
    client_with_fake_venv: HermesClient,
) -> None:
    """Prefix log noise must not break JSON parsing — we read the last line."""
    response = {"text": "ok", "thought": None, "actions": [], "params": {}}
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run(
            response,
            prefix="INFO: loading config\nWARN: cache miss\n",
        )
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


def test_client_send_message_raises_on_silent_adapter_error(
    client_with_fake_venv: HermesClient,
) -> None:
    payload = {
        "text": "",
        "thought": None,
        "actions": [],
        "params": {"error": "openai not installed in venv"},
    }
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run(payload)
        with pytest.raises(RuntimeError, match="adapter error"):
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


def test_client_send_message_promotes_system_hint_without_duplication(
    client_with_fake_venv: HermesClient,
) -> None:
    payload = client_with_fake_venv.build_send_message_payload(
        "do thing",
        {
            "system_hint": "Use lifecycle tools when needed.",
            "case_id": "opaque-case",
        },
    )

    system_prompt = payload["system_prompt"]
    assert isinstance(system_prompt, str)
    assert system_prompt.count("Use lifecycle tools when needed.") == 1
    assert 'case_id:\n"opaque-case"' in system_prompt


def test_client_send_message_payload_includes_generation_options(
    tmp_path: Path,
) -> None:
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


def test_client_defaults_gpt_oss_reasoning_effort_to_low_when_unset(
    tmp_path: Path,
) -> None:
    client = HermesClient(
        repo_path=tmp_path,
        model="gpt-oss-120b",
        api_key="test-key",
        base_url="https://test.example/v1",
    )

    payload = client.build_send_message_payload("hi", {})

    assert payload["reasoning_effort"] == "low"


def test_assistant_text_falls_back_to_vendor_reasoning_when_content_empty() -> None:
    class _Msg:
        content = ""
        reasoning_content = None
        reasoning = "vendor reasoning"

    text, thought = _assistant_text_and_thought(_Msg())

    assert text == "vendor reasoning"
    assert thought == "vendor reasoning"


def test_client_send_message_falls_back_to_reasoning_and_flattens_usage_cache_fields(
    client_with_fake_venv: HermesClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry))

    response = {
        "text": "",
        "thought": "vendor reasoning",
        "actions": [],
        "params": {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 12,
                "total_tokens": 112,
                "prompt_tokens_details": {"cached_tokens": 0},
                "input_token_details": {
                    "cached_tokens": 25,
                    "cache_creation_input_tokens": 8,
                },
            }
        },
    }

    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run(response)
        result = client_with_fake_venv.send_message("hello")

    assert result.text == "vendor reasoning"
    assert result.thought == "vendor reasoning"
    assert result.params["usage"]["cache_read_input_tokens"] == 0
    assert result.params["usage"]["cache_creation_input_tokens"] == 8

    record = json.loads(telemetry.read_text().strip())
    assert record["response_text"] == "vendor reasoning"
    assert record["cache_read_input_tokens"] == 0
    assert record["cache_creation_input_tokens"] == 8
    assert record["usage"]["cache_read_input_tokens"] == 0
    assert record["usage"]["cache_creation_input_tokens"] == 8
    assert record["runtime_provenance"]["agent_runtime"] == "hermes"


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

    assert [msg for msg in messages if msg.get("role") == "system"] == [
        {"role": "system", "content": "Benchmark instructions"}
    ]


def test_build_openai_messages_replaces_system_prompt_when_context_augmented() -> None:
    augmented = 'Benchmark instructions\n\nBenchmark context:\ncase_id:\n"mmlu-1"'
    messages = _build_openai_messages(
        raw_messages=[
            {"role": "system", "content": "Benchmark instructions"},
            {"role": "user", "content": "last turn"},
        ],
        system_prompt=augmented,
        fallback_user_text="fallback",
    )

    assert [msg for msg in messages if msg.get("role") == "system"] == [
        {"role": "system", "content": augmented}
    ]
    assert messages[1] == {"role": "user", "content": "last turn"}


def test_build_openai_messages_preserves_multimodal_user_content() -> None:
    image_content = [
        {"type": "text", "text": "What text is visible?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abcd"}},
    ]

    messages = _build_openai_messages(
        raw_messages=[{"role": "user", "content": image_content}],
        system_prompt=None,
        fallback_user_text="fallback",
    )

    assert messages == [{"role": "user", "content": image_content}]


def test_client_is_ready_returns_bool(client_with_fake_venv: HermesClient) -> None:
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run()
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
        return _fake_native_run()(cmd, **kwargs)

    with patch("hermes_adapter.client.subprocess.run", side_effect=_fake_run):
        client_with_fake_venv.send_message("hi")

    assert captured_env["OPENAI_API_KEY"] == "test-key"
    assert captured_env["OPENAI_BASE_URL"] == "http://127.0.0.1:8765/v1"
    assert captured_env["OPENAI_MODEL"] == "gemma-4-31b"
    assert captured_env["TERMINAL_ENV"] == "local"
    assert captured_env["HERMES_HOME"] == str(client_with_fake_venv.hermes_home)


def test_send_message_returns_empty_incomplete_turn_without_raising(
    client_with_fake_venv: HermesClient,
) -> None:
    """A benign-incomplete no-tool turn is a scoreable empty response.

    The native runner marks such a turn ``native_incomplete_turn`` and returns
    it with a zero exit code; the client must surface it as an empty
    MessageResponse rather than raising and aborting the whole benchmark on one
    empty generation.
    """
    incomplete = _fake_native_run(
        {"text": "", "thought": None, "actions": [], "params": {}},
        extra_meta={"native_incomplete_turn": True},
    )
    with patch("hermes_adapter.client.subprocess.run", side_effect=incomplete):
        response = client_with_fake_venv.send_message("classify this Thai message")

    assert response.text == ""
    assert response.actions == []
    assert response.params["_meta"]["native_incomplete_turn"] is True


def test_send_message_still_raises_on_adapter_error_when_complete(
    client_with_fake_venv: HermesClient,
) -> None:
    """A genuine adapter error on a completed turn still fails closed.

    The incomplete-turn escape hatch must not swallow real adapter faults: an
    ``error`` payload with no content and no marker still raises.
    """
    faulted = _fake_native_run(
        {"text": "", "thought": None, "actions": [], "params": {"error": "boom"}},
    )
    with patch("hermes_adapter.client.subprocess.run", side_effect=faulted):
        with pytest.raises(RuntimeError, match="adapter error"):
            client_with_fake_venv.send_message("hi")


def test_client_health_runs_native_runner(client_with_fake_venv: HermesClient) -> None:
    """health() executes the same native AIAgent runner used by turns."""
    with patch("hermes_adapter.client.subprocess.run") as mock_run:
        mock_run.side_effect = _fake_native_run()
        client_with_fake_venv.health()
    cmd = mock_run.call_args.args[0]
    assert cmd[2].endswith("native_runtime.py")
    assert cmd[-1] == "--health"
