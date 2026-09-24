from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import Enum

import pytest

from eliza_adapter.webshop import (
    ElizaBridgeWebShopAgent,
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
    goal_attributes: dict[str, str] | None = None


@dataclass
class _Observation:
    page_type: _PageType = _PageType.SEARCH
    message: str = "Search page"
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


class _FailingClient:
    def __init__(self, *, fail_reset: bool) -> None:
        self.fail_reset = fail_reset

    def wait_until_ready(self, *, timeout: int) -> None:
        assert timeout == 120

    def reset(self, **_kwargs) -> None:
        if self.fail_reset:
            raise OSError("reset unavailable")

    def send_message(self, **_kwargs):
        raise OSError("model transport unavailable")


class _Environment:
    def reset(self, _task):
        return _Observation(available_actions=["search[<query>]"])


@pytest.mark.parametrize("fail_reset", (True, False))
def test_webshop_bridge_transport_failures_abort_the_task(fail_reset: bool) -> None:
    agent = ElizaBridgeWebShopAgent(
        _Environment(),  # type: ignore[arg-type]
        client=_FailingClient(fail_reset=fail_reset),  # type: ignore[arg-type]
    )
    expected = "session reset failed" if fail_reset else "bridge call failed"

    with pytest.raises(RuntimeError, match=expected):
        asyncio.run(agent.process_task(_Task()))  # type: ignore[arg-type]
