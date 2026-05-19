"""Tests for the per-benchmark agent_fn factories.

These tests don't drive a full LifeOpsBench / BFCL / ClawBench run — they only
verify that the factory returns an async callable that wires the right
arguments into :class:`HermesClient.send_message`. ``send_message`` itself is
mocked, so no subprocess or network is touched.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import types
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from hermes_adapter.bfcl import build_bfcl_agent_fn
from hermes_adapter.clawbench import build_clawbench_agent_fn
from hermes_adapter.client import HermesClient, MessageResponse
from hermes_adapter.woobench import (
    _WOOBENCH_SYSTEM_HINT,
    build_hermes_woobench_agent_fn,
    _turn_from_response as woobench_turn_from_response,
)


@pytest.fixture
def fake_client(tmp_path: Path) -> HermesClient:
    """A HermesClient whose wait_until_ready / send_message are easy to mock."""
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
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


def test_build_bfcl_agent_fn_returns_async_callable(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_bfcl_agent_fn(client=fake_client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_bfcl_agent_fn_forwards_prompt_and_tools(fake_client: HermesClient) -> None:
    """BFCL passes ``prompt`` directly + a tool catalog; the bridge must see both."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_bfcl_agent_fn(client=fake_client)

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="hello",
            thought=None,
            actions=["FOO"],
            params={"tool_calls": [{"name": "FOO", "arguments": "{}", "id": "c1"}]},
        )

    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn("what time is it?", [{"type": "function", "function": {"name": "FOO"}}]))

    assert captured["text"] == "what time is it?"
    ctx = captured["context"] or {}
    assert isinstance(ctx, dict)
    assert ctx["tools"][0]["function"]["name"] == "FOO"
    assert result["text"] == "hello"
    assert result["tool_calls"][0]["name"] == "FOO"


