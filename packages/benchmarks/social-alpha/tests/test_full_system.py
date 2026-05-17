"""Regression tests for Social Alpha LLM harness routing."""

from benchmark.systems.full_system import _resolve_llm_endpoint


def _clear_llm_env(monkeypatch) -> None:
    for key in (
        "BENCHMARK_MODEL_PROVIDER",
        "CEREBRAS_API_KEY",
        "CEREBRAS_BASE_URL",
        "GROQ_API_KEY",
        "GROQ_BASE_URL",
        "MODEL_PROVIDER",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENROUTER_API_KEY",
        "OPENROUTER_BASE_URL",
        "VLLM_API_KEY",
        "VLLM_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)


def test_groq_endpoint_uses_groq_key_without_openai_key(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("GROQ_API_KEY", "groq-test-key")

    endpoint = _resolve_llm_endpoint("groq/llama-3.3-70b-versatile")

    assert endpoint.provider == "groq"
    assert endpoint.model == "llama-3.3-70b-versatile"
    assert endpoint.api_key == "groq-test-key"
    assert endpoint.base_url == "https://api.groq.com/openai/v1"


def test_openai_base_url_override_is_honored(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:8001/v1")

    endpoint = _resolve_llm_endpoint("openai/gpt-oss-120b")

    assert endpoint.provider == "openai"
    assert endpoint.model == "gpt-oss-120b"
    assert endpoint.api_key == "openai-test-key"
    assert endpoint.base_url == "http://127.0.0.1:8001/v1"


def test_api_base_can_select_openai_compatible_provider(monkeypatch) -> None:
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1")
    monkeypatch.setenv("GROQ_API_KEY", "groq-test-key")

    endpoint = _resolve_llm_endpoint("llama-3.3-70b-versatile")

    assert endpoint.provider == "groq"
    assert endpoint.model == "llama-3.3-70b-versatile"
    assert endpoint.api_key == "groq-test-key"
