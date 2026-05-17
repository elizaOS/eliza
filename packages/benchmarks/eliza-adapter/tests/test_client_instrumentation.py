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

    assert response.params["usage"] == {
        "promptTokens": 100,
        "completionTokens": 12,
        "totalTokens": 112,
        "cachedTokens": 25,
    }
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
    assert record["prompt_tokens"] == 100
    assert record["completion_tokens"] == 12
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
