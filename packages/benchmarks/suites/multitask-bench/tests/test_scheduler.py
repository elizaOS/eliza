"""Wave-partitioning determinism and the hermetic Perfect/Wrong lane runs.

Drives the real scheduler + the real LifeOpsBench runner through the frozen
sample with the deterministic Perfect/Wrong oracles (no model, no keys), so
these assertions exercise the actual concurrency path rather than a mock of it.
"""

from __future__ import annotations

import sys
import types

import pytest

from multitask_bench import harness as harness_module
from multitask_bench.metrics import compute_interference, compute_lane_metrics
from multitask_bench.sample import MULTITASK_SAMPLE
from multitask_bench.scheduler import partition_waves


def test_partition_waves_is_deterministic_and_exact() -> None:
    scenarios = MULTITASK_SAMPLE
    assert len(scenarios) == 10

    n1 = partition_waves(scenarios, 1)
    assert len(n1) == 10
    assert all(len(w) == 1 for w in n1)

    n5 = partition_waves(scenarios, 5)
    assert len(n5) == 2
    assert [len(w) for w in n5] == [5, 5]

    n10 = partition_waves(scenarios, 10)
    assert len(n10) == 1
    assert len(n10[0]) == 10

    # Same sample + N always slices identically — this is what lets the
    # interference delta line up (scenario, seed) pairs across lanes.
    assert partition_waves(scenarios, 5) == n5
    # Wave order preserves sample order.
    assert [s.id for w in n5 for s in w] == [s.id for s in scenarios]


def test_partition_waves_rejects_zero() -> None:
    with pytest.raises(ValueError):
        partition_waves(MULTITASK_SAMPLE, 0)


def test_hermes_lane_factory_uses_native_subscription_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeHermesClient:
        def __init__(self, **kwargs: object) -> None:
            captured["client_kwargs"] = kwargs

        def wait_until_ready(self, timeout: int) -> None:
            captured["ready_timeout"] = timeout

    def fake_builder(**kwargs: object) -> str:
        captured["factory_kwargs"] = kwargs
        return "native-hermes-agent"

    package = types.ModuleType("hermes_adapter")
    client_module = types.ModuleType("hermes_adapter.client")
    factory_module = types.ModuleType("hermes_adapter.lifeops_bench")
    client_module.HermesClient = FakeHermesClient
    factory_module.build_lifeops_bench_agent_fn = fake_builder
    monkeypatch.setitem(sys.modules, "hermes_adapter", package)
    monkeypatch.setitem(sys.modules, "hermes_adapter.client", client_module)
    monkeypatch.setitem(sys.modules, "hermes_adapter.lifeops_bench", factory_module)
    monkeypatch.setattr(
        harness_module,
        "ensure_benchmark_adapter_importable",
        lambda _name: None,
    )
    monkeypatch.setenv("BENCHMARK_MODEL_PROVIDER", "claude-subscription")
    monkeypatch.setenv("BENCHMARK_MODEL_NAME", "claude-opus-4-6")

    factory = harness_module._hermes_factory(model=None)
    result = factory(object())

    assert result == "native-hermes-agent"
    assert captured["client_kwargs"] == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
    }
    assert captured["ready_timeout"] == 60
    factory_kwargs = captured["factory_kwargs"]
    assert isinstance(factory_kwargs, dict)
    assert isinstance(factory_kwargs["client"], FakeHermesClient)
    assert factory_kwargs["model_name"] == "claude-opus-4-6"


def test_eliza_lane_factory_builds_without_usage_fix_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The eliza lane must build ungated: per-session usage attribution is the
    AsyncLocalStorage buffer in suites/lifeops-bench/runner/src/server.ts (#13777),
    so the old MULTITASK_ELIZA_USAGE_FIX escape hatch no longer exists."""
    captured: dict[str, object] = {}

    class FakeElizaClient:
        def __init__(self) -> None:
            captured["client"] = self

        def wait_until_ready(self, timeout: int) -> None:
            captured["ready_timeout"] = timeout

    def fake_builder(**kwargs: object) -> str:
        captured["factory_kwargs"] = kwargs
        return "native-eliza-agent"

    package = types.ModuleType("eliza_adapter")
    client_module = types.ModuleType("eliza_adapter.client")
    factory_module = types.ModuleType("eliza_adapter.lifeops_bench")
    client_module.ElizaClient = FakeElizaClient
    factory_module.build_lifeops_bench_agent_fn = fake_builder
    monkeypatch.setitem(sys.modules, "eliza_adapter", package)
    monkeypatch.setitem(sys.modules, "eliza_adapter.client", client_module)
    monkeypatch.setitem(sys.modules, "eliza_adapter.lifeops_bench", factory_module)
    monkeypatch.setattr(
        harness_module,
        "ensure_benchmark_adapter_importable",
        lambda _name: None,
    )
    # A pre-set bench URL keeps the factory from spawning a real server; the
    # deleted env var proves the gate is gone rather than merely satisfied.
    monkeypatch.setenv("ELIZA_BENCH_URL", "http://127.0.0.1:1")
    monkeypatch.delenv("MULTITASK_ELIZA_USAGE_FIX", raising=False)

    factory = harness_module.build_agent_factory("eliza", model="gemma-4-31b")
    result = factory(object())

    assert result == "native-eliza-agent"
    assert captured["ready_timeout"] == 120
    factory_kwargs = captured["factory_kwargs"]
    assert isinstance(factory_kwargs, dict)
    assert isinstance(factory_kwargs["client"], FakeElizaClient)
    assert factory_kwargs["model_name"] == "gemma-4-31b"


def test_perfect_lane_scores_one_with_no_interference(perfect_lanes) -> None:
    metrics = [compute_lane_metrics(lane) for lane in perfect_lanes]
    assert [m["n"] for m in metrics] == [1, 5, 10]
    for m in metrics:
        assert m["tasks_completed"] == 10
        assert m["completion_rate"] == 1.0
        assert m["mean_task_score"] == pytest.approx(1.0)
        assert m["starved_tasks"] == 0

    interference = compute_interference(metrics)
    # A perfect oracle scores each task identically alone and under load, so
    # every interference delta is exactly zero.
    assert interference["n5_minus_n1"] == pytest.approx(0.0)
    assert interference["n10_minus_n1"] == pytest.approx(0.0)


def test_wrong_lane_scores_zero_with_no_starvation(wrong_lanes) -> None:
    metrics = [compute_lane_metrics(lane) for lane in wrong_lanes]
    for m in metrics:
        # Wrong agent terminates cleanly (a refusal), so tasks complete but
        # score zero — this is a completed zero, never a starved/timed-out one.
        assert m["tasks_completed"] == 10
        assert m["mean_task_score"] == pytest.approx(0.0)
        assert m["starved_tasks"] == 0

    interference = compute_interference(metrics)
    assert interference["n5_minus_n1"] == pytest.approx(0.0)
