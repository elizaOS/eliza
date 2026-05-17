"""Tests for OpenClaw BFCL response normalization."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import patch

from openclaw_adapter.bfcl import (
    OpenClawBFCLAgent,
    _provider_safe_tools,
    build_bfcl_agent_fn,
)
from openclaw_adapter.client import MessageResponse, OpenClawClient


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def _fake_client(tmp_path: Path) -> OpenClawClient:
    return OpenClawClient(
        repo_path=tmp_path,
        binary_path=tmp_path / "openclaw",
        api_key="test-key",
        base_url="https://test.example/v1",
        direct_openai_compatible=True,
    )


def test_openclaw_bfcl_agent_maps_provider_safe_tool_names_back(tmp_path: Path) -> None:
    from benchmarks.bfcl.types import (
        BFCLCategory,
        BFCLTestCase,
        FunctionCall,
        FunctionDefinition,
        FunctionParameter,
    )

    client = _fake_client(tmp_path)
    agent = OpenClawBFCLAgent(client=client, model_name="gpt-oss-120b")
    captured: dict[str, Any] = {}

    def _fake_send(
        self: OpenClawClient,
        text: str,
        context: Any = None,
    ) -> MessageResponse:
        captured["text"] = text
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
                        "arguments": {"table_name": "Orders"},
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

    with patch.object(OpenClawClient, "send_message", _fake_send):
        calls, raw_response, latency_ms = _run(agent.query(test_case))

    function = captured["context"]["tools"][0]["function"]
    assert captured["text"] == "Delete from Orders."
    assert captured["context"]["benchmark"] == "bfcl"
    assert captured["context"]["tool_choice"] == "required"
    assert captured["context"]["temperature"] == 0.0
    assert "one separate native tool call" in captured["context"]["system_prompt"]
    assert "parameter names" in captured["context"]["system_prompt"]
    assert function["name"] == "sql_execute"
    assert "Original BFCL function name: sql.execute." in function["description"]
    assert calls == [FunctionCall(name="sql.execute", arguments={"table_name": "Orders"})]
    assert '"sql_execute": "sql.execute"' in raw_response
    assert latency_ms >= 0


def test_provider_safe_tools_preserves_schema_field_names_and_defaults() -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "customer.lookup",
                "description": "Lookup a customer",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "customerId": {
                            "type": "string",
                            "description": "Stable customer id",
                        },
                        "includeInactive": {
                            "type": "boolean",
                            "description": "Include inactive customers",
                            "default": False,
                        },
                    },
                    "required": ["customerId"],
                },
            },
        }
    ]

    patched, name_map = _provider_safe_tools(tools)

    function = patched[0]["function"]
    properties = function["parameters"]["properties"]
    assert function["name"] == "customer_lookup"
    assert name_map == {"customer_lookup": "customer.lookup"}
    assert list(properties) == ["customerId", "includeInactive"]
    assert properties["includeInactive"]["default"] is False
    assert tools[0]["function"]["name"] == "customer.lookup"


def test_build_bfcl_agent_fn_default_client_uses_native_direct_transport() -> None:
    agent_fn = build_bfcl_agent_fn()
    captured: dict[str, Any] = {}

    def _fake_send(
        self: OpenClawClient,
        text: str,
        context: Any = None,
    ) -> MessageResponse:
        captured["direct_openai_compatible"] = self.direct_openai_compatible
        return MessageResponse(text="", thought=None, actions=[], params={})

    with patch.object(OpenClawClient, "send_message", _fake_send):
        result = _run(agent_fn("hello", []))

    assert captured["direct_openai_compatible"] is True
    assert result["tool_calls"] == []


def test_openclaw_bfcl_agent_parallel_case_requires_one_native_call_per_operation(
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
    agent = OpenClawBFCLAgent(client=client, model_name="gpt-oss-120b")
    captured: dict[str, Any] = {}

    def _fake_send(
        self: OpenClawClient,
        text: str,
        context: Any = None,
    ) -> MessageResponse:
        captured["text"] = text
        captured["context"] = context
        return MessageResponse(
            text="",
            thought=None,
            actions=["get_weather", "get_weather", "search"],
            params={
                "tool_calls": [
                    {"id": "tc1", "name": "get_weather", "arguments": {"location": "NYC"}},
                    {"id": "tc2", "name": "get_weather", "arguments": {"location": "SF"}},
                    {"id": "tc3", "name": "search", "arguments": {"query": "restaurants"}},
                ]
            },
        )

    test_case = BFCLTestCase(
        id="parallel_1",
        category=BFCLCategory.PARALLEL,
        question="Get weather in NYC and SF, and search restaurants.",
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
            ),
            FunctionDefinition(
                name="search",
                description="Search",
                parameters={
                    "query": FunctionParameter(
                        name="query",
                        param_type="string",
                        description="Query",
                    )
                },
                required_params=["query"],
            ),
        ],
        expected_calls=[
            FunctionCall(name="get_weather", arguments={"location": "NYC"}),
            FunctionCall(name="get_weather", arguments={"location": "SF"}),
            FunctionCall(name="search", arguments={"query": "restaurants"}),
        ],
    )

    with patch.object(OpenClawClient, "send_message", _fake_send):
        calls, _raw_response, _latency_ms = _run(agent.query(test_case))

    assert captured["context"]["tool_choice"] == "required"
    assert captured["context"]["temperature"] == 0.0
    assert "one separate native tool call" in captured["context"]["system_prompt"]
    assert "Do not merge separate operations" in captured["context"]["system_prompt"]
    assert calls == test_case.expected_calls


def test_openclaw_bfcl_agent_irrelevant_case_disables_tool_calls(tmp_path: Path) -> None:
    from benchmarks.bfcl.types import BFCLCategory, BFCLTestCase

    client = _fake_client(tmp_path)
    agent = OpenClawBFCLAgent(client=client, model_name="gpt-oss-120b")
    captured: dict[str, Any] = {}

    def _fake_send(
        self: OpenClawClient,
        text: str,
        context: Any = None,
    ) -> MessageResponse:
        captured["context"] = context
        return MessageResponse(text="No relevant function.", thought=None, actions=[], params={})

    test_case = BFCLTestCase(
        id="irrelevant_1",
        category=BFCLCategory.IRRELEVANCE,
        question="Tell me a joke.",
        functions=[],
        expected_calls=[],
        is_relevant=False,
    )

    with patch.object(OpenClawClient, "send_message", _fake_send):
        calls, _raw_response, _latency_ms = _run(agent.query(test_case))

    assert captured["context"]["tool_choice"] == "none"
    assert captured["context"]["temperature"] == 0.0
    assert calls == []
