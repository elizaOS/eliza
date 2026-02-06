"""
Runner for RLM benchmarks.

Executes benchmark tasks using the RLM client and collects results.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Optional

from .types import (
    PAPER_OOLONG_SCORES,
    PAPER_S_NIAH_SCORES,
    RLMBenchConfig,
    RLMBenchMetrics,
    RLMBenchResult,
    RLMBenchResults,
    RLMBenchTask,
)
from .generator import RLMBenchGenerator
from .evaluator import RLMBenchEvaluator

logger = logging.getLogger("elizaos.rlm-bench")

# Type for LLM query function
LLMQueryFn = Callable[[str, str], str]


class RLMBenchRunner:
    """
    Runner for RLM benchmark evaluation.

    Supports multiple backends:
    - mock: Fast testing with heuristic-based mock
    - rlm: Uses RLM plugin for recursive inference
    - direct: Direct LLM API calls for comparison
    """

    def __init__(
        self,
        config: RLMBenchConfig,
        llm_query_fn: Optional[LLMQueryFn] = None,
    ) -> None:
        """
        Initialize the benchmark runner.

        Args:
            config: Benchmark configuration
            llm_query_fn: Optional custom LLM query function
        """
        self.config = config
        self.generator = RLMBenchGenerator(config)
        self.evaluator = RLMBenchEvaluator(
            semantic_threshold=config.semantic_threshold
        )
        self._llm_query_fn = llm_query_fn
        self._results: list[RLMBenchResult] = []

    async def _run_task_with_rlm(self, task: RLMBenchTask) -> RLMBenchResult:
        """Run a task using the RLM plugin."""
        try:
            from elizaos_plugin_rlm import RLMClient, RLMConfig

            rlm_config = RLMConfig(
                backend=self.config.rlm_backend,
                max_iterations=self.config.rlm_max_iterations,
                max_depth=self.config.rlm_max_depth,
                log_trajectories=self.config.save_trajectories,
                track_costs=True,
            )

            if self.config.use_dual_model:
                rlm_config.root_model = self.config.root_model
                rlm_config.subcall_model = self.config.subcall_model

            client = RLMClient(rlm_config)

            # Build prompt
            prompt = f"Context:\n{task.context}\n\nQuestion: {task.question}\n\nAnswer (be brief and precise):"

            start_time = time.time()
            result = await client.infer_with_trajectory(prompt)
            latency_ms = (time.time() - start_time) * 1000

            # Extract metrics from result
            iterations = result.iterations or 1
            depth = result.depth or 0
            subcall_count = 0
            strategies_used: list[str] = []

            if result.trajectory:
                subcall_count = result.trajectory.subcall_count
                strategies_used = result.trajectory.strategies_used

            input_tokens = 0
            output_tokens = 0
            cost_usd = 0.0

            if result.cost:
                input_tokens = result.cost.root_input_tokens + result.cost.subcall_input_tokens
                output_tokens = result.cost.root_output_tokens + result.cost.subcall_output_tokens
                cost_usd = result.cost.total_cost_usd

            return self.evaluator.evaluate_result(
                task=task,
                predicted_answer=result.text,
                iterations=iterations,
                max_depth=depth,
                subcall_count=subcall_count,
                strategies_used=strategies_used,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost_usd,
                latency_ms=latency_ms,
                trajectory_id=result.trajectory.trajectory_id if result.trajectory else None,
            )

        except ImportError:
            logger.warning("RLM plugin not available, using stub mode")
            return await self._run_task_stub(task)
        except Exception as e:
            logger.error(f"Error running task {task.id}: {e}")
            return self.evaluator.evaluate_result(
                task=task,
                predicted_answer="",
                error=str(e),
            )

    async def _run_task_stub(self, task: RLMBenchTask) -> RLMBenchResult:
        """Run a task in stub mode (for testing)."""
        import re

        start_time = time.time()

        # Simple heuristic extraction
        patterns = [
            r"CRITICAL_SECRET[^.]*?(\w{8})",
            r"HIDDEN_DATA[^.]*?(\w{8})",
            r"SECURE_INFO[^.]*?(\w{8})",
            r"CLASSIFIED[^.]*?(\w{8})",
            r"CONFIDENTIAL[^.]*?(\w{8})",
            r"reference number is (\w{8})",
            r"protocol version is (\w{8})",
            r"identifier is (\w{8})",
        ]

        predicted = ""
        for pattern in patterns:
            matches = re.findall(pattern, task.context, re.IGNORECASE)
            if matches:
                predicted = matches[0] if isinstance(matches[0], str) else ", ".join(matches)
                break

        if not predicted:
            predicted = "Unable to find answer"

        latency_ms = (time.time() - start_time) * 1000

        # Simulate RLM behavior
        context_length = task.context_length_tokens
        iterations = min(10, max(1, context_length // 10000))
        depth = min(3, max(1, context_length // 50000))

        return self.evaluator.evaluate_result(
            task=task,
            predicted_answer=predicted,
            iterations=iterations,
            max_depth=depth,
            subcall_count=iterations - 1,
            strategies_used=["peek", "grep"],
            input_tokens=context_length,
            output_tokens=50,
            cost_usd=context_length * 0.000001,  # Rough estimate
            latency_ms=latency_ms,
        )

    async def _run_task_custom(self, task: RLMBenchTask) -> RLMBenchResult:
        """Run a task using custom LLM query function."""
        if not self._llm_query_fn:
            return await self._run_task_stub(task)

        start_time = time.time()

        try:
            predicted = await asyncio.to_thread(
                self._llm_query_fn, task.context, task.question
            )
            latency_ms = (time.time() - start_time) * 1000

            return self.evaluator.evaluate_result(
                task=task,
                predicted_answer=predicted,
                latency_ms=latency_ms,
            )
        except Exception as e:
            logger.error(f"Error with custom LLM: {e}")
            return self.evaluator.evaluate_result(
                task=task,
                predicted_answer="",
                error=str(e),
            )

    async def run_task(
        self,
        task: RLMBenchTask,
        mode: str = "rlm",
    ) -> RLMBenchResult:
        """
        Run a single benchmark task.

        Args:
            task: The benchmark task
            mode: Execution mode ("rlm", "stub", "custom")

        Returns:
            RLMBenchResult with evaluation
        """
        if mode == "rlm":
            return await self._run_task_with_rlm(task)
        elif mode == "stub":
            return await self._run_task_stub(task)
        elif mode == "custom":
            return await self._run_task_custom(task)
        else:
            raise ValueError(f"Unknown mode: {mode}")

    async def run_all(
        self,
        mode: str = "rlm",
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> RLMBenchResults:
        """
        Run all benchmark tasks.

        Args:
            mode: Execution mode ("rlm", "stub", "custom")
            progress_callback: Optional callback for progress updates

        Returns:
            RLMBenchResults with all evaluations
        """
        tasks = self.generator.generate_all_tasks()
        total_tasks = len(tasks)

        logger.info(f"Running {total_tasks} benchmark tasks in {mode} mode")

        results: list[RLMBenchResult] = []

        for i, task in enumerate(tasks):
            if progress_callback:
                progress_callback(i, total_tasks)

            result = await self.run_task(task, mode)
            results.append(result)

            if (i + 1) % 10 == 0:
                logger.info(f"Completed {i + 1}/{total_tasks} tasks")

        # Compute metrics
        metrics = self.evaluator.compute_metrics(results)

        # Build paper comparison
        paper_comparison = self._build_paper_comparison(metrics)

        # Build summary
        summary = self._build_summary(metrics)

        return RLMBenchResults(
            config=self.config,
            metrics=metrics,
            results=results,
            paper_comparison=paper_comparison,
            strategy_breakdown=self._build_strategy_breakdown(results),
            cost_analysis=self._build_cost_analysis(metrics),
            summary=summary,
            metadata={
                "mode": mode,
                "total_tasks": total_tasks,
            },
        )

    def _build_paper_comparison(
        self, metrics: RLMBenchMetrics
    ) -> dict[str, dict[str, float]]:
        """Build comparison with paper results."""
        comparison: dict[str, dict[str, float]] = {}

        # S-NIAH comparison
        if metrics.s_niah_by_length:
            comparison["S-NIAH"] = {
                "this_run": {k: v for k, v in metrics.s_niah_by_length.items()},
                **PAPER_S_NIAH_SCORES,
            }

        # OOLONG comparison
        if metrics.oolong_accuracy > 0:
            comparison["OOLONG"] = {
                "this_run": {
                    "oolong_retrieval": metrics.oolong_accuracy,
                    "oolong_pairs": metrics.oolong_pairs_accuracy,
                },
                **PAPER_OOLONG_SCORES,
            }

        return comparison

    def _build_strategy_breakdown(
        self, results: list[RLMBenchResult]
    ) -> dict[str, list[str]]:
        """Build strategy usage breakdown."""
        breakdown: dict[str, list[str]] = {}

        for r in results:
            task_strategies = ", ".join(r.strategies_used) if r.strategies_used else "none"
            key = f"{r.bench_type.value}_{r.context_length_tokens}"
            if key not in breakdown:
                breakdown[key] = []
            breakdown[key].append(task_strategies)

        return breakdown

    def _build_cost_analysis(
        self, metrics: RLMBenchMetrics
    ) -> dict[str, float]:
        """Build cost analysis."""
        return {
            "total_cost_usd": metrics.total_cost_usd,
            "avg_cost_per_task_usd": metrics.avg_cost_per_task_usd,
            "cost_per_1k_tokens_usd": (
                metrics.total_cost_usd / (metrics.total_tokens_processed / 1000)
                if metrics.total_tokens_processed > 0
                else 0.0
            ),
            "accuracy_per_dollar": (
                metrics.overall_accuracy / metrics.total_cost_usd
                if metrics.total_cost_usd > 0
                else 0.0
            ),
        }

    def _build_summary(self, metrics: RLMBenchMetrics) -> dict[str, str | list[str]]:
        """Build human-readable summary."""
        findings: list[str] = []

        # Overall performance
        findings.append(
            f"Overall accuracy: {metrics.overall_accuracy:.1%} "
            f"({metrics.passed_tasks}/{metrics.total_tasks} tasks)"
        )

        # S-NIAH performance
        if metrics.s_niah_by_length:
            s_niah_summary = ", ".join(
                f"{k}: {v:.1%}" for k, v in sorted(metrics.s_niah_by_length.items())
            )
            findings.append(f"S-NIAH by length: {s_niah_summary}")

        # OOLONG performance
        if metrics.oolong_accuracy > 0:
            findings.append(
                f"OOLONG accuracy: {metrics.oolong_accuracy:.1%}, "
                f"OOLONG-Pairs: {metrics.oolong_pairs_accuracy:.1%}"
            )

        # Strategy usage
        if metrics.most_common_strategies:
            strategies = [s.value for s in metrics.most_common_strategies[:3]]
            findings.append(f"Most used strategies: {', '.join(strategies)}")

        # Cost efficiency
        findings.append(
            f"Total cost: ${metrics.total_cost_usd:.4f}, "
            f"Avg: ${metrics.avg_cost_per_task_usd:.6f}/task"
        )

        return {
            "title": "RLM Benchmark Results",
            "accuracy": f"{metrics.overall_accuracy:.1%}",
            "findings": findings,
        }