def test_bfcl_agent_fn_includes_system_prompt_when_set(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_bfcl_agent_fn(client=fake_client, system_prompt="be precise")

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["context"] = context
        return MessageResponse(text="", thought=None, actions=[], params={})

    with patch.object(HermesClient, "send_message", _fake_send):
        _run(agent_fn("hi", []))

    assert captured["context"]["system_prompt"] == "be precise"


def test_bfcl_agent_fn_raises_on_bridge_failure(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_bfcl_agent_fn(client=fake_client)

    def _boom(self: HermesClient, *_: Any, **__: Any) -> MessageResponse:
        raise RuntimeError("subprocess died")

    with patch.object(HermesClient, "send_message", _boom):
        with pytest.raises(RuntimeError, match="BFCL"):
            _run(agent_fn("hi", []))


def test_woobench_system_hint_allows_reflective_tarot() -> None:
    assert "do not refuse ordinary tarot" in _WOOBENCH_SYSTEM_HINT
    assert "safe fictional/reflective" in _WOOBENCH_SYSTEM_HINT
    assert "Create at most one charge" in _WOOBENCH_SYSTEM_HINT


def test_woobench_turn_synthesizes_visible_payment_text() -> None:
    response = MessageResponse(
        text="",
        thought=None,
        actions=[],
        params={
            "tool_calls": [
                {
                    "name": "CREATE_APP_CHARGE",
                    "arguments": {"amount_usd": 15, "provider": "oxapay"},
                }
            ]
        },
    )

    result = woobench_turn_from_response(response)

    assert "full reading after $15.00" in result["text"]
    assert result["actions"] == ["BENCHMARK_ACTION"]
    assert result["params"]["BENCHMARK_ACTION"]["command"] == "CREATE_APP_CHARGE"


def test_woobench_agent_fn_forwards_system_message_and_payment_actions(
    fake_client: HermesClient,
) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_hermes_woobench_agent_fn(client=fake_client, model_name="m1")
    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(text="reading", thought=None, actions=[], params={})

    history = [{"role": "user", "content": "Can you read my cards?"}]
    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn(history))

    assert captured["text"] == "Can you read my cards?"
    ctx = captured["context"]
    assert ctx["messages"][0] == {"role": "system", "content": _WOOBENCH_SYSTEM_HINT}
    assert ctx["payment_actions"]["create"]["command"] == "CREATE_APP_CHARGE"
    assert ctx["payment_actions"]["check"]["command"] == "CHECK_PAYMENT"
    assert result["text"] == "reading"


def test_build_clawbench_agent_fn_returns_async_callable(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_clawbench_agent_fn(
            client=fake_client,
            scenario_yaml={"system_prompt": "be terse", "model_name": "gpt-oss-120b"},
            fixtures=None,
        )
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_clawbench_agent_fn_reads_last_user_turn(fake_client: HermesClient) -> None:
    """ClawBench passes the full history; the bridge call must use the last user turn."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_clawbench_agent_fn(
            client=fake_client, scenario_yaml={"system_prompt": "be terse"}
        )

    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="reply",
            thought="thinking",
            actions=["BAR"],
            params={"tool_calls": [{"name": "BAR", "arguments": '{"x": 1}', "id": "c2"}]},
        )

    history = [
        {"role": "user", "content": "first message"},
        {"role": "assistant", "content": "first reply"},
        {"role": "user", "content": "second message"},
    ]
    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn(history, [{"type": "function", "function": {"name": "BAR"}}]))

    # The factory picked the last user turn, not the first.
    assert captured["text"] == "second message"
    assert captured["context"]["tools"][0]["function"]["name"] == "BAR"
    assert captured["context"]["system_prompt"] == "be terse"
    assert result["text"] == "reply"
    assert result["tool_calls"][0]["id"] == "c2"
    assert result["thought"] == "thinking"


def test_clawbench_agent_fn_handles_empty_history(fake_client: HermesClient) -> None:
    """If no user turn is present, the agent_fn must return an empty assistant turn
    rather than spawning a bridge call."""
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_clawbench_agent_fn(client=fake_client, scenario_yaml={})

    with patch.object(HermesClient, "send_message", side_effect=AssertionError("should not be called")):
        result = _run(agent_fn([], []))

    assert result["text"] == ""
    assert result["tool_calls"] == []


def test_clawbench_agent_fn_includes_model_name(fake_client: HermesClient) -> None:
    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_clawbench_agent_fn(
            client=fake_client, scenario_yaml={"model_name": "my-model"}
        )

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(text="", thought=None, actions=[], params={})

    with patch.object(HermesClient, "send_message", _fake_send):
        result = _run(agent_fn([{"role": "user", "content": "hi"}], []))

    assert result["model_name"] == "my-model"


# --------------------------------------------------------------------------
# LifeOpsBench is gated on `eliza_lifeops_bench.types.MessageTurn`. Stub it
# minimally so the factory imports cleanly even when the real package isn't
# installed in this venv.
# --------------------------------------------------------------------------


def _install_lifeops_stub() -> None:
    if "eliza_lifeops_bench" in sys.modules:
        return
    pkg = types.ModuleType("eliza_lifeops_bench")
    types_mod = types.ModuleType("eliza_lifeops_bench.types")

    class MessageTurn:  # noqa: D401 — minimal stub
        def __init__(self, role: str, content: str, tool_calls: Any = None) -> None:
            self.role = role
            self.content = content
            self.tool_calls = tool_calls

    types_mod.MessageTurn = MessageTurn
    types_mod.attach_usage_cache_fields = lambda _turn, _usage: None
    sys.modules["eliza_lifeops_bench"] = pkg
    sys.modules["eliza_lifeops_bench.types"] = types_mod


def test_build_lifeops_bench_agent_fn_returns_async_callable(fake_client: HermesClient) -> None:
    _install_lifeops_stub()
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_lifeops_bench_agent_fn(client=fake_client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_lifeops_agent_fn_maps_tool_calls_to_openai_shape(fake_client: HermesClient) -> None:
    """The factory must convert hermes-adapter tool_call records into the
    OpenAI-style ``{id, type, function: {name, arguments}}`` shape."""
    _install_lifeops_stub()
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_lifeops_bench_agent_fn(client=fake_client, model_name="m")

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text="done",
            thought=None,
            actions=["RUN"],
            params={"tool_calls": [{"name": "RUN", "arguments": '{"k": 1}', "id": "tc1"}]},
        )

    with patch.object(HermesClient, "send_message", _fake_send):
        turn = _run(agent_fn([{"role": "user", "content": "go"}], []))

    assert turn.role == "assistant"
    assert turn.content == "done"
    assert turn.tool_calls is not None
    tc = turn.tool_calls[0]
    assert tc["id"] == "tc1"
    assert tc["type"] == "function"
    assert tc["function"]["name"] == "RUN"
    assert tc["function"]["arguments"] == '{"k": 1}'
    assert turn.model_name == "m"


def test_lifeops_agent_fn_recovers_json_text_tool_call(fake_client: HermesClient) -> None:
    """Hermes sometimes emits its action channel as JSON text.

    LifeOps-style benchmark runners still need to execute that action instead
    of scoring it as an empty assistant response.
    """
    _install_lifeops_stub()
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_lifeops_bench_agent_fn(client=fake_client)

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text='{"tool":"get_weather","parameters":{"city":"Paris","when":"tomorrow"}}',
            thought=None,
            actions=[],
            params={},
        )

    with patch.object(HermesClient, "send_message", _fake_send):
        turn = _run(
            agent_fn(
                [{"role": "user", "content": "weather"}],
                [
                    {
                        "name": "get_weather",
                        "parameters": {
                            "type": "object",
                            "properties": {"city": {"type": "string"}},
                        },
                    }
                ],
            )
        )

    assert turn.tool_calls is not None
    tc = turn.tool_calls[0]
    assert tc["function"]["name"] == "get_weather"
    assert tc["function"]["arguments"] == {"city": "Paris", "when": "tomorrow"}


def test_lifeops_agent_fn_promotes_calendar_availability_call(fake_client: HermesClient) -> None:
    _install_lifeops_stub()
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn

    with patch.object(HermesClient, "wait_until_ready", return_value=None):
        agent_fn = build_lifeops_bench_agent_fn(client=fake_client)

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        return MessageResponse(
            text="",
            thought=None,
            actions=[],
            params={
                "tool_calls": [
                    {
                        "name": "CALENDAR",
                        "arguments": (
                            '{"action":"search_events","windowStart":"2026-05-14T09:00:00Z",'
                            '"windowEnd":"2026-05-14T10:00:00Z","intent":"availability"}'
                        ),
                        "id": "tc1",
                    }
                ]
            },
        )

    with patch.object(HermesClient, "send_message", _fake_send):
        turn = _run(agent_fn([{"role": "user", "content": "am I free Thursday?"}], []))

    assert turn.tool_calls is not None
    tc = turn.tool_calls[0]
    assert tc["function"]["name"] == "CALENDAR_CHECK_AVAILABILITY"
    assert tc["function"]["arguments"]["subaction"] == "check_availability"
    assert tc["function"]["arguments"]["startAt"] == "2026-05-14T09:00:00Z"
