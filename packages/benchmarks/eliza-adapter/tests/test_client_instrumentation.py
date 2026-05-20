from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_adapter.client import ElizaClient


def _client(monkeypatch) -> ElizaClient:
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)
    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    return ElizaClient(base_url="http://test.local", token="t")


def test_send_message_preserves_usage_tool_calls_metadata_and_telemetry(
    monkeypatch,
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry))
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "cerebras")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "gpt-oss-120b")
    monkeypatch.setenv("BENCHMARK_TASK_AGENT", "opencode")
    monkeypatch.setenv("ELIZA_ACP_DEFAULT_AGENT", "opencode")
    monkeypatch.setenv("ELIZA_DEFAULT_AGENT_TYPE", "opencode")
    monkeypatch.setenv("ELIZA_AGENT_SELECTION_STRATEGY", "fixed")
    client = _client(monkeypatch)
    get_calls: list[str] = []

    def fake_post(path: str, body: dict[str, object]) -> dict[str, object]:
        assert path == "/api/benchmark/message"
        assert body["context"] == {
            "benchmark": "loca_bench",
            "task_id": "task-1",
            "session_id": "sess-1",
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "mail.search", "parameters": {}},
                }
            ],
        }
        return {
            "text": "done csk-redaction-test-token-000000000000",
            "thought": "called tool",
            "actions": ["BENCHMARK_ACTION"],
            "params": {},
            "captured_actions": [
                {
                    "params": {
                        "tool_name": "mail.search",
                        "arguments": {"query": "from:boss"},
                    }
                }
            ],
            "tool_calls": [
                {
                    "id": "call_benchmark_0",
                    "type": "function",
                    "function": {
                        "name": "mail.search",
                        "arguments": '{"query":"from:boss"}',
                    },
                }
            ],
            "usage": {
                "promptTokens": 100,
                "completionTokens": 12,
                "totalTokens": 112,
                "cachedTokens": 25,
            },
            "metadata": {
                "agent_label": "eliza",
                "trajectory_step": 3,
                "native_trajectory_step_id": "native-step-3",
                "trajectory_endpoint": "/api/benchmark/trajectory?benchmark=loca_bench&task_id=task-1",
                "diagnostics_endpoint": "/api/benchmark/diagnostics?benchmark=loca_bench&task_id=task-1",
                "compaction_strategy": "hybrid-ledger",
                "compaction_threshold_tokens": 12000,
            },
        }

    client._post = fake_post  # type: ignore[method-assign]

    def fake_get(path: str) -> dict[str, object]:
        get_calls.append(path)
        return {
            "status": "ok",
            "steps": [
                {
                    "step": 3,
                    "nativeTrajectory": {
                        "steps": [
                            {
                                "llmCalls": [
                                    {
                                        "messages": [{"role": "user", "content": "please search"}],
                                        "tools": [{"function": {"name": "mail.search"}}],
                                        "response": "tool call",
                                    }
                                ]
                            }
                        ]
                    },
                }
            ],
        }

    client._get = fake_get  # type: ignore[method-assign]

    response = client.send_message(
        "please search",
        context={
            "benchmark": "loca_bench",
            "task_id": "task-1",
            "session_id": "sess-1",
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "mail.search", "parameters": {}},
                }
            ],
        },
    )

    assert {
        key: response.params["usage"][key]
        for key in ("promptTokens", "completionTokens", "totalTokens", "cachedTokens")
    } == {
        "promptTokens": 100,
        "completionTokens": 12,
        "totalTokens": 112,
        "cachedTokens": 25,
    }
    assert response.params["usage"]["prompt_tokens"] == 100
    assert response.params["usage"]["completion_tokens"] == 12
    assert response.params["usage"]["total_tokens"] == 112
    assert response.params["usage"]["cache_read_input_tokens"] == 25
    assert response.params["tool_calls"] == [
        {
            "id": "call_benchmark_0",
            "type": "function",
            "function": {
                "name": "mail.search",
                "arguments": '{"query":"from:boss"}',
            },
        }
    ]
    assert response.metadata["agent_label"] == "eliza"
    assert response.params["_eliza_trajectory_snapshot"] == {
        "status": "ok",
        "steps": [
            {
                "step": 3,
                "nativeTrajectory": {
                    "steps": [
                        {
                            "llmCalls": [
                                {
                                    "messages": [{"role": "user", "content": "please search"}],
                                    "tools": [{"function": {"name": "mail.search"}}],
                                    "response": "tool call",
                                }
                            ]
                        }
                    ]
                },
            }
        ],
    }
    assert get_calls == [
        "/api/benchmark/trajectory?benchmark=loca_bench&task_id=task-1"
    ]

    records = [json.loads(line) for line in telemetry.read_text().splitlines()]
    assert len(records) == 1
    record = records[0]
    assert record["agent_label"] == "eliza"
    assert record["benchmark_task_agent"] == "opencode"
    assert record["acp_default_agent"] == "opencode"
    assert record["default_agent_type"] == "opencode"
    assert record["agent_selection_strategy"] == "fixed"
    assert record["prompt_tokens"] == 100
    assert record["completion_tokens"] == 12
    assert record["duration_ms"] == record["latency_ms"]
    assert record["response_chars"] == len("done csk-redaction-test-token-000000000000")
    assert record["cache_read_input_tokens"] == 25
    assert record["tool_schema_count"] == 1
    assert record["tool_names"] == ["mail.search"]
    assert record["tool_call_count"] == 1
    assert record["trajectory_step"] == 3
    assert record["native_trajectory_step_id"] == "native-step-3"
    assert record["trajectory_snapshot"]["steps"][0]["nativeTrajectory"]["steps"][0][
        "llmCalls"
    ][0]["tools"][0]["function"]["name"] == "mail.search"
    assert record["compaction_strategy"] == "hybrid-ledger"
    assert "csk-redaction-test" not in record["response_text"]
    assert "[REDACTED]" in record["response_text"]


