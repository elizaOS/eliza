"""Eliza Agent Runner for the Experience Benchmark.

Runs the experience benchmark through a real Eliza agent, testing the full
pipeline: Provider -> Model -> Action -> Evaluator.

Two phases:
  Phase 1 (Learning): Send messages that trigger experience recording via handle_message()
  Phase 2 (Retrieval): Send queries that should trigger experience retrieval

Compares agent-mediated retrieval vs direct ExperienceService calls.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos_experience_bench.eliza_plugin import (
    ExperienceBenchSession,
    ExperienceEvaluation,
    ExperiencePhase,
    run_experience_task_through_agent,
    set_experience_bench_session,
    setup_experience_benchmark_runtime,
)
from elizaos_experience_bench.generator import (
    ExperienceGenerator,
    GeneratedExperience,
    LearningScenario,
)
from elizaos_experience_bench.types import (
    ElizaAgentMetrics,
    LearningCycleMetrics,
    RetrievalMetrics,
)

if TYPE_CHECKING:
    from elizaos.types.plugin import Plugin
    from elizaos.types.runtime import IAgentRuntime

import sys
from pathlib import Path

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[3] / "plugins" / "plugin-experience" / "python"),
)

from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import ExperienceQuery


# ============================================================================
# Agent-Mediated Experience Benchmark
# ============================================================================


@dataclass
class AgentBenchmarkConfig:
    """Configuration for the Eliza agent experience benchmark."""

    # Number of learning scenarios to run through the agent
    num_learning_scenarios: int = 10
    # Number of retrieval queries after learning
    num_retrieval_queries: int = 20
    # Number of background noise experiences to load directly into service
    num_background_experiences: int = 100
    # Domains for background experiences
    domains: list[str] = field(
        default_factory=lambda: [
            "coding", "shell", "network", "database", "security",
            "ai", "devops", "testing", "documentation", "performance",
        ]
    )
    # Seed for reproducibility
    seed: int = 42
    # Top-k values for precision/recall
    top_k_values: list[int] = field(default_factory=lambda: [1, 3, 5])


@dataclass
class AgentRetrievalResult:
    """Result of a single agent retrieval query."""

    query: str
    domain: str
    response_text: str
    # Whether the response references the expected experience
    keywords_in_response: bool
    # Whether the experience service found the right experience
    relevant_experience_found: bool
    # Number of experiences retrieved by the service
    experiences_retrieved: int
    # Latency
    latency_ms: float
    error: str | None = None


@dataclass
class AgentLearningResult:
    """Result of a single agent learning interaction."""

    scenario_query: str
    domain: str
    experience_recorded: bool
    recorded_domain: str
    recorded_learning: str
    latency_ms: float
    error: str | None = None


@dataclass
class AgentBenchmarkResult:
    """Full results from the agent experience benchmark."""

    config: AgentBenchmarkConfig
    # Phase 1: Learning results
    learning_results: list[AgentLearningResult] = field(default_factory=list)
    learning_success_rate: float = 0.0
    # Phase 2: Retrieval results (agent-mediated)
    retrieval_results: list[AgentRetrievalResult] = field(default_factory=list)
    agent_retrieval_metrics: RetrievalMetrics | None = None
    # Comparison: direct service retrieval on the same queries
    direct_retrieval_metrics: RetrievalMetrics | None = None
    # Combined agent metrics
    agent_metrics: ElizaAgentMetrics | None = None
    # Timing
    total_duration_ms: float = 0.0


class ElizaAgentExperienceRunner:
    """Run the experience benchmark through a real Eliza agent."""

    def __init__(
        self,
        config: AgentBenchmarkConfig | None = None,
    ) -> None:
        self.config = config or AgentBenchmarkConfig()
        self.generator = ExperienceGenerator(seed=self.config.seed)

    async def run(
        self,
        runtime: "IAgentRuntime",
        progress_callback: Callable[[str, int, int], None] | None = None,
    ) -> AgentBenchmarkResult:
        """Run the full agent experience benchmark.

        Phase 1: Learning - send messages that trigger experience recording
        Phase 2: Retrieval - send queries and evaluate experience recall
        Phase 3: Compare agent retrieval vs direct service retrieval
        """
        start_time = time.time()
        result = AgentBenchmarkResult(config=self.config)

        # Create a shared session that persists across phases
        session = ExperienceBenchSession()
        set_experience_bench_session(session)

        # --- Load background noise experiences directly ---
        print("[ElizaAgent] Loading background experiences...")
        bg_experiences = self.generator.generate_experiences(
            count=self.config.num_background_experiences,
            domains=self.config.domains,
        )
        svc = session.experience_service
        now_ms = int(time.time() * 1000)
        for exp in bg_experiences:
            offset_ms = int(exp.created_at_offset_days * 24 * 60 * 60 * 1000)
            svc.record_experience(
                agent_id="bench-agent",
                context=exp.context,
                action=exp.action,
                result=exp.result,
                learning=exp.learning,
                domain=exp.domain,
                tags=exp.tags,
                confidence=exp.confidence,
                importance=exp.importance,
                created_at=now_ms - offset_ms,
            )
        print(
            f"[ElizaAgent] Loaded {svc.experience_count} background experiences"
        )

        # --- Generate learning scenarios ---
        scenarios = self.generator.generate_learning_scenarios(
            num_scenarios=self.config.num_learning_scenarios,
        )

        # --- Phase 1: Learning through the agent ---
        print(
            f"\n[ElizaAgent] Phase 1: Learning ({len(scenarios)} scenarios)..."
        )
        learning_successes = 0

        for i, scenario in enumerate(scenarios):
            if progress_callback:
                progress_callback("Learning", i, len(scenarios))

            # Construct a learning message
            learning_message = (
                f"I just encountered this problem: {scenario.problem_context}. "
                f"I tried: {scenario.problem_action}. "
                f"The result was: {scenario.problem_result}. "
                f"Please remember that: {scenario.learned_experience.learning}"
            )

            evaluation = await run_experience_task_through_agent(
                runtime=runtime,
                session=session,
                task_id=f"learn-{i}",
                phase=ExperiencePhase.LEARNING,
                message_text=learning_message,
                expected_domain=scenario.expected_domain,
                expected_learning=scenario.learned_experience.learning,
            )

            learning_result = AgentLearningResult(
                scenario_query=scenario.similar_query,
                domain=scenario.expected_domain,
                experience_recorded=evaluation.experience_recorded,
                recorded_domain=evaluation.recorded_domain,
                recorded_learning=evaluation.recorded_learning,
                latency_ms=evaluation.latency_ms,
                error=evaluation.error,
            )
            result.learning_results.append(learning_result)

            if evaluation.experience_recorded:
                learning_successes += 1

        if progress_callback:
            progress_callback("Learning", len(scenarios), len(scenarios))

        result.learning_success_rate = (
            learning_successes / len(scenarios) if scenarios else 0.0
        )
        print(
            f"[ElizaAgent] Learning phase: {learning_successes}/{len(scenarios)} "
            f"experiences recorded ({result.learning_success_rate:.1%})"
        )

        # --- Phase 2: Retrieval through the agent ---
        print(
            f"\n[ElizaAgent] Phase 2: Retrieval ({len(scenarios)} queries)..."
        )

        for i, scenario in enumerate(scenarios):
            if progress_callback:
                progress_callback("Retrieval", i, len(scenarios))

            # Query about the scenario that was learned
            retrieval_message = (
                f"I'm facing a similar problem: {scenario.similar_query}. "
                f"Do you recall any past experiences that could help?"
            )

            evaluation = await run_experience_task_through_agent(
                runtime=runtime,
                session=session,
                task_id=f"retrieve-{i}",
                phase=ExperiencePhase.RETRIEVAL,
                message_text=retrieval_message,
                expected_domain=scenario.expected_domain,
                expected_experience_keywords=scenario.expected_learning_keywords,
            )

            retrieval_result = AgentRetrievalResult(
                query=scenario.similar_query,
                domain=scenario.expected_domain,
                response_text=evaluation.response_text,
                keywords_in_response=evaluation.keywords_in_response,
                relevant_experience_found=evaluation.relevant_experience_found,
                experiences_retrieved=evaluation.experiences_retrieved,
                latency_ms=evaluation.latency_ms,
                error=evaluation.error,
            )
            result.retrieval_results.append(retrieval_result)

        if progress_callback:
            progress_callback("Retrieval", len(scenarios), len(scenarios))

        # --- Phase 3: Compute metrics and compare ---
        print("\n[ElizaAgent] Phase 3: Computing metrics...")

        # Agent retrieval metrics
        agent_recall_hits = sum(
            1 for r in result.retrieval_results if r.relevant_experience_found
        )
        agent_keyword_hits = sum(
            1 for r in result.retrieval_results if r.keywords_in_response
        )
        n_retrieval = len(result.retrieval_results) or 1

        agent_recall_rate = agent_recall_hits / n_retrieval
        agent_keyword_rate = agent_keyword_hits / n_retrieval

        # Direct service comparison: query the same scenarios directly
        direct_recall_hits = 0
        direct_precision_hits = 0
        direct_mrr_sum = 0.0
        direct_hit_sums: dict[int, int] = {k: 0 for k in self.config.top_k_values}

        for scenario in scenarios:
            direct_results = svc.query_experiences(
                ExperienceQuery(query=scenario.similar_query, limit=max(self.config.top_k_values))
            )

            # Check if any result matches expected keywords in learning
            found_relevant = False
            for rank, exp in enumerate(direct_results, 1):
                exp_text = f"{exp.context} {exp.learning}".lower()
                if all(kw.lower() in exp_text for kw in scenario.expected_learning_keywords):
                    found_relevant = True
                    if rank == 1:
                        direct_precision_hits += 1
                    direct_mrr_sum += 1.0 / rank
                    for k in self.config.top_k_values:
                        if rank <= k:
                            direct_hit_sums[k] += 1
                    break

            if found_relevant:
                direct_recall_hits += 1

        n_scenarios = len(scenarios) or 1
        result.direct_retrieval_metrics = RetrievalMetrics(
            precision_at_k={1: direct_precision_hits / n_scenarios},
            recall_at_k={k: direct_hit_sums.get(k, 0) / n_scenarios for k in self.config.top_k_values},
            mean_reciprocal_rank=direct_mrr_sum / n_scenarios,
            hit_rate_at_k={k: direct_hit_sums.get(k, 0) / n_scenarios for k in self.config.top_k_values},
        )

        # Agent-mediated metrics (using eval results, not direct service)
        result.agent_metrics = ElizaAgentMetrics(
            learning_success_rate=result.learning_success_rate,
            agent_recall_rate=agent_recall_rate,
            agent_keyword_incorporation_rate=agent_keyword_rate,
            direct_recall_rate=direct_recall_hits / n_scenarios,
            direct_mrr=direct_mrr_sum / n_scenarios,
            total_experiences_recorded=len(session.recorded_ids),
            total_experiences_in_service=svc.experience_count,
            avg_learning_latency_ms=(
                sum(r.latency_ms for r in result.learning_results) / len(result.learning_results)
                if result.learning_results
                else 0.0
            ),
            avg_retrieval_latency_ms=(
                sum(r.latency_ms for r in result.retrieval_results) / len(result.retrieval_results)
                if result.retrieval_results
                else 0.0
            ),
        )

        result.total_duration_ms = (time.time() - start_time) * 1000

        # Print summary
        self._print_summary(result)

        return result

    def _print_summary(self, result: AgentBenchmarkResult) -> None:
        """Print a human-readable summary of the agent benchmark results."""
        metrics = result.agent_metrics
        if metrics is None:
            return

        print("\n" + "=" * 60)
        print("ELIZA AGENT EXPERIENCE BENCHMARK RESULTS")
        print("=" * 60)

        print(f"\n  Learning Phase:")
        print(f"    Experience recording rate: {metrics.learning_success_rate:.1%}")
        print(f"    Total experiences recorded: {metrics.total_experiences_recorded}")
        print(f"    Total in service: {metrics.total_experiences_in_service}")
        print(f"    Avg latency: {metrics.avg_learning_latency_ms:.0f}ms")

        print(f"\n  Retrieval Phase (Agent-Mediated):")
        print(f"    Recall rate: {metrics.agent_recall_rate:.1%}")
        print(f"    Keyword incorporation: {metrics.agent_keyword_incorporation_rate:.1%}")
        print(f"    Avg latency: {metrics.avg_retrieval_latency_ms:.0f}ms")

        print(f"\n  Retrieval Phase (Direct Service):")
        print(f"    Recall rate: {metrics.direct_recall_rate:.1%}")
        print(f"    MRR: {metrics.direct_mrr:.3f}")

        if result.direct_retrieval_metrics:
            dm = result.direct_retrieval_metrics
            for k, v in dm.hit_rate_at_k.items():
                print(f"    Hit@{k}: {v:.3f}")

        # Show failures
        failed_learning = [r for r in result.learning_results if not r.experience_recorded]
        if failed_learning:
            print(f"\n  Learning Failures ({len(failed_learning)}):")
            for f in failed_learning[:5]:
                err = f" (error: {f.error})" if f.error else ""
                print(f"    - {f.domain}: {f.scenario_query[:60]}...{err}")

        failed_retrieval = [
            r for r in result.retrieval_results if not r.relevant_experience_found
        ]
        if failed_retrieval:
            print(f"\n  Retrieval Failures ({len(failed_retrieval)}):")
            for f in failed_retrieval[:5]:
                err = f" (error: {f.error})" if f.error else ""
                print(f"    - {f.domain}: {f.query[:60]}...{err}")

        print(f"\n  Total Duration: {result.total_duration_ms / 1000:.1f}s")
        print("=" * 60)


# ============================================================================
# Convenience functions
# ============================================================================


async def run_eliza_agent_experience_benchmark(
    model_plugin_factory: Callable[[], Plugin] | None = None,
    config: AgentBenchmarkConfig | None = None,
    progress_callback: Callable[[str, int, int], None] | None = None,
) -> AgentBenchmarkResult:
    """Set up Eliza runtime and run the full agent experience benchmark.

    Convenience function that:
    1. Creates an AgentRuntime with experience character
    2. Registers the model plugin
    3. Registers the experience bench plugin
    4. Runs learning + retrieval phases
    5. Returns comparison metrics
    """
    bench_config = config or AgentBenchmarkConfig()

    model_plugin: Plugin | None = None
    if model_plugin_factory is not None:
        from elizaos.types.plugin import Plugin as PluginType

        candidate = model_plugin_factory()
        if isinstance(candidate, PluginType):
            model_plugin = candidate

    runtime = await setup_experience_benchmark_runtime(model_plugin)

    try:
        runner = ElizaAgentExperienceRunner(config=bench_config)
        return await runner.run(runtime, progress_callback=progress_callback)
    finally:
        await runtime.stop()
