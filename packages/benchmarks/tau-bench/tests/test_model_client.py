"""Tests for the tau-bench OpenAI-compatible completion shim."""

from __future__ import annotations

import json
from typing import Any

import pytest

from elizaos_tau_bench import model_client


class _FakeHTTPResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def __enter__(self) -> "_FakeHTTPResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def test_completion_parses_content_and_tool_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(req, timeout):  # type: ignore[no-untyped-def]
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["payload"] = json.loads(req.data.decode("utf-8"))
        return _FakeHTTPResponse(
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "lookup",
                                        "arguments": "{\"id\":\"u1\"}",
                                    },
                                }
                            ],
                        }
                    }
                ],
                "usage": {"total_tokens": 12},
            }
        )

    monkeypatch.setenv("CEREBRAS_API_KEY", "test-key")
    monkeypatch.setattr(model_client.urllib.request, "urlopen", fake_urlopen)

    response = model_client.completion(
        model="gpt-oss-120b",
        custom_llm_provider="cerebras",
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"type": "function", "function": {"name": "lookup"}}],
        temperature=0.0,
        max_retries=0,
    )

    assert captured["url"] == "https://api.cerebras.ai/v1/chat/completions"
    assert captured["payload"]["model"] == "gpt-oss-120b"
    assert captured["payload"]["tools"][0]["function"]["name"] == "lookup"
    message = response.choices[0].message
    assert message.content is None
    assert message.model_dump()["tool_calls"][0]["function"]["name"] == "lookup"
    assert response._hidden_params["response_cost"] == 0.0


def test_completion_reports_missing_provider_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)

    with pytest.raises(ValueError, match="CEREBRAS_API_KEY"):
        model_client.completion(
            model="gpt-oss-120b",
            custom_llm_provider="cerebras",
            messages=[{"role": "user", "content": "hi"}],
        )
