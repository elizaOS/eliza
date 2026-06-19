"""Experience benchmark runner compatibility layer.

The in-process Python Eliza runner has been removed. This module keeps the old
public names and routes convenience calls through ``eliza_adapter.experience``.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from elizaos_experience_bench.types import ElizaAgentMetrics, RetrievalMetrics


@dataclass
class AgentBenchmarkConfig:
    """Configuration for the Eliza bridge experience benchmark."""

    num_learning_scenarios: int = 10
    num_retrieval_queries: int = 20
    num_background_experiences: int = 100
    domains: list[str] = field(
        default_factory=lambda: [
            "coding",
            "shell",
            "network",
            "database",
            "security",
            "ai",
            "devops",
            "testing",
            "documentation",
            "performance",
        ]
    )
    seed: int = 42
    top_k_values: list[int] = field(default_factory=lambda: [1, 3, 5])


@dataclass
class AgentRetrievalResult:
    query: str
    domain: str
    response_text: str
    keywords_in_response: bool
    relevant_experience_found: bool
    experiences_retrieved: int
    latency_ms: float
    error: str | None = None


@dataclass
class AgentLearningResult:
    scenario_query: str
    domain: str
    experience_recorded: bool
    recorded_domain: str
    recorded_learning: str
    latency_ms: float
    error: str | None = None


@dataclass
class AgentBenchmarkResult:
    config: AgentBenchmarkConfig
    learning_results: list[AgentLearningResult] = field(default_factory=list)
    learning_success_rate: float = 0.0
    retrieval_results: list[AgentRetrievalResult] = field(default_factory=list)
    agent_retrieval_metrics: RetrievalMetrics | None = None
    direct_retrieval_metrics: RetrievalMetrics | None = None
    agent_metrics: ElizaAgentMetrics | None = None
    total_duration_ms: float = 0.0


class ElizaAgentExperienceRunner:
    """Bridge-backed replacement for the removed Python Eliza runner."""

    def __init__(self, config: AgentBenchmarkConfig | None = None) -> None:
        self.config = config or AgentBenchmarkConfig()

    async def run(
        self,
        runtime: object | None = None,
        progress_callback: Callable[[str, int, int], None] | None = None,
    ) -> AgentBenchmarkResult:
        _ = runtime
        return await run_eliza_agent_experience_benchmark(
            config=self.config,
            progress_callback=progress_callback,
        )


async def run_eliza_agent_experience_benchmark(
    model_plugin_factory: Callable[[], object] | None = None,
    config: AgentBenchmarkConfig | None = None,
    progress_callback: Callable[[str, int, int], None] | None = None,
) -> AgentBenchmarkResult:
    """Run the experience benchmark through the TypeScript bridge."""
    _ = model_plugin_factory
    cfg = config or AgentBenchmarkConfig()
    start = time.time()

    from eliza_adapter.experience import (
        ElizaBridgeExperienceRunner,
        ElizaExperienceConfig,
    )
    from eliza_adapter.server_manager import ElizaServerManager

    bridge_cfg = ElizaExperienceConfig(
        num_learning_scenarios=cfg.num_learning_scenarios,
        num_retrieval_queries=cfg.num_retrieval_queries,
        num_background_experiences=cfg.num_background_experiences,
        domains=cfg.domains,
        seed=cfg.seed,
        top_k_values=cfg.top_k_values,
    )
    bridge_manager = ElizaServerManager()
    bridge_manager.start()
    try:
        raw = await ElizaBridgeExperienceRunner(
            config=bridge_cfg,
            client=bridge_manager.client,
        ).run(progress_callback=progress_callback)
    finally:
        bridge_manager.stop()

    result = AgentBenchmarkResult(config=cfg)
    agent_data = raw.get("eliza_agent", {})
    if isinstance(agent_data, dict):
        result.learning_success_rate = float(agent_data.get("learning_success_rate", 0.0))
        result.agent_metrics = ElizaAgentMetrics(
            learning_success_rate=result.learning_success_rate,
            total_experiences_recorded=int(agent_data.get("total_experiences_recorded", 0)),
            total_experiences_in_service=int(agent_data.get("total_experiences_in_service", 0)),
            avg_learning_latency_ms=float(agent_data.get("avg_learning_latency_ms", 0.0)),
            agent_recall_rate=float(agent_data.get("agent_recall_rate", 0.0)),
            agent_keyword_incorporation_rate=float(
                agent_data.get("agent_keyword_incorporation_rate", 0.0)
            ),
            avg_retrieval_latency_ms=float(agent_data.get("avg_retrieval_latency_ms", 0.0)),
            direct_recall_rate=float(agent_data.get("direct_recall_rate", 0.0)),
            direct_mrr=float(agent_data.get("direct_mrr", 0.0)),
        )

    direct_data = raw.get("direct_retrieval", {})
    if isinstance(direct_data, dict):
        result.direct_retrieval_metrics = RetrievalMetrics(
            precision_at_k=direct_data.get("precision_at_k", {})
            if isinstance(direct_data.get("precision_at_k"), dict)
            else {},
            recall_at_k=direct_data.get("recall_at_k", {})
            if isinstance(direct_data.get("recall_at_k"), dict)
            else {},
            mean_reciprocal_rank=float(direct_data.get("mean_reciprocal_rank", 0.0)),
            hit_rate_at_k=direct_data.get("hit_rate_at_k", {})
            if isinstance(direct_data.get("hit_rate_at_k"), dict)
            else {},
        )

    result.total_duration_ms = float(raw.get("duration_ms", (time.time() - start) * 1000))
    return result


__all__ = [
    "AgentBenchmarkConfig",
    "AgentBenchmarkResult",
    "AgentLearningResult",
    "AgentRetrievalResult",
    "ElizaAgentExperienceRunner",
    "run_eliza_agent_experience_benchmark",
]
