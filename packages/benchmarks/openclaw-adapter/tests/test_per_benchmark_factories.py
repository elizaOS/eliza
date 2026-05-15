"""Tests for the per-benchmark agent_fn factories added to openclaw_adapter.

These tests verify each factory returns an async callable and forwards
``(prompt|history, tools)`` correctly into ``OpenClawClient.send_message``.
``send_message`` itself is mocked so no subprocess or network is touched.
"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from openclaw_adapter.action_calling import build_action_calling_agent_fn
from openclaw_adapter.agentbench import build_agentbench_agent_fn
from openclaw_adapter.client import MessageResponse, OpenClawClient
from openclaw_adapter.mind2web import build_mind2web_agent_fn
from openclaw_adapter.mint import build_mint_agent_fn


@pytest.fixture
def fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "openclaw"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    return binary


@pytest.fixture
def client(fake_binary: Path) -> OpenClawClient:
    return OpenClawClient(binary_path=fake_binary)


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# action_calling
# ---------------------------------------------------------------------------


def test_build_action_calling_agent_fn_returns_async_callable(client: OpenClawClient) -> None:
    agent_fn = build_action_calling_agent_fn(client=client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_action_calling_default_client_uses_native_direct_transport() -> None:
    agent_fn = build_action_calling_agent_fn()
    captured: dict[str, Any] = {}

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        captured["direct_openai_compatible"] = self.direct_openai_compatible
        return MessageResponse(text="ok", thought=None, actions=[], params={})

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("no tool needed", []))

    assert captured["direct_openai_compatible"] is True
    assert result["tool_calls"] == []


def test_action_calling_agent_fn_forwards_prompt_and_tools(client: OpenClawClient) -> None:
    agent_fn = build_action_calling_agent_fn(client=client, model_name="m1")
    captured: dict[str, Any] = {}

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="ok",
            thought="t",
            actions=["FOO"],
            params={"tool_calls": [{"id": "c1", "name": "FOO", "arguments": {"x": 1}}]},
        )

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(
            agent_fn(
                "do the thing",
                [{"type": "function", "function": {"name": "FOO"}}],
            )
        )

    assert captured["text"] == "do the thing"
    ctx = captured["context"]
    assert isinstance(ctx, dict)
    assert ctx["benchmark"] == "action_calling"
    assert ctx["tools"][0]["function"]["name"] == "FOO"
    assert ctx["tool_choice"] == "auto"
    assert "system_prompt" in ctx

    assert result["text"] == "ok"
    assert result["thought"] == "t"
    assert result["model_name"] == "m1"
    assert result["tool_calls"][0]["name"] == "FOO"
    assert result["tool_calls"][0]["arguments"] == {"x": 1}


def test_action_calling_agent_fn_handles_empty_tool_calls(client: OpenClawClient) -> None:
    agent_fn = build_action_calling_agent_fn(client=client)

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(text="just text", thought=None, actions=[], params={})

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("nothing here", []))

    assert result["text"] == "just text"
    assert result["tool_calls"] == []


def test_action_calling_agent_fn_raises_on_bridge_failure(client: OpenClawClient) -> None:
    agent_fn = build_action_calling_agent_fn(client=client)

    def _boom(self: OpenClawClient, *_: Any, **__: Any) -> MessageResponse:
        raise RuntimeError("subprocess died")

    with patch.object(OpenClawClient, "send_message", _boom):
        with pytest.raises(RuntimeError, match="action-calling"):
            _run(agent_fn("hi", []))


# ---------------------------------------------------------------------------
# agentbench
# ---------------------------------------------------------------------------


def test_build_agentbench_agent_fn_returns_async_callable(client: OpenClawClient) -> None:
    agent_fn = build_agentbench_agent_fn(client=client, environment="operating_system")
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_agentbench_agent_fn_extracts_command_from_params(client: OpenClawClient) -> None:
    agent_fn = build_agentbench_agent_fn(
        client=client, environment="operating_system", model_name="m1"
    )
    captured: dict[str, Any] = {}

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        captured["context"] = context
        return MessageResponse(
            text="ignored",
            thought=None,
            actions=[],
            params={"command": "ls -la"},
        )

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("run ls", {"cwd": "/tmp"}))

    ctx = captured["context"]
    assert ctx["benchmark"] == "agentbench"
    assert ctx["environment"] == "operating_system"
    assert ctx["observation"] == {"cwd": "/tmp"}
    assert result["action"] == "ls -la"
    assert result["model_name"] == "m1"


def test_agentbench_agent_fn_extracts_command_from_text_fence(client: OpenClawClient) -> None:
    agent_fn = build_agentbench_agent_fn(client=client)

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text="Sure, I'll run:\n```bash\necho hello\n```",
            thought=None,
            actions=[],
            params={},
        )

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("greet", None))

    assert result["action"] == "echo hello"


def test_agentbench_agent_fn_handles_empty_observation(client: OpenClawClient) -> None:
    agent_fn = build_agentbench_agent_fn(client=client)

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        # When no observation is passed, the context shouldn't include one.
        assert "observation" not in (context or {})
        return MessageResponse(text="answer[42]", thought=None, actions=[], params={})

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("solve it", None))

    assert result["action"] == "answer[42]"


# ---------------------------------------------------------------------------
# mind2web
# ---------------------------------------------------------------------------


def test_build_mind2web_agent_fn_returns_async_callable(client: OpenClawClient) -> None:
    agent_fn = build_mind2web_agent_fn(client=client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_mind2web_agent_fn_parses_action_from_params(client: OpenClawClient) -> None:
    agent_fn = build_mind2web_agent_fn(client=client, model_name="m1")
    captured: dict[str, Any] = {}

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="some prose",
            thought="picking node 7",
            actions=[],
            params={"operation": "TYPE", "element_id": "node-7", "value": "hello"},
        )

    step_ctx = {"website": "example.com", "elements": []}
    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("Click the button", step_ctx))

    ctx = captured["context"]
    assert ctx["benchmark"] == "mind2web"
    assert ctx["website"] == "example.com"
    assert result["operation"] == "TYPE"
    assert result["element_id"] == "node-7"
    assert result["value"] == "hello"
    assert result["reasoning"] == "picking node 7"
    assert result["model_name"] == "m1"


def test_mind2web_agent_fn_parses_action_from_text_json(client: OpenClawClient) -> None:
    agent_fn = build_mind2web_agent_fn(client=client)

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text='{"operation": "CLICK", "element_id": "node-3", "value": "", "reasoning": "ok"}',
            thought=None,
            actions=[],
            params={},
        )

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("go", {}))

    assert result["operation"] == "CLICK"
    assert result["element_id"] == "node-3"


def test_mind2web_agent_fn_defaults_to_click_for_unknown_op(client: OpenClawClient) -> None:
    agent_fn = build_mind2web_agent_fn(client=client)

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text="garbage",
            thought=None,
            actions=[],
            params={"operation": "WAVE", "element_id": "n1"},
        )

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("hi", {}))

    assert result["operation"] == "CLICK"
    assert result["element_id"] == "n1"


# ---------------------------------------------------------------------------
# mint
# ---------------------------------------------------------------------------


def test_build_mint_agent_fn_returns_async_callable(client: OpenClawClient) -> None:
    agent_fn = build_mint_agent_fn(client=client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_mint_agent_fn_forwards_history_and_tools(client: OpenClawClient) -> None:
    agent_fn = build_mint_agent_fn(client=client, model_name="m1")
    captured: dict[str, Any] = {}

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="def f(x): return x",
            thought=None,
            actions=[],
            params={
                "tool_calls": [
                    {"id": "c1", "name": "python", "arguments": {"code": "print(1)"}},
                ]
            },
        )

    history = [
        {"role": "user", "content": "First question"},
        {"role": "assistant", "content": "let me think"},
        {"role": "user", "content": "Solve x+1=3"},
    ]
    tools = [{"type": "function", "function": {"name": "python"}}]
    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn(history, tools))

    assert captured["text"] == "Solve x+1=3"
    ctx = captured["context"]
    assert ctx["benchmark"] == "mint"
    assert ctx["tool_choice"] == "auto"
    assert ctx["tools"][0]["function"]["name"] == "python"
    msgs = ctx["messages"]
    # System prompt was injected at position 0.
    assert msgs[0]["role"] == "system"
    assert any(m["role"] == "user" and m["content"] == "Solve x+1=3" for m in msgs)

    assert result["role"] == "assistant"
    assert result["tool_calls"][0]["function"]["name"] == "python"
    assert result["tool_calls"][0]["function"]["arguments"] == {"code": "print(1)"}
    assert result["model_name"] == "m1"
    assert isinstance(result["latency_ms"], int)


def test_mint_agent_fn_handles_empty_history(client: OpenClawClient) -> None:
    agent_fn = build_mint_agent_fn(client=client)

    def _boom(self: OpenClawClient, *_: Any, **__: Any) -> MessageResponse:
        raise AssertionError("send_message should not be called")

    with patch.object(OpenClawClient, "send_message", _boom):
        result = _run(agent_fn([], []))

    assert result["text"] == ""
    assert result["tool_calls"] == []


def test_mint_agent_fn_passes_tool_results_as_history(client: OpenClawClient) -> None:
    agent_fn = build_mint_agent_fn(client=client)
    captured: dict[str, Any] = {}

    def _fake_send(self: OpenClawClient, text: str, context: Any = None) -> MessageResponse:
        captured["context"] = context
        return MessageResponse(text="final", thought=None, actions=[], params={})

    history = [
        {"role": "user", "content": "compute"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "t1",
                    "type": "function",
                    "function": {"name": "python", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "t1", "name": "python", "content": "42"},
        {"role": "user", "content": "thanks"},
    ]
    with patch.object(OpenClawClient, "send_message", _fake_send):
        _run(agent_fn(history, []))

    msgs = captured["context"]["messages"]
    # The tool record must be threaded so the model sees execution feedback.
    tool_msgs = [m for m in msgs if m["role"] == "tool"]
    assert tool_msgs
    assert tool_msgs[0]["tool_call_id"] == "t1"
    assert tool_msgs[0]["name"] == "python"


def test_mint_agent_fn_raises_on_bridge_failure(client: OpenClawClient) -> None:
    agent_fn = build_mint_agent_fn(client=client)

    def _boom(self: OpenClawClient, *_: Any, **__: Any) -> MessageResponse:
        raise RuntimeError("CLI failed")

    with patch.object(OpenClawClient, "send_message", _boom):
        with pytest.raises(RuntimeError, match="MINT"):
            _run(agent_fn([{"role": "user", "content": "hi"}], []))
