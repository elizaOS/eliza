"""Multi-hop Reasoning Benchmark Suite.

Implements benchmarks that require connecting multiple pieces of information
across the context to answer questions correctly.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable

from elizaos_context_bench.evaluators.retrieval import RetrievalEvaluator
from elizaos_context_bench.generator import ContextGenerator
from elizaos_context_bench.types import (
    ContextBenchConfig,
    ContextBenchResult,
    ContextBenchTask,
    ContextBenchType,
)

# Type for the LLM query function
LLMQueryFn = Callable[[str, str], Awaitable[str]]


class MultiHopBenchmarkSuite:
    """Multi-hop reasoning benchmark suite."""

    def __init__(
        self,
        config: ContextBenchConfig,
        llm_query_fn: LLMQueryFn | None = None,
        embedding_fn: Callable[[str], list[float]] | None = None,
        seed: int | None = 42,
    ):
        """Initialize the multi-hop benchmark suite.

        Args:
            config: Benchmark configuration.
            llm_query_fn: Async function to query LLM with (context, question) -> answer.
            embedding_fn: Optional function for semantic similarity.
            seed: Random seed for reproducibility.

        """
        self.config = config
        self.llm_query_fn = llm_query_fn
        self.generator = ContextGenerator(seed=seed)
        self.evaluator = RetrievalEvaluator(embedding_fn=embedding_fn)
        self._task_counter = 0

    def _get_next_task_id(self, num_hops: int) -> str:
        """Generate a unique task ID."""
        self._task_counter += 1
        return f"multihop_{num_hops}_{self._task_counter}"

    def generate_tasks(self) -> list[ContextBenchTask]:
        """Generate all multi-hop tasks based on configuration.

        Returns:
            List of ContextBenchTask instances.

        """
        tasks: list[ContextBenchTask] = []

        if not self.config.run_multi_hop:
            return tasks

        for length in self.config.context_lengths:
            for num_hops in self.config.multi_hop_depths:
                for _ in range(self.config.tasks_per_position):
                    task = self.generator.generate_multi_hop_task(
                        task_id=self._get_next_task_id(num_hops),
                        context_length=length,
                        num_hops=num_hops,
                    )
                    tasks.append(task)

        return tasks

    async def _run_single_task(
        self,
        task: ContextBenchTask,
    ) -> ContextBenchResult:
        """Run a single multi-hop task.

        Args:
            task: The task to run.

        Returns:
            ContextBenchResult with evaluation metrics.

        """
        if self.llm_query_fn is None:
            raise ValueError("No LLM query function provided")

        start_time = time.time()
        error: str | None = None
        predicted_answer = ""

        try:
            # Query the LLM
            raw_answer = await asyncio.wait_for(
                self.llm_query_fn(task.context, task.question),
                timeout=self.config.timeout_per_task_ms / 1000,
            )
            predicted_answer = str(raw_answer) if raw_answer is not None else ""
        except asyncio.TimeoutError:
            error = "Timeout exceeded"
        except Exception as e:
            error = str(e)

        if error is None and predicted_answer.strip() == "":
            error = "Empty response"

        latency_ms = (time.time() - start_time) * 1000

        # Evaluate the response (treat any runtime error as an automatic failure)
        if error is None:
            eval_result = self.evaluator.evaluate(
                predicted=predicted_answer,
                expected=task.expected_answer,
                needle=task.needle,
            )
            exact_match = bool(eval_result["exact_match"])
            semantic_similarity = float(eval_result["semantic_similarity"])
            retrieval_success = bool(eval_result["retrieval_success"])
            fuzzy_score = float(eval_result["fuzzy_score"])
            contains_answer = float(eval_result["contains_answer"])
        else:
            exact_match = False
            semantic_similarity = 0.0
            retrieval_success = False
            fuzzy_score = 0.0
            contains_answer = 0.0

        return ContextBenchResult(
            task_id=task.id,
            bench_type=task.bench_type,
            context_length=task.context_length,
            needle_position=task.needle_position,
            actual_position_pct=task.actual_position_pct,
            predicted_answer=predicted_answer,
            expected_answer=task.expected_answer,
            exact_match=exact_match,
            semantic_similarity=semantic_similarity,
            retrieval_success=retrieval_success,
            latency_ms=latency_ms,
            tokens_processed=task.context_length,
            num_hops=task.num_hops,
            error=error,
            metrics={
                "fuzzy_score": fuzzy_score,
                "contains_answer": contains_answer,
                "num_hops": float(task.num_hops),
            },
        )

    async def run_two_hop(
        self,
        context_lengths: list[int] | None = None,
    ) -> list[ContextBenchResult]:
        """Run 2-hop reasoning tasks.

        Args:
            context_lengths: Lengths to test.

        Returns:
            List of ContextBenchResult instances.

        """
        lengths = context_lengths or self.config.context_lengths
        results: list[ContextBenchResult] = []

        for length in lengths:
            for _ in range(self.config.tasks_per_position):
                task = self.generator.generate_multi_hop_task(
                    task_id=self._get_next_task_id(2),
                    context_length=length,
                    num_hops=2,
                )
                result = await self._run_single_task(task)
                results.append(result)

        return results

    async def run_chain_reasoning(
        self,
        num_hops: int,
        context_lengths: list[int] | None = None,
    ) -> list[ContextBenchResult]:
        """Run N-hop chain reasoning tasks.

        Args:
            num_hops: Number of reasoning hops.
            context_lengths: Lengths to test.

        Returns:
            List of ContextBenchResult instances.

        """
        lengths = context_lengths or self.config.context_lengths
        results: list[ContextBenchResult] = []

        for length in lengths:
            for _ in range(self.config.tasks_per_position):
                task = self.generator.generate_multi_hop_task(
                    task_id=self._get_next_task_id(num_hops),
                    context_length=length,
                    num_hops=num_hops,
                )
                result = await self._run_single_task(task)
                results.append(result)

        return results

    async def run(
        self,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[ContextBenchResult]:
        """Run the complete multi-hop benchmark suite.

        Args:
            progress_callback: Optional callback for progress updates.

        Returns:
            List of all ContextBenchResult instances.

        """
        tasks = self.generate_tasks()
        results: list[ContextBenchResult] = []
        total = len(tasks)

        for i, task in enumerate(tasks):
            result = await self._run_single_task(task)
            results.append(result)

            if progress_callback:
                progress_callback(i + 1, total)

        return results

    def calculate_hop_accuracy(
        self, results: list[ContextBenchResult]
    ) -> dict[int, float]:
        """Calculate accuracy by number of hops.

        Args:
            results: List of multi-hop results.

        Returns:
            Dictionary mapping num_hops to accuracy.

        """
        from collections import defaultdict

        hop_results: dict[int, list[bool]] = defaultdict(list)

        for result in results:
            if result.bench_type == ContextBenchType.MULTI_HOP:
                hop_results[result.num_hops].append(result.retrieval_success)

        accuracies: dict[int, float] = {}
        for num_hops, successes in hop_results.items():
            if successes:
                accuracies[num_hops] = sum(successes) / len(successes)

        return accuracies
