"""Tests for the per-benchmark factory builders."""

from __future__ import annotations

import inspect
import json
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from openclaw_adapter import (
    build_bfcl_agent_fn,
    build_clawbench_agent_fn,
    build_lifeops_bench_agent_fn,
)
from openclaw_adapter.client import OpenClawClient


def _fake_completed(stdout: str, rc: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["openclaw"], returncode=rc, stdout=stdout, stderr=""
    )


@pytest.fixture
def fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "openclaw"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    return binary


@pytest.fixture
def client(fake_binary: Path) -> OpenClawClient:
    return OpenClawClient(binary_path=fake_binary)


def test_build_clawbench_agent_fn_returns_callable(client: OpenClawClient) -> None:
    scenario_yaml = {
        "name": "inbox_triage",
        "prompt": "Triage the inbox.",
    }
    agent_fn = build_clawbench_agent_fn(
        client=client,
        scenario_yaml=scenario_yaml,
        fixtures={"inbox": [{"id": 1}]},
    )
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_build_bfcl_agent_fn_returns_callable(client: OpenClawClient) -> None:
    agent_fn = build_bfcl_agent_fn(client=client)
    assert callable(agent_fn)
    assert inspect.iscoroutinefunction(agent_fn)


def test_clawbench_agent_fn_executes_synchronously(client: OpenClawClient) -> None:
    """Drive the async ``agent_fn`` by running it via ``asyncio.run`` so we
    don't depend on pytest-asyncio being installed."""
    import asyncio

    scenario_yaml = {"prompt": "Be terse."}
    fixtures = {"inbox": ["e1", "e2"]}
    agent_fn = build_clawbench_agent_fn(
        client=client,
        scenario_yaml=scenario_yaml,
        fixtures=fixtures,
        model_name="gpt-oss-120b",
    )
    history = [{"role": "user", "content": "Triage now"}]
    response_payload = json.dumps(
        {
            "reply": "Done",
            "tool_calls": [{"id": "c1", "name": "EMAIL_SUMMARY", "arguments": {}}],
        }
    )
    captured: dict[str, Any] = {}

    def _fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured["argv"] = argv
        return _fake_completed(response_payload)

    with patch("openclaw_adapter.client.subprocess.run", side_effect=_fake_run):
        result = asyncio.run(agent_fn(history, [{"type": "function", "function": {"name": "T"}}]))

    assert result["text"] == "Done"
    assert result["tool_calls"][0]["name"] == "EMAIL_SUMMARY"
    assert result["model_name"] == "gpt-oss-120b"
    # The composed message must contain the fixture JSON + the user text +
    # the scenario prompt so OpenClaw sees everything.
    msg_arg = captured["argv"][captured["argv"].index("--message") + 1]
    assert "Be terse." in msg_arg
    assert "Triage now" in msg_arg
    assert '"inbox"' in msg_arg


def test_bfcl_agent_fn_returns_first_tool_call(client: OpenClawClient) -> None:
    import asyncio

    agent_fn = build_bfcl_agent_fn(client=client)
    payload = json.dumps(
        {
            "reply": "",
            "tool_calls": [
                {"id": "c1", "name": "ADD", "arguments": {"a": 1, "b": 2}},
                {"id": "c2", "name": "SUB", "arguments": {"a": 5, "b": 1}},
            ],
        }
    )
    with patch("openclaw_adapter.client.subprocess.run") as mock_run:
        mock_run.return_value = _fake_completed(payload)
        result = asyncio.run(agent_fn("add 1+2", [{"type": "function", "function": {"name": "ADD"}}]))
    assert result["name"] == "ADD"
    assert result["arguments"] == {"a": 1, "b": 2}
    assert len(result["tool_calls"]) == 2


def test_lifeops_bench_factory_requires_snapshot(client: OpenClawClient, tmp_path: Path) -> None:
    """Builder raises eagerly when the snapshot path is missing."""
    pytest.importorskip(
        "eliza_lifeops_bench.types",
        reason="LifeOpsBench types package not on sys.path",
    )
    with pytest.raises(FileNotFoundError):
        build_lifeops_bench_agent_fn(
            client=client,
            world_snapshot_path=str(tmp_path / "no-such.json"),
        )


def test_lifeops_bench_factory_loads_snapshot(client: OpenClawClient, tmp_path: Path) -> None:
    pytest.importorskip(
        "eliza_lifeops_bench.types",
        reason="LifeOpsBench types package not on sys.path",
    )
    snapshot = tmp_path / "world.json"
    snapshot.write_text(json.dumps({"agenda": [], "inbox": []}))
    agent_fn = build_lifeops_bench_agent_fn(
        client=client,
        world_snapshot_path=str(snapshot),
    )
    assert callable(agent_fn)
