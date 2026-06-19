"""Offline unit tests for SmithersClient payload/response handling."""

from __future__ import annotations

import json
from pathlib import Path

from smithers_adapter.client import (
    MessageResponse,
    SmithersClient,
    resolve_install_dir,
)


def _client(tmp_path: Path) -> SmithersClient:
    # Point at a throwaway dir so no real install is required for offline tests.
    return SmithersClient(install_dir=tmp_path, provider="cerebras", model="gpt-oss-120b", api_key="k")


def test_build_payload_defaults_reasoning_low_for_gpt_oss(tmp_path: Path) -> None:
    client = _client(tmp_path)
    payload = client.build_payload("hi", None)
    assert payload["model"] == "gpt-oss-120b"
    assert payload["provider"] == "cerebras"
    assert payload["base_url"] == "https://api.cerebras.ai/v1"
    assert payload["reasoning_effort"] == "low"
    assert payload["api_key"] == "k"


def test_build_payload_passes_tools_and_tool_choice(tmp_path: Path) -> None:
    client = _client(tmp_path)
    tools = [{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}]
    payload = client.build_payload(
        "do it",
        {"tools": tools, "tool_choice": "required", "temperature": 0.0, "system_prompt": "sp"},
    )
    assert payload["tools"] == tools
    assert payload["tool_choice"] == "required"
    assert payload["temperature"] == 0.0
    assert payload["system_prompt"] == "sp"


def test_parse_response_extracts_fields() -> None:
    raw = {
        "text": "hello",
        "thought": "thinking",
        "actions": ["get_weather"],
        "params": {"tool_calls": [{"id": "1", "name": "get_weather", "arguments": "{}"}], "usage": {}},
    }
    resp = SmithersClient._parse_response(raw)
    assert isinstance(resp, MessageResponse)
    assert resp.text == "hello"
    assert resp.thought == "thinking"
    assert resp.actions == ["get_weather"]
    assert resp.params["tool_calls"][0]["name"] == "get_weather"


def test_parse_response_falls_back_to_thought_when_text_empty() -> None:
    resp = SmithersClient._parse_response({"text": "", "thought": "reasoned", "actions": [], "params": {}})
    assert resp.text == "reasoned"


def test_reset_records_task_and_benchmark(tmp_path: Path) -> None:
    client = _client(tmp_path)
    out = client.reset(task_id="t1", benchmark="bfcl")
    assert out["task_id"] == "t1"
    assert client._task_id == "t1"
    assert client._benchmark == "bfcl"


def test_resolve_install_dir_prefers_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SMITHERS_DIR", str(tmp_path))
    assert resolve_install_dir() == tmp_path


def test_materialize_script_writes_harness(tmp_path: Path) -> None:
    client = _client(tmp_path)
    target = client.materialize_script()
    assert target.name == "smithers_turn.mjs"
    assert target.exists()
    assert "OpenAIAgent" in target.read_text(encoding="utf-8")


def test_build_command_shape(tmp_path: Path) -> None:
    client = _client(tmp_path)
    # bun may be absent in CI; only assert structure when resolvable.
    try:
        cmd = client.build_command()
    except FileNotFoundError:
        return
    assert cmd[1] == "run"
    assert cmd[-1].endswith("smithers_turn.mjs")
