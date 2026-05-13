from __future__ import annotations

from types import SimpleNamespace

from eliza_loca.harness_proxy import (
    _chat_completion_payload,
    _context_from_payload,
    _eliza_prompt_from_payload,
)


def test_loca_harness_context_preserves_full_messages_tools_and_generation_options() -> None:
    payload = {
        "messages": [
            {"role": "system", "content": "system instructions"},
            {"role": "user", "content": "first"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": "{}"},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "name": "lookup", "content": "facts"},
            {"role": "user", "content": "continue"},
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "lookup",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        "tool_choice": "auto",
        "temperature": 0.1,
        "max_tokens": 512,
        "reasoning_effort": "low",
    }

    context = _context_from_payload(payload, "session_1")

    assert context["messages"] == payload["messages"]
    assert context["tools"] == payload["tools"]
    assert context["tool_choice"] == "auto"
    assert context["temperature"] == 0.1
    assert context["max_tokens"] == 512
    assert context["reasoning_effort"] == "low"
    assert context["system_prompt"] == "system instructions"
    assert context["task_id"] == "session_1"
    assert context["session_id"] == "session_1"


def test_loca_harness_accepts_nested_or_legacy_function_tools() -> None:
    payload = {
        "messages": [{"role": "user", "content": "continue"}],
        "functions": [
            [
                {
                    "type": "function",
                    "function": {
                        "name": "filesystem_list_directory",
                        "parameters": {"type": "object"},
                    },
                }
            ]
        ],
    }

    context = _context_from_payload(payload, "session_2")
    prompt = _eliza_prompt_from_payload(payload)

    assert context["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "filesystem_list_directory",
                "parameters": {"type": "object"},
            },
        }
    ]
    assert "filesystem_list_directory" in prompt
    assert "process_assignments_and_quizzes" in prompt


def test_loca_harness_response_marks_hermes_native_tool_calls(monkeypatch) -> None:
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "cerebras")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "gpt-oss-120b")
    response = SimpleNamespace(
        text="",
        params={
            "tool_calls": [
                {
                    "id": "call_1",
                    "name": "lookup",
                    "arguments": {"query": "ORCHID-17"},
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
        },
    )

    payload = _chat_completion_payload(
        {"model": "gpt-oss-120b"},
        response,
        harness_name="hermes",
    )

    assert payload["choices"][0]["finish_reason"] == "tool_calls"
    assert payload["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "lookup"
    assert payload["benchmark_metadata"]["benchmark_harness"] == "hermes"
    assert payload["benchmark_metadata"]["adapter"] == "hermes-adapter"
    assert payload["benchmark_metadata"]["native_tool_calls"] is True
    assert payload["benchmark_metadata"]["tool_call_count"] == 1
    assert payload["benchmark_metadata"]["usage"]["total_tokens"] == 13
