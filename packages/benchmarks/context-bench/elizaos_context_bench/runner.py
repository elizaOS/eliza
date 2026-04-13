"""Context Benchmark Runner.

Main orchestrator for running context benchmarks and collecting results.
Integrates with ElizaOS Python runtime.

Supports three modes:
1. Direct LLM query (llm_query_fn) - tests model layer only
2. Eliza model layer (run_eliza_benchmark) - tests runtime.use_model()
3. Full agent loop (run_eliza_agent_benchmark) - tests providers/actions/evaluators
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

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

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


# Type for the LLM query function
LLMQueryFn = Callable[[str, str], Awaitable[str]]

# Default concurrency limit
DEFAULT_CONCURRENCY = 5


class ContextBenchRunner:
    """Main runner for context benchmarks."""

    def __init__(
        self,
        config: ContextBenchConfig | None = None,
        llm_query_fn: LLMQueryFn | None = None,
        embedding_fn: Callable[[str], list[float]] | None = None,
        seed: int | None = 42,
    ):
        """Initialize the benchmark runner.

        Args:
            config: Benchmark configuration.
            llm_query_fn: Async function to query LLM with (context, question) -> answer.
            embedding_fn: Optional function for semantic similarity.
            seed: Random seed for reproducibility.

        """
        self.config = config or ContextBenchConfig()
        self.llm_query_fn = llm_query_fn
        self.embedding_fn = embedding_fn
        self.seed = seed

        # Initialize suites
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

        self._results: list[ContextBenchResult] = []
        self._start_time: float = 0.0

    def set_llm_query_fn(self, fn: LLMQueryFn) -> None:
        """Set the LLM query function."""
        self.llm_query_fn = fn
        self.niah_suite.llm_query_fn = fn
        self.multihop_suite.llm_query_fn = fn

    def set_concurrency(self, concurrency: int) -> None:
        """Set the concurrency level.

        Args:
            concurrency: Maximum number of concurrent task executions.

        """
        self.concurrency = max(1, concurrency)
        self._semaphore = None  # Reset semaphore

    async def run_full_benchmark(
        self,
        progress_callback: Callable[[str, int, int], None] | None = None,
        use_concurrency: bool = False,
    ) -> ContextBenchResults:
        """Run the complete context benchmark.

        Args:
            progress_callback: Optional callback(suite_name, completed, total).

        Returns:
            ContextBenchResults with all metrics and results.

        """
        self._start_time = time.time()
        self._results = []

        def niah_progress(completed: int, total: int) -> None:
            if progress_callback:
                progress_callback("NIAH", completed, total)

        def multihop_progress(completed: int, total: int) -> None:
            if progress_callback:
                progress_callback("Multi-hop", completed, total)

        # Run NIAH suite
        if self.config.run_niah_basic or self.config.run_niah_semantic:
            niah_results = await self.niah_suite.run(progress_callback=niah_progress)
            self._results.extend(niah_results)

        # Run Multi-hop suite
        if self.config.run_multi_hop:
            multihop_results = await self.multihop_suite.run(
                progress_callback=multihop_progress
            )
            self._results.extend(multihop_results)

        return self._aggregate_results()

    async def run_quick_eval(self) -> ContextBenchResults:
        """Run a quick evaluation with reduced task count.

        Returns:
            ContextBenchResults with limited results.

        """
        self._start_time = time.time()
        self._results = []

        # Run quick NIAH evaluation
        niah_results = await self.niah_suite.run_quick_eval()
        self._results.extend(niah_results)

        return self._aggregate_results()

    async def run_position_sweep(
        self,
        context_lengths: list[int] | None = None,
        positions: list[NeedlePosition] | None = None,
    ) -> ContextBenchResults:
        """Run a position sweep benchmark.

        Args:
            context_lengths: Context lengths to test.
            positions: Needle positions to test.

        Returns:
            ContextBenchResults from the sweep.

        """
        self._start_time = time.time()
        self._results = []

        results = await self.niah_suite.run_position_sweep(
            context_lengths=context_lengths,
            positions=positions,
        )
        self._results.extend(results)

        return self._aggregate_results()

    def _aggregate_results(self) -> ContextBenchResults:
        """Aggregate all results into comprehensive metrics."""
        total_duration = (time.time() - self._start_time) * 1000

        # Use position analyzer
        analyzer = PositionAnalyzer(self._results)
        summary_stats = analyzer.get_summary_stats()

        # Calculate position accuracies
        position_accuracies = analyzer.calculate_position_accuracy()
        length_accuracies = analyzer.calculate_length_accuracy()

        # Calculate type accuracies
        type_accuracies = self._calculate_type_accuracies()

        # Multi-hop analysis
        multi_hop_rates = self.multihop_suite.calculate_hop_accuracy(self._results)

        # Lost in middle
        _, lim_severity = analyzer.detect_lost_in_middle()

        # Context degradation
        degradation_rate = analyzer.calculate_context_degradation()

        # Safely extract numeric values from summary stats with proper type handling
        total_tasks_raw = summary_stats.get("total_tasks", 0)
        total_tasks = int(total_tasks_raw) if isinstance(total_tasks_raw, (int, float)) else 0

        correct_tasks_raw = summary_stats.get("correct_tasks", 0)
        correct_tasks = int(correct_tasks_raw) if isinstance(correct_tasks_raw, (int, float)) else 0

        overall_accuracy_raw = summary_stats.get("overall_accuracy", 0.0)
        overall_accuracy = float(overall_accuracy_raw) if isinstance(overall_accuracy_raw, (int, float)) else 0.0

        avg_similarity_raw = summary_stats.get("avg_semantic_similarity", 0.0)
        avg_similarity = float(avg_similarity_raw) if isinstance(avg_similarity_raw, (int, float)) else 0.0

        avg_latency_raw = summary_stats.get("avg_latency_ms", 0.0)
        avg_latency = float(avg_latency_raw) if isinstance(avg_latency_raw, (int, float)) else 0.0

        # Create metrics
        metrics = ContextBenchMetrics(
            total_tasks=total_tasks,
            passed_tasks=correct_tasks,
            failed_tasks=total_tasks - correct_tasks,
            overall_accuracy=overall_accuracy,
            avg_semantic_similarity=avg_similarity,
            position_accuracies=position_accuracies,
            lost_in_middle_score=lim_severity,
            length_accuracies=length_accuracies,
            context_degradation_rate=degradation_rate,
            type_accuracies=type_accuracies,
            multi_hop_success_rates=multi_hop_rates,
            avg_latency_ms=avg_latency,
            avg_tokens_per_task=int(
                sum(r.tokens_processed for r in self._results) / max(1, len(self._results))
            ),
            total_duration_ms=total_duration,
        )

        # Generate heatmap data (+ labels so reporting can't mislabel axes)
        heatmap_data: list[list[float]] | None = None
        heatmap_lengths: list[int] | None = None
        heatmap_positions: list[NeedlePosition] | None = None
        if self.config.generate_heatmap:
            heatmap, lengths, positions = analyzer.generate_position_heatmap()
            heatmap_data = heatmap
            heatmap_lengths = lengths
            heatmap_positions = positions

        # Compare to leaderboard
        comparison = self._compare_to_leaderboard(metrics)

        # Generate summary
        summary = self._generate_summary(metrics, comparison)

        return ContextBenchResults(
            config=self.config,
            metrics=metrics,
            results=self._results,
            position_heatmap=heatmap_data,
            position_heatmap_lengths=heatmap_lengths,
            position_heatmap_positions=heatmap_positions,
            comparison_to_leaderboard=comparison,
            summary=summary,
            metadata={
                "timestamp": datetime.now().isoformat(),
                "seed": self.seed or 0,
                "total_duration_ms": total_duration,
            },
        )

    def _calculate_type_accuracies(self) -> dict[ContextBenchType, float]:
        """Calculate accuracy by benchmark type."""
        from collections import defaultdict

        type_results: dict[ContextBenchType, list[bool]] = defaultdict(list)

        for result in self._results:
            type_results[result.bench_type].append(result.retrieval_success)

        accuracies: dict[ContextBenchType, float] = {}
        for bench_type, successes in type_results.items():
            if successes:
                accuracies[bench_type] = sum(successes) / len(successes)

        return accuracies

    def _compare_to_leaderboard(
        self, metrics: ContextBenchMetrics
    ) -> dict[str, dict[str, float]]:
        """Compare results to leaderboard scores."""
        comparison: dict[str, dict[str, float]] = {}

        for model_name, scores in LEADERBOARD_SCORES.items():
            model_comparison: dict[str, float] = {}

            # Compare overall accuracy
            model_comparison["overall_diff"] = (
                metrics.overall_accuracy - scores.get("overall", 0)
            )

            # Compare lost in middle
            model_comparison["lost_in_middle_diff"] = scores.get(
                "lost_in_middle", 0
            ) - metrics.lost_in_middle_score

            # Compare by context length
            for length, acc in metrics.length_accuracies.items():
                key = f"niah_{length // 1024}k"
                if key in scores:
                    model_comparison[f"{key}_diff"] = acc.accuracy - scores[key]

            # Compare multi-hop
            for num_hops, rate in metrics.multi_hop_success_rates.items():
                key = f"multi_hop_{num_hops}"
                if key in scores:
                    model_comparison[f"{key}_diff"] = rate - scores[key]

            comparison[model_name] = model_comparison

        return comparison

    def _generate_summary(
        self,
        metrics: ContextBenchMetrics,
        comparison: dict[str, dict[str, float]],
    ) -> dict[str, str | list[str]]:
        """Generate human-readable summary of results."""
        findings: list[str] = []
        recommendations: list[str] = []

        # Overall accuracy assessment
        if metrics.overall_accuracy >= 0.95:
            findings.append("Excellent overall retrieval accuracy (≥95%)")
        elif metrics.overall_accuracy >= 0.85:
            findings.append("Good overall retrieval accuracy (85-95%)")
        elif metrics.overall_accuracy >= 0.70:
            findings.append("Moderate retrieval accuracy (70-85%)")
        else:
            findings.append("Low retrieval accuracy (<70%)")
            recommendations.append("Consider using a model with better context handling")

        # Lost in middle analysis
        if metrics.lost_in_middle_score > 0.2:
            findings.append(
                f"Significant 'lost in middle' effect detected ({metrics.lost_in_middle_score:.1%} drop)"
            )
            recommendations.append(
                "Consider chunking strategies or retrieval augmentation for middle content"
            )
        elif metrics.lost_in_middle_score > 0.1:
            findings.append(
                f"Mild 'lost in middle' effect ({metrics.lost_in_middle_score:.1%} drop)"
            )

        # Context degradation
        if metrics.context_degradation_rate > 0.1:
            findings.append(
                f"Notable context degradation ({metrics.context_degradation_rate:.1%} per doubling)"
            )
            recommendations.append(
                "Use shorter contexts or implement progressive summarization"
            )

        # Multi-hop reasoning
        if metrics.multi_hop_success_rates:
            for hops, rate in metrics.multi_hop_success_rates.items():
                if rate < 0.5:
                    findings.append(
                        f"Struggles with {hops}-hop reasoning ({rate:.1%} success)"
                    )
                    recommendations.append(
                        f"Consider chain-of-thought prompting for {hops}+ hop questions"
                    )

        # Comparison to best models
        best_comparison = comparison.get("claude-3-opus", {})
        overall_diff = best_comparison.get("overall_diff", 0)
        if overall_diff >= 0:
            findings.append(
                f"Performance matches or exceeds Claude-3-Opus baseline (+{overall_diff:.1%})"
            )
        elif overall_diff > -0.1:
            findings.append(f"Performance within 10% of Claude-3-Opus ({overall_diff:.1%})")
        else:
            findings.append(f"Performance below Claude-3-Opus ({overall_diff:.1%})")

        status = "excellent" if metrics.overall_accuracy >= 0.9 else "good" if metrics.overall_accuracy >= 0.75 else "needs_improvement"

        return {
            "status": status,
            "overall_accuracy": f"{metrics.overall_accuracy:.1%}",
            "findings": findings,
            "recommendations": recommendations,
        }


async def run_eliza_benchmark(
    runtime: "IAgentRuntime",
    config: ContextBenchConfig | None = None,
) -> ContextBenchResults:
    """Run context benchmark using an ElizaOS runtime.

    Args:
        runtime: ElizaOS Python runtime instance.
        config: Optional benchmark configuration.

    Returns:
        ContextBenchResults with all metrics.

    """
    from elizaos.types.model import ModelType

    if not runtime.has_model(ModelType.TEXT_LARGE):
        raise RuntimeError(
            "Eliza runtime has no TEXT_LARGE model registered. "
            "Register a model plugin (e.g. the OpenAI plugin) before running context-bench."
        )

    async def llm_query(context: str, question: str) -> str:
        """Query the ElizaOS runtime for an answer."""
        system = (
            "You are a helpful assistant that answers questions based ONLY on the provided context. "
            "Return ONLY the answer text (no extra words, no markdown)."
        )
        prompt = f"""Given the following context, answer the question precisely and concisely.

