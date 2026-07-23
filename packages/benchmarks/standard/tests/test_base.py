"""Tests for the shared adapter base (``benchmarks.standard._base``)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from benchmarks.standard._base import (
    BenchmarkResult,
    ChatMessage,
    ENDPOINT_ENV_CHAIN,
    GenerationConfig,
    GenerationResult,
    HarnessClient,
    MockClient,
    PROVIDER_BASE_URLS,
    make_client,
    resolve_api_key,
    resolve_endpoint,
)


@pytest.fixture(autouse=True)
def _clear_endpoint_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Endpoint resolution reads operator env; strip it so each test states
    exactly which overrides are set (campaign shells export all three)."""

    for name in ENDPOINT_ENV_CHAIN:
        monkeypatch.delenv(name, raising=False)


def test_resolve_endpoint_prefers_explicit_url() -> None:
    assert resolve_endpoint(model_endpoint="http://x/v1", provider="openai") == "http://x/v1"


def test_resolve_endpoint_explicit_url_beats_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://elizacloud.ai/api/v1")
    assert resolve_endpoint(model_endpoint="http://x/v1", provider="cerebras") == "http://x/v1"


def test_resolve_endpoint_env_chain_order(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCHMARK_BASE_URL", "https://bench.example/v1")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://openai-env.example/v1")
    monkeypatch.setenv("CEREBRAS_BASE_URL", "https://cerebras-env.example/v1")
    assert (
        resolve_endpoint(model_endpoint=None, provider="cerebras")
        == "https://bench.example/v1"
    )
    monkeypatch.delenv("BENCHMARK_BASE_URL")
    assert (
        resolve_endpoint(model_endpoint=None, provider="cerebras")
        == "https://openai-env.example/v1"
    )
    monkeypatch.delenv("OPENAI_BASE_URL")
    assert (
        resolve_endpoint(model_endpoint=None, provider="cerebras")
        == "https://cerebras-env.example/v1"
    )
    monkeypatch.delenv("CEREBRAS_BASE_URL")
    assert (
        resolve_endpoint(model_endpoint=None, provider="cerebras")
        == PROVIDER_BASE_URLS["cerebras"]
    )


def test_resolve_endpoint_env_beats_provider_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CEREBRAS_BASE_URL", "https://elizacloud.ai/api/v1")
    assert (
        resolve_endpoint(model_endpoint=None, provider="cerebras")
        == "https://elizacloud.ai/api/v1"
    )


def test_resolve_endpoint_env_resolves_without_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_BASE_URL", "https://elizacloud.ai/api/v1")
    assert (
        resolve_endpoint(model_endpoint=None, provider=None)
        == "https://elizacloud.ai/api/v1"
    )


def test_resolve_endpoint_ignores_blank_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCHMARK_BASE_URL", "   ")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    assert (
        resolve_endpoint(model_endpoint=None, provider="openai")
        == PROVIDER_BASE_URLS["openai"]
    )


def test_resolve_endpoint_uses_provider_map() -> None:
    assert resolve_endpoint(model_endpoint=None, provider="openai") == PROVIDER_BASE_URLS["openai"]


def test_resolve_endpoint_rejects_unknown_provider() -> None:
    with pytest.raises(ValueError):
        resolve_endpoint(model_endpoint=None, provider="not-a-real-provider")


def test_resolve_endpoint_rejects_when_nothing_given() -> None:
    with pytest.raises(ValueError):
        resolve_endpoint(model_endpoint=None, provider=None)


def test_resolve_api_key_uses_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MY_KEY", "secret123")
    assert resolve_api_key("MY_KEY") == "secret123"


def test_resolve_api_key_defaults_to_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("UNSET_KEY", raising=False)
    assert resolve_api_key("UNSET_KEY") == "EMPTY"


def test_mock_client_cycles_through_responses() -> None:
    client = MockClient(["a", "b"])
    cfg = GenerationConfig(model="m", max_tokens=1, temperature=0.0)
    msg = [ChatMessage(role="user", content="hi")]
    assert client.generate(msg, cfg).text == "a"
    assert client.generate(msg, cfg).text == "b"
    assert client.generate(msg, cfg).text == "a"  # wraps around


