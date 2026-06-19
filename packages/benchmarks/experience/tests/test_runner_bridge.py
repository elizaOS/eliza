"""Tests for the async Eliza bridge result mapping."""

from __future__ import annotations

import sys
import asyncio
from types import ModuleType
from typing import Any

import pytest

from elizaos_experience_bench.runner import ExperienceBenchmarkRunner
from elizaos_experience_bench.types import BenchmarkConfig


class _FakeElizaExperienceConfig:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class _FakeElizaServerManager:
    def __init__(self) -> None:
        self.client = object()
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True


class _FakeElizaBridgeExperienceRunner:
    def __init__(self, *, config: _FakeElizaExperienceConfig, client: object) -> None:
        self.config = config
        self.client = client

    async def run(self, progress_callback: object | None = None) -> dict[str, Any]:
        return {
            "total_experiences": 12,
            "eliza_agent": {
                "learning_success_rate": 0.75,
                "total_experiences_recorded": 9,
                "total_experiences_in_service": 8,
                "avg_learning_latency_ms": 11.0,
                "agent_recall_rate": 0.5,
                "agent_keyword_incorporation_rate": 0.25,
                "avg_retrieval_latency_ms": 7.0,
                "direct_recall_rate": 1.0,
                "direct_mrr": 0.8,
            },
            "direct_retrieval": {
                "precision_at_k": {1: 1.0},
                "recall_at_k": {1: 0.5},
                "mean_reciprocal_rank": 0.8,
                "hit_rate_at_k": {1: 1.0},
            },
        }


def test_run_eliza_agent_maps_bridge_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = ModuleType("eliza_adapter")
    experience = ModuleType("eliza_adapter.experience")
    server_manager = ModuleType("eliza_adapter.server_manager")

    experience.ElizaBridgeExperienceRunner = _FakeElizaBridgeExperienceRunner
    experience.ElizaExperienceConfig = _FakeElizaExperienceConfig
    server_manager.ElizaServerManager = _FakeElizaServerManager

    monkeypatch.setitem(sys.modules, "eliza_adapter", root)
    monkeypatch.setitem(sys.modules, "eliza_adapter.experience", experience)
    monkeypatch.setitem(sys.modules, "eliza_adapter.server_manager", server_manager)

    runner = ExperienceBenchmarkRunner(
        BenchmarkConfig(num_experiences=20, num_learning_cycles=3, top_k_values=[1])
    )
    result = asyncio.run(runner.run_eliza_agent())

    assert result.total_experiences == 12
    assert result.eliza_agent is not None
    assert result.eliza_agent.learning_success_rate == 0.75
    assert result.eliza_agent.total_experiences_recorded == 9
    assert result.retrieval is not None
    assert result.retrieval.mean_reciprocal_rank == 0.8
    assert result.retrieval.precision_at_k == {1: 1.0}
