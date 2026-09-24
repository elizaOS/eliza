"""Cross-harness delegate routing preserves each native transport endpoint."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from eliza_adapter.client import _build_delegate_client


def test_subscription_hermes_delegate_prefers_openai_base_over_gateway_origin(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}

    class FakeHermesClient:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    package = types.ModuleType("hermes_adapter")
    client_module = types.ModuleType("hermes_adapter.client")
    client_module.HermesClient = FakeHermesClient
    monkeypatch.setitem(sys.modules, "hermes_adapter", package)
    monkeypatch.setitem(sys.modules, "hermes_adapter.client", client_module)
    monkeypatch.setenv("ELIZA_BENCH_HARNESS", "hermes")
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-sonnet-4-6")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_GATEWAY_URL", "http://127.0.0.1:43123")
    monkeypatch.setenv("BENCHMARK_BASE_URL", "http://127.0.0.1:43123/v1")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:43123/v1")
    monkeypatch.setenv("ORCHESTRATOR_LIFECYCLE_WORKSPACE_PATH", str(tmp_path))

    client = _build_delegate_client()

    assert isinstance(client, FakeHermesClient)
    assert captured["provider"] == "claude-subscription"
    assert captured["model"] == "claude-sonnet-4-6"
    assert captured["base_url"] == "http://127.0.0.1:43123/v1"
    assert captured["workspace_path"] == tmp_path.resolve()
