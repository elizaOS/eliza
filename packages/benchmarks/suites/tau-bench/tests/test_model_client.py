from __future__ import annotations

import sys

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
    _clear_base_url_env(monkeypatch)

    with pytest.raises(model_client.MissingModelClientDependency) as exc:
        model_client._openai_compatible_completion(
            model="gpt-4o",
            custom_llm_provider="openai",
            messages=[{"role": "user", "content": "hi"}],
        )

    assert "Install litellm" in str(exc.value)


_BASE_URL_ENV_VARS = (
    "TAU_BENCH_OPENAI_BASE_URL",
    "BENCHMARK_BASE_URL",
    "OPENAI_BASE_URL",
    "CEREBRAS_BASE_URL",
    "LLAMA_CPP_BASE_URL",
)


def _clear_base_url_env(monkeypatch):
    for var in _BASE_URL_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


class TestResolveBaseUrl:
    """Operator-exported env must win over hardcoded provider defaults."""

    def test_cerebras_full_precedence_chain(self, monkeypatch):
        _clear_base_url_env(monkeypatch)
        monkeypatch.setenv("CEREBRAS_BASE_URL", "https://cerebras.example/v1")
        assert model_client.resolve_base_url("cerebras") == "https://cerebras.example/v1"

        monkeypatch.setenv("OPENAI_BASE_URL", "https://openai.example/v1")
        assert model_client.resolve_base_url("cerebras") == "https://openai.example/v1"

        monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
        assert model_client.resolve_base_url("cerebras") == "https://elizacloud.ai/api/v1"

        monkeypatch.setenv("TAU_BENCH_OPENAI_BASE_URL", "https://tau.example/v1")
        assert model_client.resolve_base_url("cerebras") == "https://tau.example/v1"

    def test_cerebras_without_env_returns_none_for_provider_default(self, monkeypatch):
        # No env set → None → LiteLLM's own provider default is the fallback.
        _clear_base_url_env(monkeypatch)
        assert model_client.resolve_base_url("cerebras") is None

    def test_openai_honors_benchmark_base_url(self, monkeypatch):
        _clear_base_url_env(monkeypatch)
        monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
        assert model_client.resolve_base_url("openai") == "https://elizacloud.ai/api/v1"

    def test_openai_ignores_cerebras_specific_base_url(self, monkeypatch):
        _clear_base_url_env(monkeypatch)
        monkeypatch.setenv("CEREBRAS_BASE_URL", "https://cerebras.example/v1")
        assert model_client.resolve_base_url("openai") is None

    def test_non_openai_dialect_provider_ignores_openai_base_url(self, monkeypatch):
        # A globally-exported OPENAI_BASE_URL must not hijack e.g. anthropic.
        _clear_base_url_env(monkeypatch)
        monkeypatch.setenv("OPENAI_BASE_URL", "https://openai.example/v1")
        assert model_client.resolve_base_url("anthropic") is None
        monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
        assert model_client.resolve_base_url("anthropic") == "https://elizacloud.ai/api/v1"

    def test_local_provider_keeps_llama_cpp_chain(self, monkeypatch):
        _clear_base_url_env(monkeypatch)
        assert model_client.resolve_base_url("llama.cpp") == "http://127.0.0.1:8080/v1"
        monkeypatch.setenv("LLAMA_CPP_BASE_URL", "http://10.0.0.2:8080/v1")
        assert model_client.resolve_base_url("llama.cpp") == "http://10.0.0.2:8080/v1"
        monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
        assert model_client.resolve_base_url("llama.cpp") == "https://elizacloud.ai/api/v1"


class _FakeLiteLLM:
    """Stands in for the litellm module import inside completion()."""

    def __init__(self):
        self.calls = []

    def completion(self, **kwargs):
        self.calls.append(kwargs)
        return model_client.CompletionResponse(
            model_client.CompletionMessage(content="via-litellm")
        )


def test_litellm_path_passes_resolved_api_base_explicitly(monkeypatch):
    _clear_base_url_env(monkeypatch)
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
    fake = _FakeLiteLLM()
    monkeypatch.setitem(sys.modules, "litellm", fake)

    res = model_client.completion(
        model="gemma-4-31b",
        custom_llm_provider="cerebras",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert res.choices[0].message.content == "via-litellm"
    assert fake.calls[0]["api_base"] == "https://elizacloud.ai/api/v1"


def test_litellm_path_does_not_clobber_caller_api_base(monkeypatch):
    _clear_base_url_env(monkeypatch)
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
    fake = _FakeLiteLLM()
    monkeypatch.setitem(sys.modules, "litellm", fake)

    model_client.completion(
        model="gemma-4-31b",
        custom_llm_provider="cerebras",
        api_base="https://per-run.example/v1",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert fake.calls[0]["api_base"] == "https://per-run.example/v1"


def test_litellm_path_without_env_leaves_provider_default(monkeypatch):
    _clear_base_url_env(monkeypatch)
    fake = _FakeLiteLLM()
    monkeypatch.setitem(sys.modules, "litellm", fake)

    model_client.completion(
        model="gemma-4-31b",
        custom_llm_provider="cerebras",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert "api_base" not in fake.calls[0]


def test_fallback_path_routes_cerebras_through_proxy_env(monkeypatch):
    """Without litellm, provider=cerebras must hit the operator's proxy URL."""
    _clear_base_url_env(monkeypatch)
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
    monkeypatch.delenv("TAU_BENCH_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("CEREBRAS_API_KEY", "cloud-key")
    # Simulate litellm being uninstalled so completion() takes the HTTP path.
    monkeypatch.setitem(sys.modules, "litellm", None)

    calls = []

    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {"message": {"role": "assistant", "content": "ok", "tool_calls": None}}
                ],
                "usage": {},
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

    res = model_client.completion(
        model="gemma-4-31b",
        custom_llm_provider="cerebras",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert res.choices[0].message.content == "ok"
    assert calls[0][0] == "https://elizacloud.ai/api/v1/chat/completions"
    assert calls[0][1]["Authorization"] == "Bearer cloud-key"


def test_fallback_path_cerebras_without_any_endpoint_raises(monkeypatch):
    _clear_base_url_env(monkeypatch)
    monkeypatch.setitem(sys.modules, "litellm", None)

    with pytest.raises(model_client.MissingModelClientDependency):
        model_client.completion(
            model="gemma-4-31b",
            custom_llm_provider="cerebras",
            messages=[{"role": "user", "content": "hi"}],
        )
