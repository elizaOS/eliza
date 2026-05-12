"""Tests for Hermes BFCL response normalization."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import patch

from hermes_adapter.bfcl import (
    HermesBFCLAgent,
    _extract_calls_from_response,
    _provider_safe_tools,
)
from hermes_adapter.client import HermesClient, MessageResponse


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def _fake_client(tmp_path: Path) -> HermesClient:
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


def test_extract_calls_from_hermes_tool_calls_params() -> None:
    calls = _extract_calls_from_response(
        "",
        {
            "tool_calls": [
                {
                    "id": "tc1",
                    "name": "get_weather",
                    "arguments": '{"location":"San Francisco"}',
                }
            ]
        },
    )

    assert len(calls) == 1
    assert calls[0].name == "get_weather"
    assert calls[0].arguments == {"location": "San Francisco"}


def test_extract_calls_from_openai_nested_tool_call_shape() -> None:
    calls = _extract_calls_from_response(
        "",
        {
            "tool_calls": [
                {
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": {"query": "bfcl"},
                    },
                }
            ]
        },
    )

    assert len(calls) == 1
    assert calls[0].name == "search"
    assert calls[0].arguments == {"query": "bfcl"}


def test_extract_calls_rejects_text_json_fallback() -> None:
    calls = _extract_calls_from_response(
        '[{"name": "calculate", "arguments": {"x": 2}}]',
        {},
    )

    assert calls == []


def test_hermes_bfcl_agent_query_threads_tools_and_parses_response(tmp_path: Path) -> None:
    from benchmarks.bfcl.types import (
        BFCLCategory,
        BFCLTestCase,
        FunctionCall,
        FunctionDefinition,
        FunctionParameter,
    )

    client = _fake_client(tmp_path)
    agent = HermesBFCLAgent(client=client, model_name="gpt-oss-120b")
    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="",
            thought=None,
            actions=["get_weather"],
            params={
                "tool_calls": [
                    {
                        "id": "tc1",
                        "name": "get_weather",
                        "arguments": '{"location":"San Francisco"}',
                    }
                ]
            },
        )

    test_case = BFCLTestCase(
        id="simple_1",
        category=BFCLCategory.SIMPLE,
        question="Weather in San Francisco?",
        functions=[
            FunctionDefinition(
                name="get_weather",
                description="Get weather",
                parameters={
                    "location": FunctionParameter(
                        name="location",
                        param_type="string",
                        description="City",
                    )
                },
                required_params=["location"],
            )
        ],
        expected_calls=[FunctionCall(name="get_weather", arguments={"location": "San Francisco"})],
    )

    with (
        patch.object(HermesClient, "wait_until_ready", return_value=None),
        patch.object(HermesClient, "send_message", _fake_send),
    ):
        calls, raw_response, latency_ms = _run(agent.query(test_case))

    assert captured["text"] == "Weather in San Francisco?"
    assert captured["context"]["benchmark"] == "bfcl"
    assert captured["context"]["tools"][0]["function"]["name"] == "get_weather"
    assert calls == [FunctionCall(name="get_weather", arguments={"location": "San Francisco"})]
    assert '"tool_calls"' in raw_response
    assert latency_ms >= 0


def test_hermes_bfcl_agent_maps_provider_safe_tool_names_back(
    tmp_path: Path,
) -> None:
    from benchmarks.bfcl.types import (
        BFCLCategory,
        BFCLTestCase,
        FunctionCall,
        FunctionDefinition,
        FunctionParameter,
    )

    client = _fake_client(tmp_path)
    agent = HermesBFCLAgent(client=client, model_name="gpt-oss-120b")
    captured: dict[str, Any] = {}

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        captured["context"] = context
        return MessageResponse(
            text="",
            thought=None,
            actions=["sql_execute"],
            params={
                "tool_calls": [
                    {
                        "id": "tc1",
                        "name": "sql_execute",
                        "arguments": '{"table_name":"Orders"}',
                    }
                ]
            },
        )

    test_case = BFCLTestCase(
        id="sql_1",
        category=BFCLCategory.SQL,
        question="Delete from Orders.",
        functions=[
            FunctionDefinition(
                name="sql.execute",
                description="Execute SQL",
                parameters={
                    "table_name": FunctionParameter(
                        name="table_name",
                        param_type="string",
                        description="Table",
                    )
                },
                required_params=["table_name"],
            )
        ],
        expected_calls=[FunctionCall(name="sql.execute", arguments={"table_name": "Orders"})],
    )

    with (
        patch.object(HermesClient, "wait_until_ready", return_value=None),
        patch.object(HermesClient, "send_message", _fake_send),
    ):
        calls, raw_response, _latency_ms = _run(agent.query(test_case))

    function = captured["context"]["tools"][0]["function"]
    assert function["name"] == "sql_execute"
    assert "Original BFCL function name: sql.execute." in function["description"]
    assert calls == [FunctionCall(name="sql.execute", arguments={"table_name": "Orders"})]
    assert '"sql_execute": "sql.execute"' in raw_response


def test_provider_safe_tools_uniquifies_collisions() -> None:
    tools = [
        {"type": "function", "function": {"name": "foo.bar", "description": "", "parameters": {}}},
        {"type": "function", "function": {"name": "foo_bar", "description": "", "parameters": {}}},
    ]

    patched, name_map = _provider_safe_tools(tools)

    names = [tool["function"]["name"] for tool in patched]
    assert names == ["foo_bar", "foo_bar_2"]
    assert name_map == {"foo_bar": "foo.bar", "foo_bar_2": "foo_bar"}


def test_hermes_bfcl_agent_retries_prompt_only_on_native_tool_schema_error(
    tmp_path: Path,
) -> None:
    from benchmarks.bfcl.types import (
        BFCLCategory,
        BFCLTestCase,
        FunctionCall,
        FunctionDefinition,
        FunctionParameter,
    )

    client = _fake_client(tmp_path)
    agent = HermesBFCLAgent(client=client, model_name="gpt-oss-120b")
    contexts: list[dict[str, Any]] = []
    texts: list[str] = []

    def _fake_send(self: HermesClient, text: str, context: Any = None) -> MessageResponse:
        texts.append(text)
        contexts.append(context or {})
        if len(contexts) == 1:
            raise RuntimeError("wrong_api_format: Failed to compile the JSON schema grammar")
        return MessageResponse(
            text='[{"name":"run_tool","arguments":{"value":3}}]',
            thought=None,
            actions=[],
            params={},
        )

    test_case = BFCLTestCase(
        id="schema_1",
        category=BFCLCategory.SIMPLE,
        question="Run tool with value 3",
        functions=[
            FunctionDefinition(
                name="run_tool",
                description="Run tool",
                parameters={
                    "value": FunctionParameter(
                        name="value",
                        param_type="integer",
                        description="Value",
                    )
                },
                required_params=["value"],
            )
        ],
        expected_calls=[FunctionCall(name="run_tool", arguments={"value": 3})],
    )

    with (
        patch.object(HermesClient, "wait_until_ready", return_value=None),
        patch.object(HermesClient, "send_message", _fake_send),
    ):
        calls, raw_response, _latency_ms = _run(agent.query(test_case))

    assert contexts[0]["tools"][0]["function"]["name"] == "run_tool"
    assert len(contexts) == 2
    assert contexts[1]["tool_choice"] == "none"
    assert contexts[1]["tool_schema_retry"] is True
    assert "Available functions" in texts[1]
    assert calls == [FunctionCall(name="run_tool", arguments={"value": 3})]
    assert '"tool_schema_retry": true' in raw_response
