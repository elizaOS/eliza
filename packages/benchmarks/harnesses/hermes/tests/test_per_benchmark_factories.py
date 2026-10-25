"""Tests for the per-benchmark agent_fn factories added to hermes_adapter.

These tests verify each factory returns an async callable and forwards
``(prompt|history, tools)`` correctly into ``HermesClient.send_message``.
``send_message`` and ``wait_until_ready`` are mocked so no subprocess or
network is touched.
"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from hermes_adapter.action_calling import build_action_calling_agent_fn
from hermes_adapter.agentbench import build_agentbench_agent_fn
from hermes_adapter.client import HermesClient, MessageResponse
from hermes_adapter.mind2web import build_mind2web_agent_fn
from hermes_adapter.mint import build_mint_agent_fn


@pytest.fixture
def fake_client(tmp_path: Path) -> HermesClient:
    venv_python = tmp_path / ".venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("# fake")
    venv_python.chmod(0o755)
    return HermesClient(
        repo_path=tmp_path,
        venv_python=venv_python,
        api_key="test-key",
        base_url="https://test.example/v1",
    )


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# action_calling
# ---------------------------------------------------------------------------


def test_build_action_calling_agent_fn_returns_async_callable(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_action_calling_agent_fn(client=fake_client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_action_calling_agent_fn_forwards_prompt_and_tools(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_action_calling_agent_fn(client=fake_client, model_name="m1")

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="ok",
            thought="t",
            actions=["FOO"],
            params={"tool_calls": [{"name": "FOO", "arguments": '{"x": 1}', "id": "c1"}]},
        )

    with patch.object(HermesClient, "send_message", _fake_send):
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

    assert result["text"] == "ok"
    assert result["thought"] == "t"
    assert result["model_name"] == "m1"
    assert result["tool_calls"][0]["name"] == "FOO"
    assert result["tool_calls"][0]["arguments"] == {"x": 1}


def test_action_calling_agent_fn_handles_empty_history(fake_client: HermesClient) -> None:
    """With no tool_calls in the response, the factory should still return
    a well-formed dict with an empty tool_calls list."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_action_calling_agent_fn(client=fake_client)

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(text="just text", thought=None, actions=[], params={})

    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn("nothing here", []))

    assert result["text"] == "just text"
    assert result["tool_calls"] == []


