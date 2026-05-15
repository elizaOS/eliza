from __future__ import annotations

import pytest

from elizaos_tau_bench import model_client


def test_completion_response_matches_litellm_message_shape():
    res = model_client.CompletionResponse(
        model_client.CompletionMessage(
            content="hello",
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "think", "arguments": "{}"},
                }
            ],
        ),
        response_cost=0.25,
    )

    assert res.choices[0].message.content == "hello"
    assert res.choices[0].message.model_dump()["tool_calls"][0]["id"] == "call_1"
    assert res._hidden_params["response_cost"] == 0.25


def test_openai_compatible_adapter_maps_chat_completion_response(monkeypatch):
    calls = []

    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "done",
                            "tool_calls": None,
                        }
                    }
                ],
                "usage": {"response_cost": 0.01},
            }

    class _Client:
        def __init__(self, timeout):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers, json):
            calls.append((url, headers, json))
            return _Response()

    monkeypatch.setattr(model_client.httpx, "Client", _Client)
    monkeypatch.setenv("TAU_BENCH_OPENAI_BASE_URL", "http://fake.local/v1")
    monkeypatch.setenv("TAU_BENCH_OPENAI_API_KEY", "test-key")

    res = model_client._openai_compatible_completion(
        model="local-model",
        custom_llm_provider="openai-compatible",
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"type": "function", "function": {"name": "think"}}],
        temperature=0.2,
    )

    assert res.choices[0].message.content == "done"
    assert res._hidden_params["response_cost"] == 0.01
    assert calls[0][0] == "http://fake.local/v1/chat/completions"
    assert calls[0][2]["tools"][0]["function"]["name"] == "think"


def test_completion_routes_local_provider_to_openai_compatible_adapter(monkeypatch):
    called = {}

    def fake_openai_compatible_completion(**kwargs):
        called.update(kwargs)
        return model_client.CompletionResponse(model_client.CompletionMessage(content="local"))

    monkeypatch.setattr(
        model_client,
        "_openai_compatible_completion",
        fake_openai_compatible_completion,
    )

    res = model_client.completion(
        model="llama",
        custom_llm_provider="llama.cpp",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert res.choices[0].message.content == "local"
    assert called["custom_llm_provider"] == "llama.cpp"


def test_missing_litellm_without_endpoint_has_actionable_error(monkeypatch):
    monkeypatch.delenv("TAU_BENCH_OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)

    with pytest.raises(model_client.MissingModelClientDependency) as exc:
        model_client._openai_compatible_completion(
            model="gpt-4o",
            custom_llm_provider="openai",
            messages=[{"role": "user", "content": "hi"}],
        )

    assert "Install litellm" in str(exc.value)
