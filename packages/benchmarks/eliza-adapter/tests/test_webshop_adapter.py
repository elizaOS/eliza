from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from eliza_adapter.webshop import (
    _parse_action_from_response,
    _webshop_context,
)


class _PageType(Enum):
    SEARCH = "search"


@dataclass
class _Task:
    task_id: str = "webshop-test-1"
    instruction: str = "buy wireless headphones"
    budget: float | None = 100.0


@dataclass
class _Observation:
    page_type: _PageType = _PageType.SEARCH
    available_actions: list[str] | None = None


def test_parse_native_webshop_tool_call() -> None:
    action, command = _parse_action_from_response(
        "",
        [],
        {
            "tool_calls": [
                {
                    "id": "call_0",
                    "name": "webshop_action",
                    "arguments": '{"command":"click[buy now]"}',
                }
            ]
        },
    )

    assert action == "WEBSHOP_ACTION"
    assert command == "click[buy now]"


def test_parse_benchmark_action_json_fallback() -> None:
    action, command = _parse_action_from_response(
        '{"actions":["BENCHMARK_ACTION"],"params":{"BENCHMARK_ACTION":{"command":"search[wireless headphones]"}}}',
        ["REPLY"],
        {"BENCHMARK_ACTION": {"command": "search[wireless headphones]"}},
    )

    assert action == "WEBSHOP_ACTION"
    assert command == "search[wireless headphones]"


def test_webshop_context_exposes_single_command_tool() -> None:
    observation = _Observation(available_actions=["search[<query>]", "click[buy now]"])

    context = _webshop_context(
        task=_Task(),
        observation=observation,  # type: ignore[arg-type]
        obs_str="available actions",
        turn=2,
        model="gpt-oss-120b",
    )

    assert context["benchmark"] == "webshop"
    assert context["tool_choice"] == "required"
    assert context["actionSpace"] == ["search[<query>]", "click[buy now]"]
    tools = context["tools"]
    assert isinstance(tools, list)
    assert tools[0]["function"]["name"] == "webshop_action"  # type: ignore[index]
