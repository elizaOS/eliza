"""Tests for OpenClaw BFCL response normalization."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import patch

from openclaw_adapter.bfcl import OpenClawBFCLAgent
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
    assert function["name"] == "sql_execute"
    assert "Original BFCL function name: sql.execute." in function["description"]
    assert calls == [FunctionCall(name="sql.execute", arguments={"table_name": "Orders"})]
    assert '"sql_execute": "sql.execute"' in raw_response
    assert latency_ms >= 0
