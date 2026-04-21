"""Benchmark runner that orchestrates generation, evaluation, and reporting."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import asdict

from elizaos_experience_bench.evaluators import (
    LearningCycleEvaluator,
    RerankingEvaluator,
    RetrievalEvaluator,
)
from elizaos_experience_bench.evaluators.hard_cases import HardCaseEvaluator
from elizaos_experience_bench.generator import ExperienceGenerator
from elizaos_experience_bench.types import (
    BenchmarkConfig,
    BenchmarkResult,
    BenchmarkSuite,
    HardCaseCategoryMetrics,
    HardCaseMetrics,
)


class ExperienceBenchmarkRunner:
    """Run the full experience benchmark suite."""

    def __init__(self, config: BenchmarkConfig | None = None) -> None:
        self.config = config or BenchmarkConfig()
        self.generator = ExperienceGenerator(seed=self.config.seed)

    def run(self) -> BenchmarkResult:
        """Run all configured benchmark suites."""
        print(f"[ExperienceBench] Generating {self.config.num_experiences} synthetic experiences...")
        experiences = self.generator.generate_experiences(
            count=self.config.num_experiences,
            domains=self.config.domains,
        )
        print(f"[ExperienceBench] Generated {len(experiences)} experiences across {len(set(e.domain for e in experiences))} domains")

        result = BenchmarkResult(
            config=self.config,
            total_experiences=len(experiences),
        )

        # --- Retrieval benchmark ---
        if BenchmarkSuite.RETRIEVAL in self.config.suites:
            print(f"\n[ExperienceBench] Running RETRIEVAL benchmark...")
            queries = self.generator.generate_retrieval_queries(
                experiences, num_queries=self.config.num_retrieval_queries,
            )
            result.total_queries += len(queries)

            evaluator = RetrievalEvaluator(top_k_values=self.config.top_k_values)
            t0 = time.time()
            result.retrieval = evaluator.evaluate(experiences, queries)
            elapsed = time.time() - t0

            print(f"  MRR: {result.retrieval.mean_reciprocal_rank:.3f}")
            for k in self.config.top_k_values:
                p = result.retrieval.precision_at_k.get(k, 0)
                r = result.retrieval.recall_at_k.get(k, 0)
                h = result.retrieval.hit_rate_at_k.get(k, 0)
                print(f"  P@{k}: {p:.3f}  R@{k}: {r:.3f}  Hit@{k}: {h:.3f}")
            print(f"  Time: {elapsed:.2f}s")

        # --- Reranking benchmark ---
        if BenchmarkSuite.RERANKING in self.config.suites:
            print(f"\n[ExperienceBench] Running RERANKING benchmark...")
            evaluator = RerankingEvaluator()
            t0 = time.time()
            reranking_results = evaluator.evaluate()
            elapsed = time.time() - t0

            result.reranking = type("RerankingMetrics", (), {
                "similarity_dominance_rate": reranking_results["similarity_dominance_rate"],
                "quality_tiebreak_rate": reranking_results["quality_tiebreak_rate"],
                "noise_rejection_rate": reranking_results["noise_rejection_rate"],
                "failures": reranking_results["failures"],
            })()

            print(f"  Similarity dominance: {reranking_results['similarity_dominance_rate']:.1%}")
            print(f"  Quality tiebreaking: {reranking_results['quality_tiebreak_rate']:.1%}")
            print(f"  Noise rejection: {reranking_results['noise_rejection_rate']:.1%}")
            if reranking_results["failures"]:
                for f in reranking_results["failures"]:
                    print(f"  FAIL: {f}")
            print(f"  Time: {elapsed:.2f}s")

        # --- Learning cycle benchmark ---
        if BenchmarkSuite.LEARNING_CYCLE in self.config.suites:
            print(f"\n[ExperienceBench] Running LEARNING CYCLE benchmark...")
            # Use a subset of experiences as background noise
            bg_count = min(100, len(experiences))
            bg_experiences = experiences[:bg_count]
            scenarios = self.generator.generate_learning_scenarios(
                num_scenarios=self.config.num_learning_cycles,
            )

            evaluator = LearningCycleEvaluator()
            t0 = time.time()
            result.learning_cycle = evaluator.evaluate(bg_experiences, scenarios)
            elapsed = time.time() - t0

            print(f"  Recall rate: {result.learning_cycle.experience_recall_rate:.1%}")
            print(f"  Precision rate: {result.learning_cycle.experience_precision_rate:.1%}")
            print(f"  Cycle success rate: {result.learning_cycle.cycle_success_rate:.1%}")
            print(f"  Time: {elapsed:.2f}s")

            # Show failures
            failures = [c for c in result.learning_cycle.cycle_results if not c["cycle_success"]]
            if failures:
                print(f"  Failed cycles ({len(failures)}):")
                for f in failures[:5]:
                    print(f"    - query: {f['query']}, retrieved: {f['retrieved']}, keywords: {f['keywords_in_learned']}")

        # --- Hard cases benchmark ---
        if BenchmarkSuite.HARD_CASES in self.config.suites:
            print(f"\n[ExperienceBench] Running HARD CASES benchmark...")
            evaluator = HardCaseEvaluator()
            t0 = time.time()
            hard_results = evaluator.evaluate()
            elapsed = time.time() - t0

            # Convert to typed metrics
            result.hard_cases = HardCaseMetrics(
                categories=[
                    HardCaseCategoryMetrics(
                        category=c.category,
                        tier=c.tier,
                        requires_embeddings=c.requires_embeddings,
                        total=c.total,
                        passed=c.passed,
                        rate=c.rate,
                        failures=c.failures,
                    )
                    for c in hard_results.categories
                ],
                jaccard_total=hard_results.jaccard_total,
                jaccard_passed=hard_results.jaccard_passed,
                jaccard_rate=hard_results.jaccard_rate,
                semantic_total=hard_results.semantic_total,
                semantic_passed=hard_results.semantic_passed,
                semantic_rate=hard_results.semantic_rate,
            )

            print(f"  JACCARD TIER ({hard_results.jaccard_passed}/{hard_results.jaccard_total} = {hard_results.jaccard_rate:.0%}):")
            for c in hard_results.categories:
                if c.tier == "jaccard":
                    tag = ""
                    print(f"    {c.category}: {c.passed}/{c.total} ({c.rate:.0%}){tag}")

            print(f"  SEMANTIC TIER ({hard_results.semantic_passed}/{hard_results.semantic_total} = {hard_results.semantic_rate:.0%}):")
            for c in hard_results.categories:
                if c.tier == "semantic":
                    tag = "  [requires_embeddings]"
                    print(f"    {c.category}: {c.passed}/{c.total} ({c.rate:.0%}){tag}")

            if hard_results.all_failures:
                print(f"  Failures ({len(hard_results.all_failures)}):")
                for f in hard_results.all_failures[:10]:
                    print(f"    {f}")
                if len(hard_results.all_failures) > 10:
                    print(f"    ... and {len(hard_results.all_failures) - 10} more")

            print(f"  Time: {elapsed:.2f}s")

        # --- Eliza Agent benchmark (async, requires runtime) ---
        if BenchmarkSuite.ELIZA_AGENT in self.config.suites:
            print(f"\n[ExperienceBench] ELIZA_AGENT suite is configured.")
            print(f"  Use run_eliza_agent() or the CLI --mode eliza-agent to run it.")
            print(f"  (It requires an async runtime and model plugin.)")

        print(f"\n[ExperienceBench] Done. Total experiences: {result.total_experiences}, Total queries: {result.total_queries}")
        return result

    async def run_eliza_agent(
        self,
        model_plugin_factory: "Callable | None" = None,
        progress_callback: "Callable[[str, int, int], None] | None" = None,
    ) -> BenchmarkResult:
        """Run the Eliza agent experience benchmark.

        This runs the experience benchmark through a real Eliza agent,
        testing the full pipeline: Provider -> Model -> Action -> Evaluator.

        Args:
            model_plugin_factory: Factory function that returns a model Plugin.
            progress_callback: Optional callback(phase, completed, total).

        Returns:
            BenchmarkResult with eliza_agent metrics populated.
        """
        from elizaos_experience_bench.eliza_runner import (
            AgentBenchmarkConfig,
            ElizaAgentExperienceRunner,
            run_eliza_agent_experience_benchmark,
        )

        print(f"\n[ExperienceBench] Running ELIZA AGENT benchmark...")
        print(f"  This tests the full Eliza canonical flow:")
        print(f"  Provider -> MESSAGE_HANDLER_TEMPLATE -> Actions -> Evaluators")

        agent_config = AgentBenchmarkConfig(
            num_learning_scenarios=self.config.num_learning_cycles,
            num_background_experiences=min(self.config.num_experiences, 200),
            domains=self.config.domains,
            seed=self.config.seed,
            top_k_values=self.config.top_k_values,
        )

        agent_result = await run_eliza_agent_experience_benchmark(
            model_plugin_factory=model_plugin_factory,
            config=agent_config,
            progress_callback=progress_callback,
        )

        # Build the combined result with both direct and agent metrics
        result = BenchmarkResult(
            config=self.config,
            total_experiences=agent_result.agent_metrics.total_experiences_in_service
            if agent_result.agent_metrics
            else 0,
        )

        if agent_result.agent_metrics is not None:
            result.eliza_agent = agent_result.agent_metrics

        if agent_result.direct_retrieval_metrics is not None:
            result.retrieval = agent_result.direct_retrieval_metrics

        return result

    def run_and_report(self, output_path: str | None = None) -> BenchmarkResult:
        """Run benchmarks and optionally write JSON report."""
        result = self.run()
        if output_path:
            report = _serialize_result(result)
            with open(output_path, "w") as f:
                json.dump(report, f, indent=2, default=str)
            print(f"\n[ExperienceBench] Report written to {output_path}")
        return result


def _serialize_result(result: BenchmarkResult) -> dict:
    """Convert result to a JSON-serializable dict."""
    out: dict = {
        "total_experiences": result.total_experiences,
        "total_queries": result.total_queries,
    }
    if result.retrieval:
        out["retrieval"] = {
            "precision_at_k": result.retrieval.precision_at_k,
            "recall_at_k": result.retrieval.recall_at_k,
            "mean_reciprocal_rank": result.retrieval.mean_reciprocal_rank,
            "hit_rate_at_k": result.retrieval.hit_rate_at_k,
        }
    if result.reranking:
        out["reranking"] = {
            "similarity_dominance_rate": result.reranking.similarity_dominance_rate,
            "quality_tiebreak_rate": result.reranking.quality_tiebreak_rate,
            "noise_rejection_rate": result.reranking.noise_rejection_rate,
            "failures": result.reranking.failures,
        }
    if result.learning_cycle:
        out["learning_cycle"] = {
            "experience_recall_rate": result.learning_cycle.experience_recall_rate,
            "experience_precision_rate": result.learning_cycle.experience_precision_rate,
            "cycle_success_rate": result.learning_cycle.cycle_success_rate,
        }
    if result.hard_cases:
        out["hard_cases"] = {
            "jaccard_rate": result.hard_cases.jaccard_rate,
            "jaccard_passed": result.hard_cases.jaccard_passed,
            "jaccard_total": result.hard_cases.jaccard_total,
            "semantic_rate": result.hard_cases.semantic_rate,
            "semantic_passed": result.hard_cases.semantic_passed,
            "semantic_total": result.hard_cases.semantic_total,
            "categories": [
                {
                    "category": c.category,
                    "tier": c.tier,
                    "passed": c.passed,
                    "total": c.total,
                    "rate": c.rate,
                    "requires_embeddings": c.requires_embeddings,
                }
                for c in result.hard_cases.categories
            ],
        }
    if result.eliza_agent:
        out["eliza_agent"] = {
            "learning_success_rate": result.eliza_agent.learning_success_rate,
            "total_experiences_recorded": result.eliza_agent.total_experiences_recorded,
            "total_experiences_in_service": result.eliza_agent.total_experiences_in_service,
            "avg_learning_latency_ms": result.eliza_agent.avg_learning_latency_ms,
            "agent_recall_rate": result.eliza_agent.agent_recall_rate,
            "agent_keyword_incorporation_rate": result.eliza_agent.agent_keyword_incorporation_rate,
            "avg_retrieval_latency_ms": result.eliza_agent.avg_retrieval_latency_ms,
            "direct_recall_rate": result.eliza_agent.direct_recall_rate,
            "direct_mrr": result.eliza_agent.direct_mrr,
        }
    return out
