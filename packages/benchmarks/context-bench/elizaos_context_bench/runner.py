"""Benchmark runner for ContextBench."""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Awaitable, Callable

from elizaos_context_bench.evaluators.position import PositionAnalyzer
from elizaos_context_bench.suites.multihop import MultiHopBenchmarkSuite
from elizaos_context_bench.suites.niah import NIAHBenchmarkSuite
from elizaos_context_bench.types import (
    LEADERBOARD_SCORES,
    ContextBenchConfig,
    ContextBenchMetrics,
    ContextBenchResult,
    ContextBenchResults,
    ContextBenchType,
    NeedlePosition,
)

LLMQueryFn = Callable[[str, str], Awaitable[str]]


class ContextBenchRunner:
    """Coordinate ContextBench suites and aggregate their results."""

    def __init__(
        self,
        config: ContextBenchConfig | None = None,
        llm_query_fn: LLMQueryFn | None = None,
        embedding_fn: Callable[[str], list[float]] | None = None,
        seed: int | None = 42,
    ) -> None:
        self.config = config or ContextBenchConfig()
        self.llm_query_fn = llm_query_fn
        self.embedding_fn = embedding_fn
        self.seed = seed
        self.niah_suite = NIAHBenchmarkSuite(
            config=self.config,
            llm_query_fn=llm_query_fn,
            embedding_fn=embedding_fn,
            seed=seed,
        )
        self.multihop_suite = MultiHopBenchmarkSuite(
            config=self.config,
            llm_query_fn=llm_query_fn,
            embedding_fn=embedding_fn,
            seed=seed,
        )

    def set_llm_query_fn(self, llm_query_fn: LLMQueryFn) -> None:
        """Set the model query function on this runner and child suites."""
        self.llm_query_fn = llm_query_fn
        self.niah_suite.llm_query_fn = llm_query_fn
        self.multihop_suite.llm_query_fn = llm_query_fn

    async def run_quick_eval(self) -> ContextBenchResults:
        """Run a small NIAH-only evaluation."""
        started = time.time()
        results = await self.niah_suite.run_quick_eval()
        return self._build_results(results, started)

    async def run_position_sweep(
        self,
        context_lengths: list[int] | None = None,
        positions: list[NeedlePosition] | None = None,
    ) -> ContextBenchResults:
        """Run NIAH tasks for selected context lengths and positions."""
        started = time.time()
        results = await self.niah_suite.run_position_sweep(
            context_lengths=context_lengths,
            positions=positions,
        )
        return self._build_results(results, started)

    async def run_full_benchmark(
        self,
        progress_callback: Callable[[str, int, int], None] | None = None,
    ) -> ContextBenchResults:
        """Run enabled ContextBench suites and return aggregate results."""
        started = time.time()
        all_results: list[ContextBenchResult] = []

        if self.config.run_niah_basic or self.config.run_niah_semantic:

            def niah_progress(completed: int, total: int) -> None:
                if progress_callback:
                    progress_callback("NIAH", completed, total)

            all_results.extend(await self.niah_suite.run(progress_callback=niah_progress))

        if self.config.run_multi_hop:

            def multihop_progress(completed: int, total: int) -> None:
                if progress_callback:
                    progress_callback("Multi-hop", completed, total)

            all_results.extend(await self.multihop_suite.run(progress_callback=multihop_progress))

        return self._build_results(all_results, started)

    def _build_results(
        self,
        results: list[ContextBenchResult],
        started: float,
    ) -> ContextBenchResults:
        duration_ms = (time.time() - started) * 1000
        analyzer = PositionAnalyzer(results)
        stats = analyzer.get_summary_stats()
        position_accuracies = analyzer.calculate_position_accuracy()
        length_accuracies = analyzer.calculate_length_accuracy()
        heatmap, heatmap_lengths, heatmap_positions = analyzer.generate_position_heatmap()

        total = int(stats.get("total_tasks", 0))
        passed = int(stats.get("correct_tasks", 0))
        type_accuracies = self._calculate_type_accuracies(results)
        multi_hop_rates = self.multihop_suite.calculate_hop_accuracy(results)
        overall_accuracy = float(stats.get("overall_accuracy", 0.0))

        metrics = ContextBenchMetrics(
            total_tasks=total,
            passed_tasks=passed,
            failed_tasks=total - passed,
            overall_accuracy=overall_accuracy,
            avg_semantic_similarity=float(stats.get("avg_semantic_similarity", 0.0)),
            position_accuracies=position_accuracies,
            lost_in_middle_score=float(stats.get("lost_in_middle_severity", 0.0)),
            length_accuracies=length_accuracies,
            context_degradation_rate=float(stats.get("context_degradation_rate", 0.0)),
            type_accuracies=type_accuracies,
            multi_hop_success_rates=multi_hop_rates,
            avg_latency_ms=float(stats.get("avg_latency_ms", 0.0)),
            avg_tokens_per_task=(
                int(sum(r.tokens_processed for r in results) / total) if total else 0
            ),
            total_duration_ms=duration_ms,
        )

        return ContextBenchResults(
            config=self.config,
            metrics=metrics,
            results=results,
            position_heatmap=heatmap,
            position_heatmap_lengths=heatmap_lengths,
            position_heatmap_positions=heatmap_positions,
            comparison_to_leaderboard=self._compare_to_leaderboard(overall_accuracy),
            summary=self._build_summary(metrics),
            metadata={
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "runner": "ContextBenchRunner",
                "seed": self.seed if self.seed is not None else "",
            },
        )

    @staticmethod
    def _calculate_type_accuracies(
        results: list[ContextBenchResult],
    ) -> dict[ContextBenchType, float]:
        grouped: dict[ContextBenchType, list[ContextBenchResult]] = defaultdict(list)
        for result in results:
            grouped[result.bench_type].append(result)
        return {
            bench_type: sum(r.retrieval_success for r in grouped_results) / len(grouped_results)
            for bench_type, grouped_results in grouped.items()
            if grouped_results
        }

    @staticmethod
    def _compare_to_leaderboard(
        overall_accuracy: float,
    ) -> dict[str, dict[str, float]]:
        return {
            model: {
                "overall": scores.get("overall", 0.0),
                "delta": overall_accuracy - scores.get("overall", 0.0),
            }
            for model, scores in LEADERBOARD_SCORES.items()
        }

    @staticmethod
    def _build_summary(metrics: ContextBenchMetrics) -> dict[str, str | list[str]]:
        findings: list[str] = []
        recommendations: list[str] = []

        if metrics.total_tasks == 0:
            status = "no_tasks"
            findings.append("No benchmark tasks were executed.")
            recommendations.append("Enable at least one benchmark suite.")
        else:
            status = "completed"
            findings.append(f"Completed {metrics.total_tasks} context retrieval tasks.")
            if metrics.lost_in_middle_score > 0.1:
                findings.append("Detected lower accuracy for middle-position needles.")
            if metrics.context_degradation_rate > 0.1:
                findings.append("Accuracy degraded as context length increased.")
            if metrics.overall_accuracy < 0.8:
                recommendations.append("Inspect failed detailed results before comparing models.")

        return {
            "status": status,
            "overall_accuracy": f"{metrics.overall_accuracy:.1%}",
            "findings": findings,
            "recommendations": recommendations,
        }


async def quick_test(llm_query_fn: LLMQueryFn) -> ContextBenchResults:
    """Run a minimal quick test with the provided query function."""
    config = ContextBenchConfig(
        context_lengths=[512],
        positions=[NeedlePosition.MIDDLE],
        tasks_per_position=1,
        run_niah_basic=True,
        run_niah_semantic=False,
        run_multi_hop=False,
    )
    runner = ContextBenchRunner(config=config, llm_query_fn=llm_query_fn)
    return await runner.run_position_sweep()


async def run_eliza_benchmark(
    config: ContextBenchConfig | None = None,
    client: object | None = None,
) -> ContextBenchResults:
    """Run ContextBench through the eliza TypeScript benchmark bridge."""
    from eliza_adapter.context_bench import make_eliza_llm_query

    runner = ContextBenchRunner(
        config=config,
        llm_query_fn=make_eliza_llm_query(client=client),  # type: ignore[arg-type]
    )
    return await runner.run_full_benchmark()
