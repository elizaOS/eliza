"""Offline unit tests for the Smithers BFCL agent glue.

These avoid spawning bun by injecting a fake SmithersClient.
"""

from __future__ import annotations

import asyncio

import pytest

from smithers_adapter import bfcl as sb
from smithers_adapter.client import MessageResponse


def test_provider_safe_tools_sanitizes_dotted_names() -> None:
    tools = [{"type": "function", "function": {"name": "math.factorial", "description": "d", "parameters": {}}}]
    patched, name_map = sb._provider_safe_tools(tools)
    safe = patched[0]["function"]["name"]
    assert safe != "math.factorial"
    assert sb._SAFE_TOOL_NAME_RE.match(safe)
    assert name_map[safe] == "math.factorial"


def test_extract_calls_from_tool_calls_params() -> None:
    pytest.importorskip("benchmarks.bfcl.types")
    params = {"tool_calls": [{"name": "get_weather", "arguments": '{"location": "SF"}'}]}
    calls = sb._extract_calls_from_response("", params)
    assert len(calls) == 1
    assert calls[0].name == "get_weather"
    assert calls[0].arguments["location"] == "SF"


def test_restore_original_call_names() -> None:
    pytest.importorskip("benchmarks.bfcl.types")
    _, _, FunctionCall = sb._bfcl_types()
    calls = [FunctionCall(name="math_factorial", arguments={"n": 5})]
    restored = sb._restore_original_call_names(calls, {"math_factorial": "math.factorial"})
    assert restored[0].name == "math.factorial"


def test_tool_choice_for_case() -> None:
    assert sb._tool_choice_for_case(is_relevant=True, tools=[{"x": 1}]) == "required"
    assert sb._tool_choice_for_case(is_relevant=False, tools=[{"x": 1}]) == "none"
    assert sb._tool_choice_for_case(is_relevant=True, tools=[]) == "none"


class _FakeClient:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def wait_until_ready(self, timeout: float = 60) -> None:
        return None

    def reset(self, task_id: str, benchmark: str, **kw):
        return {"task_id": task_id}

    def send_message(self, text: str, context=None) -> MessageResponse:
        self.sent.append({"text": text, "context": context})
        return MessageResponse(
            text="",
            thought=None,
            actions=["get_weather"],
            params={"tool_calls": [{"name": "get_weather", "arguments": '{"location": "SF"}'}], "usage": {}},
        )


class _Case:
    id = "case1"
    is_relevant = True

    class _Cat:
        value = "simple"

    category = _Cat()
    question = "weather in SF?"
    functions = [{"name": "get_weather", "description": "d", "parameters": {"type": "object", "properties": {"location": {"type": "string"}}}}]


def test_smithers_bfcl_agent_query_returns_calls(monkeypatch) -> None:
    pytest.importorskip("benchmarks.bfcl.types")
    # Avoid depending on bfcl's openai-tools formatter internals: feed an
    # already-OpenAI-shaped tools list straight through.
    monkeypatch.setattr(
        sb,
        "_bfcl_tools_formatter",
        lambda: (lambda funcs: [{"type": "function", "function": f} for f in funcs]),
    )
    agent = sb.SmithersBFCLAgent(client=_FakeClient(), model_name="gpt-oss-120b")

    async def run():
        return await agent.query(_Case())

    predicted, raw_json, latency = asyncio.run(run())
    assert latency >= 0
    assert any(c.name == "get_weather" for c in predicted)
    assert agent.model_name == "gpt-oss-120b"


def test_close_resets_initialized() -> None:
    pytest.importorskip("benchmarks.bfcl.types")
    agent = sb.SmithersBFCLAgent(client=_FakeClient(), model_name="gpt-oss-120b")
    agent._initialized = True
    import asyncio as _aio

    _aio.run(agent.close())
    assert agent._initialized is False
