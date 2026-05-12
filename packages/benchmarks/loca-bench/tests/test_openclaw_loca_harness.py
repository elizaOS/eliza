from __future__ import annotations

from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

OPENCLAW_ADAPTER_ROOT = Path(__file__).resolve().parents[2] / "openclaw-adapter"
if str(OPENCLAW_ADAPTER_ROOT) not in sys.path:
    sys.path.insert(0, str(OPENCLAW_ADAPTER_ROOT))

from eliza_loca import harness_proxy


def test_openclaw_loca_default_path_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCHMARK_HARNESS", "openclaw")
    monkeypatch.delenv("LOCA_OPENCLAW_MODE", raising=False)

    with pytest.raises(harness_proxy.UnsupportedHarnessPath, match="single --message"):
        harness_proxy._build_client()


def test_openclaw_loca_direct_mode_is_explicit_native_smoke(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCHMARK_HARNESS", "openclaw")
    monkeypatch.setenv("LOCA_OPENCLAW_MODE", "direct-openai-compatible")

    client = harness_proxy._build_client()

    assert client.direct_openai_compatible is True


def test_loca_context_preserves_full_messages_tools_and_generation_options() -> None:
    payload = {
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "find order"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": '{"id":1}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "found"},
        ],
        "tools": [{"type": "function", "function": {"name": "lookup"}}],
        "tool_choice": "required",
        "max_tokens": 77,
        "reasoning_effort": "low",
    }

    context = harness_proxy._context_from_payload(payload, "sess-1")

    assert context["messages"] == payload["messages"]
    assert context["tools"] == payload["tools"]
    assert context["tool_choice"] == "required"
    assert context["max_tokens"] == 77
    assert context["reasoning_effort"] == "low"
    assert context["session_id"] == "sess-1"


def test_openclaw_loca_response_metadata_labels_adapter_path() -> None:
    response = SimpleNamespace(
        text="",
        params={
            "tool_calls": [{"id": "c1", "name": "lookup", "arguments": {"id": 1}}],
            "_meta": {
                "openclaw_adapter": {
                    "transport": "direct_openai_compatible",
                    "path_label": "openclaw-direct-openai-compatible-provider",
                    "preserves_full_messages": True,
                }
            },
        },
    )

    payload = harness_proxy._chat_completion_payload(
        {"model": "gpt-oss-120b"},
        response,
        harness_name="openclaw",
    )

    assert payload["choices"][0]["finish_reason"] == "tool_calls"
    metadata = payload["benchmark_metadata"]
    assert metadata["benchmark_harness"] == "openclaw"
    assert metadata["adapter"] == "openclaw-adapter"
    assert metadata["openclaw_adapter"]["preserves_full_messages"] is True