Context:
{context}

Question: {question}

Answer (be brief and precise):"""

        result = await runtime.use_model(
            ModelType.TEXT_LARGE,
            {"prompt": prompt, "system": system, "maxTokens": 256, "temperature": 0.0},
        )
        return str(result)

    runner = ContextBenchRunner(config=config, llm_query_fn=llm_query)
    return await runner.run_full_benchmark()


# Convenience function for quick testing
async def quick_test(
    llm_query_fn: LLMQueryFn,
) -> ContextBenchResults:
    """Quick test with minimal configuration.

    Args:
        llm_query_fn: Function to query the LLM.

    Returns:
        ContextBenchResults from quick evaluation.

    """
    runner = ContextBenchRunner(llm_query_fn=llm_query_fn)
    return await runner.run_quick_eval()


# ============================================================================
# Full Agent Loop Benchmarking
# ============================================================================


async def run_eliza_agent_benchmark(
    runtime: "IAgentRuntime",
    config: ContextBenchConfig | None = None,
    concurrency: int = 1,
    progress_callback: Callable[[str, int, int], None] | None = None,
) -> ContextBenchResults:
    """Run context benchmark using the FULL Eliza agent loop.

    This function exercises the complete Eliza canonical flow:
    1. Provider injects benchmark context into state
    2. Message service builds prompt from state
    3. Model generates response with actions
    4. Actions are processed
    5. Evaluators assess response quality

    This is the most comprehensive benchmark mode, testing not just the
    model layer but the entire agent architecture.

    Args:
        runtime: Initialized ElizaOS runtime with context bench plugin registered.
        config: Optional benchmark configuration.
        concurrency: Number of concurrent tasks (default 1 for sequential).
        progress_callback: Optional callback(suite_name, completed, total).

    Returns:
        ContextBenchResults with all metrics.

    """
    from elizaos_context_bench.eliza_plugin import (
        BenchmarkSession,
        run_benchmark_task_through_agent,
        set_benchmark_session,
    )
    from elizaos_plugin_trajectory_logger.export import (
        ExportOptions,
        export_for_openpipe_art,
        export_grouped_for_grpo,
    )
    from elizaos_plugin_trajectory_logger.types import Trajectory

    benchmark_config = config or ContextBenchConfig()
    results: list[ContextBenchResult] = []
    start_time = time.time()

    # Trajectory capture is provided by the runtime service registered by
    # plugin-trajectory-logger (see setup_benchmark_runtime()).
    trajectories: list[Trajectory] = []

    # Generate all tasks using the same suite logic as the non-agent runner.
    # This keeps task counts consistent (e.g., full run totals 130 tasks).
    tasks = []
    niah_suite = NIAHBenchmarkSuite(config=benchmark_config, seed=42)
    multihop_suite = MultiHopBenchmarkSuite(config=benchmark_config, seed=42)
    tasks.extend(niah_suite.generate_tasks())
    tasks.extend(multihop_suite.generate_tasks())

    total_tasks = len(tasks)
    completed = 0
    semaphore = asyncio.Semaphore(concurrency)

    async def run_single(task) -> ContextBenchResult:
        """Run a single task through the agent loop."""
        nonlocal completed
        task_id = task.id
        context = task.context
        question = task.question
        expected = task.expected_answer
        needle = task.needle
        bench_type = task.bench_type
        ctx_len = task.context_length
        position = task.needle_position

        async with semaphore:
            # Create a dedicated session for this task
            session = BenchmarkSession()
            set_benchmark_session(session)

            try:
                evaluation = await run_benchmark_task_through_agent(
                    runtime=runtime,
                    session=session,
                    task_id=task_id,
                    context=context,
                    question=question,
                    expected_answer=expected,
                    needle=needle,
                    trajectory_collector=trajectories,
                )

                # Convert to ContextBenchResult
                result = ContextBenchResult(
                    task_id=task_id,
                    bench_type=bench_type,
                    context_length=ctx_len,
                    needle_position=position,
                    actual_position_pct=task.actual_position_pct,
                    predicted_answer=evaluation.predicted_answer,
                    expected_answer=evaluation.expected_answer,
                    exact_match=evaluation.exact_match,
                    semantic_similarity=evaluation.semantic_similarity,
                    retrieval_success=evaluation.retrieval_success,
                    latency_ms=evaluation.latency_ms,
                    tokens_processed=ctx_len,
                    num_hops=task.num_hops,
                    error=evaluation.error,
                )

                completed += 1
                if progress_callback:
                    progress_callback("Agent Loop", completed, total_tasks)

                return result

            except Exception as e:
                completed += 1
                if progress_callback:
                    progress_callback("Agent Loop", completed, total_tasks)

                return ContextBenchResult(
                    task_id=task_id,
                    bench_type=ContextBenchType.NIAH_BASIC,
                    context_length=ctx_len,
                    needle_position=position,
                    actual_position_pct=0.5,
                    predicted_answer="",
                    expected_answer=expected,
                    exact_match=False,
                    semantic_similarity=0.0,
                    retrieval_success=False,
                    latency_ms=0.0,
                    tokens_processed=ctx_len,
                    error=str(e),
                )

    # Run tasks with concurrency
    if concurrency > 1:
        task_results = await asyncio.gather(*[run_single(t) for t in tasks])
        results.extend(task_results)
    else:
        for task_data in tasks:
            result = await run_single(task_data)
            results.append(result)

    # Aggregate results
    total_duration = (time.time() - start_time) * 1000
    analyzer = PositionAnalyzer(results)
    summary_stats = analyzer.get_summary_stats()

    position_accuracies = analyzer.calculate_position_accuracy()
    length_accuracies = analyzer.calculate_length_accuracy()

    # Type accuracies
    type_accuracies: dict[ContextBenchType, float] = {}
    from collections import defaultdict
    type_results: dict[ContextBenchType, list[bool]] = defaultdict(list)
    for result in results:
        type_results[result.bench_type].append(result.retrieval_success)
    for bench_type, successes in type_results.items():
        if successes:
            type_accuracies[bench_type] = sum(successes) / len(successes)

    # Multi-hop rates
    multi_hop_rates: dict[int, float] = {}
    hop_results: dict[int, list[bool]] = defaultdict(list)
    for result in results:
        if result.num_hops > 1:
            hop_results[result.num_hops].append(result.retrieval_success)
    for hops, successes in hop_results.items():
        if successes:
            multi_hop_rates[hops] = sum(successes) / len(successes)

    # Extract stats safely
    total_tasks_val = int(summary_stats.get("total_tasks", 0)) if isinstance(summary_stats.get("total_tasks"), (int, float)) else 0
    correct_tasks = int(summary_stats.get("correct_tasks", 0)) if isinstance(summary_stats.get("correct_tasks"), (int, float)) else 0
    overall_accuracy = float(summary_stats.get("overall_accuracy", 0.0)) if isinstance(summary_stats.get("overall_accuracy"), (int, float)) else 0.0
    avg_similarity = float(summary_stats.get("avg_semantic_similarity", 0.0)) if isinstance(summary_stats.get("avg_semantic_similarity"), (int, float)) else 0.0
    avg_latency = float(summary_stats.get("avg_latency_ms", 0.0)) if isinstance(summary_stats.get("avg_latency_ms"), (int, float)) else 0.0

    _, lim_severity = analyzer.detect_lost_in_middle()
    degradation_rate = analyzer.calculate_context_degradation()

    metrics = ContextBenchMetrics(
        total_tasks=total_tasks_val,
        passed_tasks=correct_tasks,
        failed_tasks=total_tasks_val - correct_tasks,
        overall_accuracy=overall_accuracy,
        avg_semantic_similarity=avg_similarity,
        position_accuracies=position_accuracies,
        lost_in_middle_score=lim_severity,
        length_accuracies=length_accuracies,
        context_degradation_rate=degradation_rate,
        type_accuracies=type_accuracies,
        multi_hop_success_rates=multi_hop_rates,
        avg_latency_ms=avg_latency,
        avg_tokens_per_task=int(sum(r.tokens_processed for r in results) / max(1, len(results))),
        total_duration_ms=total_duration,
    )

    # Generate heatmap
    heatmap_data: list[list[float]] | None = None
    heatmap_lengths: list[int] | None = None
    heatmap_positions: list[NeedlePosition] | None = None
    if benchmark_config.generate_heatmap:
        heatmap, lengths, positions = analyzer.generate_position_heatmap()
        heatmap_data = heatmap
        heatmap_lengths = lengths
        heatmap_positions = positions

    # Summary
    findings: list[str] = []
    recommendations: list[str] = []

    if overall_accuracy >= 0.9:
        findings.append(f"Excellent agent loop performance ({overall_accuracy:.1%} accuracy)")
    elif overall_accuracy >= 0.7:
        findings.append(f"Good agent loop performance ({overall_accuracy:.1%} accuracy)")
    else:
        findings.append(f"Agent loop needs improvement ({overall_accuracy:.1%} accuracy)")
        recommendations.append("Review provider context injection and action handling")

    findings.append("Tested full Eliza canonical flow: Provider -> Model -> Action -> Evaluator")

    status = "excellent" if overall_accuracy >= 0.9 else "good" if overall_accuracy >= 0.75 else "needs_improvement"

    # Export trajectories for training/benchmarks (ART + GRPO grouping)
    trajectory_exports: dict[str, str] = {}
    try:
        output_dir = getattr(benchmark_config, "output_dir", None)
        if isinstance(output_dir, str) and output_dir:
            traj_dir = Path(output_dir) / "trajectories"
            dataset_name = f"context-bench-eliza-agent-{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            options = ExportOptions(
                dataset_name=dataset_name,
                trajectories=trajectories,
                output_dir=str(traj_dir),
            )
            art_res = export_for_openpipe_art(options)
            grpo_res = export_grouped_for_grpo(options)
            if art_res.dataset_url:
                trajectory_exports["art"] = art_res.dataset_url
            if grpo_res.dataset_url:
                trajectory_exports["grpo_groups"] = grpo_res.dataset_url
    except Exception:
        # Never fail the benchmark because export failed.
        trajectory_exports = {}

    return ContextBenchResults(
        config=benchmark_config,
        metrics=metrics,
        results=results,
        position_heatmap=heatmap_data,
        position_heatmap_lengths=heatmap_lengths,
        position_heatmap_positions=heatmap_positions,
        comparison_to_leaderboard={},
        summary={
            "status": status,
            "overall_accuracy": f"{overall_accuracy:.1%}",
            "findings": findings,
            "recommendations": recommendations,
            "mode": "full_agent_loop",
        },
        metadata={
            "timestamp": datetime.now().isoformat(),
            "seed": 42,
            "total_duration_ms": total_duration,
            "benchmark_mode": "eliza_agent_loop",
            "concurrency": concurrency,
            "trajectory_count": len(trajectories),
            "trajectory_exports": trajectory_exports,
        },
    )


async def setup_and_run_agent_benchmark(
    model_plugin_factory: Callable[[], "object"] | None = None,
    config: ContextBenchConfig | None = None,
    concurrency: int = 1,
    progress_callback: Callable[[str, int, int], None] | None = None,
) -> ContextBenchResults:
    """Set up Eliza runtime and run the full agent loop benchmark.

    This is a convenience function that:
    1. Creates an AgentRuntime
    2. Registers the model plugin
    3. Registers the context bench plugin
    4. Runs the benchmark

    Args:
        model_plugin_factory: Factory function to create model plugin.
        config: Benchmark configuration.
        concurrency: Number of concurrent tasks.
        progress_callback: Progress callback.

    Returns:
        Benchmark results.

    """
    # Use the canonical benchmark runtime setup (bootstrap enabled + Q&A-focused template)
    from elizaos_context_bench.eliza_plugin import setup_benchmark_runtime
    from elizaos.types.plugin import Plugin

    model_plugin: Plugin | None = None
    if model_plugin_factory is not None:
        candidate = model_plugin_factory()
        if isinstance(candidate, Plugin):
            model_plugin = candidate

    runtime = await setup_benchmark_runtime(model_plugin)

    try:
        # Run benchmark
        return await run_eliza_agent_benchmark(
            runtime=runtime,
            config=config,
            concurrency=concurrency,
            progress_callback=progress_callback,
        )
    finally:
        await runtime.stop()