def test_harness_client_assigns_unique_standard_task_ids() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.contexts: list[dict[str, object]] = []

        def wait_until_ready(self, timeout: int = 120) -> bool:
            del timeout
            return True

        def send_message(self, text: str, context: dict[str, object]):
            del text
            self.contexts.append(context)
            return type(
                "Response",
                (),
                {
                    "text": "ok",
                    "actions": ["REPLY"],
                    "params": {"usage": {"prompt_tokens": 1, "completion_tokens": 1}},
                },
            )()

    fake = FakeClient()
    client = object.__new__(HarnessClient)
    client._harness = "eliza"  # type: ignore[attr-defined]
    client._turn_index = 0  # type: ignore[attr-defined]
    client._server_manager = None  # type: ignore[attr-defined]
    client._client = fake  # type: ignore[attr-defined]

    cfg = GenerationConfig(model="m", max_tokens=16, temperature=0.0)
    first = [ChatMessage(role="user", content="problem one")]
    second = [ChatMessage(role="user", content="problem two")]

    assert isinstance(client.generate(first, cfg), GenerationResult)
    assert isinstance(client.generate(second, cfg), GenerationResult)

    task_ids = [str(ctx["task_id"]) for ctx in fake.contexts]
    assert task_ids[0].startswith("standard-eliza-1-")
    assert task_ids[1].startswith("standard-eliza-2-")
    assert task_ids[0] != task_ids[1]


def test_make_client_with_mock_returns_mock_client() -> None:
    client = make_client(endpoint="http://x", api_key="k", mock_responses=["ok"])
    assert isinstance(client, MockClient)


def test_harness_client_uses_native_hermes_campaign_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter_path = Path(__file__).resolve().parents[2] / "hermes-adapter"
    if str(adapter_path) not in sys.path:
        sys.path.insert(0, str(adapter_path))
    import hermes_adapter.client as client_module

    captured: dict[str, object] = {}

    class FakeHermesClient:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

        def wait_until_ready(self, timeout: int) -> None:
            captured["ready_timeout"] = timeout

    monkeypatch.setattr(client_module, "HermesClient", FakeHermesClient)
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-opus-4-6")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:43123/v1")
    monkeypatch.delenv("BENCHMARK_BASE_URL", raising=False)
    monkeypatch.delenv("BENCHMARK_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("CEREBRAS_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("HERMES_TIMEOUT_S", raising=False)

    client = HarnessClient(harness="hermes", endpoint="ignored", api_key="ignored")

    assert isinstance(client._client, FakeHermesClient)
    assert captured == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "base_url": "http://127.0.0.1:43123/v1",
        "timeout_s": 120.0,
        "reasoning_effort": None,
        "ready_timeout": 120,
    }


def test_harness_client_uses_native_openclaw_campaign_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter_path = Path(__file__).resolve().parents[2] / "openclaw-adapter"
    if str(adapter_path) not in sys.path:
        sys.path.insert(0, str(adapter_path))
    import openclaw_adapter.client as client_module

    captured: dict[str, object] = {}

    class FakeOpenClawClient:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

        def wait_until_ready(self, timeout: int) -> None:
            captured["ready_timeout"] = timeout

    monkeypatch.setattr(client_module, "OpenClawClient", FakeOpenClawClient)
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-opus-4-6")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:43123/v1")
    monkeypatch.delenv("BENCHMARK_BASE_URL", raising=False)
    monkeypatch.delenv("BENCHMARK_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("CEREBRAS_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("OPENCLAW_TIMEOUT_S", raising=False)

    client = HarnessClient(harness="openclaw", endpoint="ignored", api_key="ignored")

    assert isinstance(client._client, FakeOpenClawClient)
    assert captured == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "base_url": "http://127.0.0.1:43123/v1",
        "timeout_s": 120.0,
        "reasoning_effort": None,
        "ready_timeout": 120,
    }


def test_benchmark_result_roundtrip(tmp_path: Path) -> None:
    result = BenchmarkResult(
        benchmark="dummy",
        model="m",
        endpoint="http://x/v1",
        dataset_version="v1",
        n=2,
        metrics={"score": 0.5, "n": 2.0},
        raw_json={"detail": "x"},
        elapsed_s=1.23,
    )
    path = tmp_path / "out.json"
    result.write(path)
    data = json.loads(path.read_text("utf-8"))
    assert data["benchmark"] == "dummy"
    assert data["metrics"]["score"] == 0.5
    assert data["raw_json"]["detail"] == "x"