def test_action_calling_agent_fn_raises_on_bridge_failure(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_action_calling_agent_fn(client=fake_client)

    def _boom(self: HermesClient, *_: Any, **__: Any) -> MessageResponse:
        raise RuntimeError("subprocess died")

    with patch.object(HermesClient, "send_message", _boom):
        with pytest.raises(RuntimeError, match="action-calling"):
            _run(agent_fn("hi", []))


# ---------------------------------------------------------------------------
# agentbench
# ---------------------------------------------------------------------------


def test_build_agentbench_agent_fn_returns_async_callable(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_agentbench_agent_fn(client=fake_client, environment="operating_system")
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_agentbench_agent_fn_forwards_prompt_and_tools(fake_client: HermesClient) -> None:
    """AgentBench passes (prompt, observation) — the bridge must see both."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_agentbench_agent_fn(
            client=fake_client, environment="database", model_name="m1"
        )

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="ignored",
            thought=None,
            actions=[],
            params={"command": "SELECT 1"},
        )

    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn("read row", {"table": "users"}))

    assert captured["text"] == "read row"
    ctx = captured["context"]
    assert ctx["benchmark"] == "agentbench"
    assert ctx["environment"] == "database"
    assert ctx["observation"] == {"table": "users"}
    assert result["action"] == "SELECT 1"
    assert result["model_name"] == "m1"


def test_agentbench_agent_fn_extracts_from_text(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_agentbench_agent_fn(client=fake_client)

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text="<command>echo hi</command>",
            thought=None,
            actions=[],
            params={},
        )

    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn("hello", None))
    assert result["action"] == "echo hi"


def test_agentbench_agent_fn_handles_empty_history(fake_client: HermesClient) -> None:
    """Empty observation must not break — context just omits the key."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_agentbench_agent_fn(client=fake_client)

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["context"] = context
        return MessageResponse(text="reply", thought=None, actions=[], params={})

    with patch.object(HermesClient, "send_message", _fake_send):
        _run(agent_fn("hi", None))

    assert "observation" not in captured["context"]


# ---------------------------------------------------------------------------
# mind2web
# ---------------------------------------------------------------------------


def test_build_mind2web_agent_fn_returns_async_callable(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mind2web_agent_fn(client=fake_client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_mind2web_agent_fn_forwards_prompt_and_tools(fake_client: HermesClient) -> None:
    """Mind2Web threads step context (website, html, elements) — the bridge sees them."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mind2web_agent_fn(client=fake_client, model_name="m1")

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="prose",
            thought="picking node 7",
            actions=[],
            params={"operation": "TYPE", "element_id": "node-7", "value": "hello"},
        )

    step_ctx = {"website": "example.com", "elements": [{"id": "node-7"}]}
    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn("Click the button", step_ctx))

    assert captured["text"] == "Click the button"
    ctx = captured["context"]
    assert ctx["benchmark"] == "mind2web"
    assert ctx["website"] == "example.com"
    assert result["operation"] == "TYPE"
    assert result["element_id"] == "node-7"
    assert result["value"] == "hello"
    assert result["reasoning"] == "picking node 7"
    assert result["model_name"] == "m1"


def test_mind2web_agent_fn_parses_text_json(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mind2web_agent_fn(client=fake_client)

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text='```json\n{"operation": "CLICK", "element_id": "node-9"}\n```',
            thought=None,
            actions=[],
            params={},
        )

    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn("go", {}))

    assert result["operation"] == "CLICK"
    assert result["element_id"] == "node-9"


def test_mind2web_agent_fn_handles_empty_history(fake_client: HermesClient) -> None:
    """Empty step_context must not blow up — context only carries benchmark + system."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mind2web_agent_fn(client=fake_client)

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["context"] = context
        return MessageResponse(text="", thought=None, actions=[], params={})

    with patch.object(HermesClient, "send_message", _fake_send):
        _run(agent_fn("hi", {}))

    ctx = captured["context"]
    assert ctx["benchmark"] == "mind2web"
    assert "system_prompt" in ctx


# ---------------------------------------------------------------------------
# mint
# ---------------------------------------------------------------------------


def test_build_mint_agent_fn_returns_async_callable(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mint_agent_fn(client=fake_client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_mint_agent_fn_forwards_prompt_and_tools(fake_client: HermesClient) -> None:
    """MINT threads the conversation history; the last user turn is the prompt."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mint_agent_fn(client=fake_client, model_name="m1")

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="def f(x): return x",
            thought=None,
            actions=[],
            params={
                "tool_calls": [
                    {"name": "python", "arguments": '{"code": "print(1)"}', "id": "c1"}
                ]
            },
        )

    history = [
        {"role": "user", "content": "First question"},
        {"role": "assistant", "content": "let me think"},
        {"role": "user", "content": "Solve x+1=3"},
    ]
    tools = [{"type": "function", "function": {"name": "python"}}]
    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn(history, tools))

    assert captured["text"] == "Solve x+1=3"
    ctx = captured["context"]
    assert ctx["benchmark"] == "mint"
    assert ctx["tool_choice"] == "auto"
    assert ctx["tools"][0]["function"]["name"] == "python"

    msgs = ctx["messages"]
    assert msgs[0]["role"] == "system"
    assert any(m["role"] == "user" and m["content"] == "Solve x+1=3" for m in msgs)

    assert result["role"] == "assistant"
    assert result["tool_calls"][0]["function"]["name"] == "python"
    assert result["tool_calls"][0]["function"]["arguments"] == {"code": "print(1)"}
    assert result["model_name"] == "m1"
    assert isinstance(result["latency_ms"], int)


def test_mint_agent_fn_handles_empty_history(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mint_agent_fn(client=fake_client)

    with patch.object(
        HermesClient,
        "send_message",
        side_effect=AssertionError("send_message should not be called"),
    ):
        result = _run(agent_fn([], []))

    assert result["text"] == ""
    assert result["tool_calls"] == []


def test_mint_agent_fn_threads_tool_results(fake_client: HermesClient) -> None:
    """Prior tool execution feedback must be visible to the model."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mint_agent_fn(client=fake_client)

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
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
    with patch.object(HermesClient, "send_message", _fake_send):
        _run(agent_fn(history, []))

    msgs = captured["context"]["messages"]
    tool_msgs = [m for m in msgs if m["role"] == "tool"]
    assert tool_msgs
    assert tool_msgs[0]["tool_call_id"] == "t1"
    assert tool_msgs[0]["name"] == "python"


def test_mint_agent_fn_raises_on_bridge_failure(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_mint_agent_fn(client=fake_client)

    def _boom(self: HermesClient, *_: Any, **__: Any) -> MessageResponse:
        raise RuntimeError("subprocess died")

    with patch.object(HermesClient, "send_message", _boom):
        with pytest.raises(RuntimeError, match="MINT"):
            _run(agent_fn([{"role": "user", "content": "hi"}], []))
