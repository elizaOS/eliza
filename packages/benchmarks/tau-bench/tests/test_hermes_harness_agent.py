"""Hermes tau-bench construction uses the native campaign client contract."""

from __future__ import annotations

import sys
import types

import pytest

from elizaos_tau_bench.harness_agents import HermesTauAgent


def test_hermes_tau_agent_forwards_subscription_provider_without_legacy_mode(
    monkeypatch: pytest.MonkeyPatch,
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

    agent = HermesTauAgent(
        provider="claude-subscription",
        model="claude-opus-4-6",
        temperature=0.25,
    )

    assert isinstance(agent._client, FakeHermesClient)
    assert captured == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "temperature": 0.25,
        "max_tokens": 4096,
    }
