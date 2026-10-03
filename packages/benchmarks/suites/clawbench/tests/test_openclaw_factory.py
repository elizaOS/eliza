"""Verifies the ClawBench OpenClaw lane selects the native campaign client."""

from __future__ import annotations

import sys
import types

from clawbench import multi_harness_runner


def test_openclaw_factory_uses_campaign_provider_without_direct_bypass(
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeOpenClawClient:
        def __init__(self, **kwargs: object) -> None:
            captured["client_kwargs"] = kwargs

    def fake_factory(**kwargs: object) -> object:
        captured["factory_kwargs"] = kwargs
        return object()

    package = types.ModuleType("openclaw_adapter")
    client_module = types.ModuleType("openclaw_adapter.client")
    factory_module = types.ModuleType("openclaw_adapter.clawbench")
    client_module.OpenClawClient = FakeOpenClawClient
    factory_module.build_clawbench_agent_fn = fake_factory
    monkeypatch.setitem(sys.modules, "openclaw_adapter", package)
    monkeypatch.setitem(sys.modules, "openclaw_adapter.client", client_module)
    monkeypatch.setitem(sys.modules, "openclaw_adapter.clawbench", factory_module)
    monkeypatch.setattr(
        multi_harness_runner,
        "_prepend_adapter_package",
        lambda _name: None,
    )
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")

    result = multi_harness_runner._build_agent_fn_openclaw(
        scenario_yaml={"id": "scenario"},
        fixtures={"mail": []},
        model_name="claude-opus-4-6",
    )

    assert result is not None
    assert captured["client_kwargs"] == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
    }
    factory_kwargs = captured["factory_kwargs"]
    assert isinstance(factory_kwargs, dict)
    assert isinstance(factory_kwargs["client"], FakeOpenClawClient)
