"""Tests for the shared adapter base (``benchmarks.standard._base``)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.standard._base import (
    BenchmarkResult,
    ChatMessage,
    GenerationConfig,
    MockClient,
    PROVIDER_BASE_URLS,
    make_client,
    resolve_api_key,
    resolve_endpoint,
)


def test_resolve_endpoint_prefers_explicit_url() -> None:
    assert resolve_endpoint(model_endpoint="http://x/v1", provider="openai") == "http://x/v1"


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


def test_make_client_with_mock_returns_mock_client() -> None:
    client = make_client(endpoint="http://x", api_key="k", mock_responses=["ok"])
    assert isinstance(client, MockClient)


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