def test_send_message_telemetry_normalizes_nested_usage_shapes(
    monkeypatch,
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry))
    client = _client(monkeypatch)

    responses = [
        {
            "text": "ok",
            "params": {
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 20,
                    "prompt_tokens_details": {"cached_tokens": 30},
                    "cache_creation_input_tokens": 7,
                }
            },
        },
        {
            "text": "ok",
            "params": {
                "usage": {
                    "tokens": {
                        "input": 80,
                        "output": 10,
                        "total": 90,
                        "cache": {"read": 0, "write": 4},
                    }
                }
            },
        },
    ]

    def fake_post(path: str, body: dict[str, object]) -> dict[str, object]:
        del path, body
        return responses.pop(0)

    client._post = fake_post  # type: ignore[method-assign]
    client.send_message("first", context={"benchmark": "x", "task_id": "a"})
    client.send_message("second", context={"benchmark": "x", "task_id": "b"})

    records = [json.loads(line) for line in telemetry.read_text().splitlines()]
    assert records[0]["prompt_tokens"] == 100
    assert records[0]["completion_tokens"] == 20
    assert records[0]["total_tokens"] == 120
    assert records[0]["cache_read_input_tokens"] == 30
    assert records[0]["cache_creation_input_tokens"] == 7
    assert records[1]["prompt_tokens"] == 80
    assert records[1]["completion_tokens"] == 10
    assert records[1]["total_tokens"] == 90
    assert records[1]["cache_read_input_tokens"] == 0
    assert records[1]["cache_creation_input_tokens"] == 4


def test_send_message_promotes_meta_usage_for_downstream_metrics(
    monkeypatch,
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry))
    client = _client(monkeypatch)

    def fake_post(path: str, body: dict[str, object]) -> dict[str, object]:
        del path, body
        return {
            "text": "ok",
            "params": {
                "_meta": {
                    "usage": {
                        "promptTokens": 55,
                        "completionTokens": 5,
                        "prompt_tokens_details": {
                            "cached_tokens": 11,
                            "cache_write_tokens": 3,
                        },
                    }
                }
            },
        }

    client._post = fake_post  # type: ignore[method-assign]

    response = client.send_message("meta usage", context={"benchmark": "x", "task_id": "a"})

    assert response.params["usage"]["prompt_tokens"] == 55
    assert response.params["usage"]["completion_tokens"] == 5
    assert response.params["usage"]["total_tokens"] == 60
    assert response.params["usage"]["cache_read_input_tokens"] == 11
    assert response.params["usage"]["cache_creation_input_tokens"] == 3

    record = json.loads(telemetry.read_text().splitlines()[0])
    assert record["prompt_tokens"] == 55
    assert record["completion_tokens"] == 5
    assert record["total_tokens"] == 60
    assert record["cache_read_input_tokens"] == 11
    assert record["cache_creation_input_tokens"] == 3


def test_client_fetches_trajectory_and_diagnostics(monkeypatch) -> None:
    client = _client(monkeypatch)
    calls: list[str] = []

    def fake_get(path: str) -> dict[str, Any]:
        calls.append(path)
        return {"status": "ok", "path": path}

    client._get = fake_get  # type: ignore[method-assign]

    assert client.trajectory(benchmark="loca_bench", task_id="task 1")["status"] == "ok"
    assert client.diagnostics(benchmark="loca_bench", task_id="task 1")["status"] == "ok"
    assert calls == [
        "/api/benchmark/trajectory?benchmark=loca_bench&task_id=task+1",
        "/api/benchmark/diagnostics?benchmark=loca_bench&task_id=task+1",
    ]
