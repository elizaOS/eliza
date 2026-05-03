"""Needle-in-a-Haystack (NIAH) Benchmark Suite.

Implements the complete NIAH benchmark for evaluating context retrieval
across different positions and context lengths.
"""

import asyncio
import random
import time
from collections.abc import Awaitable, Callable

from elizaos_context_bench.evaluators.retrieval import RetrievalEvaluator
from elizaos_context_bench.generator import ContextGenerator
from elizaos_context_bench.types import (
    ContextBenchConfig,
    ContextBenchResult,
    ContextBenchTask,
    NeedlePosition,
    NeedleType,
)

# Type for the LLM query function
LLMQueryFn = Callable[[str, str], Awaitable[str]]

# Include multiple needle types to avoid a single-template benchmark.
_VALID_NIAH_NEEDLE_TYPES: list[NeedleType] = [
    NeedleType.FACT,
    NeedleType.NUMBER,
    NeedleType.DATE,
    NeedleType.NAME,
    NeedleType.CODE,
]


class NIAHBenchmarkSuite:
    """Complete Needle-in-a-Haystack benchmark suite."""

    def __init__(
        self,
        config: ContextBenchConfig,
        llm_query_fn: LLMQueryFn | None = None,
        embedding_fn: Callable[[str], list[float]] | None = None,
        seed: int | None = 42,
    ):
        """Initialize the NIAH benchmark suite.

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

    def _get_next_task_id(self, prefix: str = "niah") -> str:
        """Generate a unique task ID."""
        self._task_counter += 1
        return f"{prefix}_{self._task_counter}"

    def generate_tasks(self) -> list[ContextBenchTask]:
        """Generate all NIAH tasks based on configuration.

        Returns:
            List of ContextBenchTask instances.

        """
        tasks: list[ContextBenchTask] = []

        # Basic NIAH tasks
        if self.config.run_niah_basic:
            for length in self.config.context_lengths:
                for position in self.config.positions:
                    for _ in range(self.config.tasks_per_position):
                        needle_type = random.choice(_VALID_NIAH_NEEDLE_TYPES)
                        task = self.generator.generate_niah_task(
                            task_id=self._get_next_task_id("niah_basic"),
                            context_length=length,
                            position=position,
                            needle_type=needle_type,
                        )
                        tasks.append(task)

        # Semantic NIAH tasks (no lexical overlap)
        if self.config.run_niah_semantic:
            for length in self.config.context_lengths:
                for position in self.config.positions:
                    task = self.generator.generate_semantic_niah_task(
                        task_id=self._get_next_task_id("niah_semantic"),
                        context_length=length,
                        position=position,
                    )
                    tasks.append(task)

        return tasks

    async def _run_single_task(
        self,
        task: ContextBenchTask,
    ) -> ContextBenchResult:
        """Run a single NIAH task.

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
            },
        )

    async def run_position_sweep(
        self,
        context_lengths: list[int] | None = None,
        positions: list[NeedlePosition] | None = None,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[ContextBenchResult]:
        """Run NIAH across positions and context lengths.

        Args:
            context_lengths: Lengths to test (uses config if None).
            positions: Positions to test (uses config if None).
            progress_callback: Optional callback(completed, total) for progress.

        Returns:
            List of ContextBenchResult instances.

        """
        lengths = context_lengths or self.config.context_lengths
        pos_list = positions or self.config.positions

        tasks: list[ContextBenchTask] = []
        for length in lengths:
            for position in pos_list:
                for _ in range(self.config.tasks_per_position):
                    needle_type = random.choice(_VALID_NIAH_NEEDLE_TYPES)
                    task = self.generator.generate_niah_task(
                        task_id=self._get_next_task_id("niah_sweep"),
                        context_length=length,
                        position=position,
                        needle_type=needle_type,
                    )
                    tasks.append(task)

        results: list[ContextBenchResult] = []
        total = len(tasks)

        for i, task in enumerate(tasks):
            result = await self._run_single_task(task)
            results.append(result)

            if progress_callback:
                progress_callback(i + 1, total)

        return results

    async def run_semantic_niah(
        self,
        context_lengths: list[int] | None = None,
        positions: list[NeedlePosition] | None = None,
    ) -> list[ContextBenchResult]:
        """Run semantic NIAH tasks (no lexical overlap between needle and question).

        Args:
            context_lengths: Lengths to test.
            positions: Positions to test.

        Returns:
            List of ContextBenchResult instances.

        """
        lengths = context_lengths or self.config.context_lengths
        pos_list = positions or self.config.positions

        results: list[ContextBenchResult] = []

        for length in lengths:
            for position in pos_list:
                task = self.generator.generate_semantic_niah_task(
                    task_id=self._get_next_task_id("niah_semantic"),
                    context_length=length,
                    position=position,
                )
                result = await self._run_single_task(task)
                results.append(result)

        return results

    async def run_quick_eval(self) -> list[ContextBenchResult]:
        """Run a quick evaluation with reduced task count.

        Useful for rapid testing and development.

        Returns:
            List of ContextBenchResult instances.

        """
        # Use subset of lengths and all positions
        quick_lengths = [1024, 4096, 16384]
        quick_positions = [
            NeedlePosition.START,
            NeedlePosition.MIDDLE,
            NeedlePosition.END,
        ]

        results: list[ContextBenchResult] = []

        for length in quick_lengths:
            for position in quick_positions:
                needle_type = random.choice(_VALID_NIAH_NEEDLE_TYPES)
                task = self.generator.generate_niah_task(
                    task_id=self._get_next_task_id("niah_quick"),
                    context_length=length,
                    position=position,
                    needle_type=needle_type,
                )
                result = await self._run_single_task(task)
                results.append(result)

        return results

    async def run(
        self,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[ContextBenchResult]:
        """Run the complete NIAH benchmark suite.

        Args:
            progress_callback: Optional callback for progress updates.

        Returns:
            List of all ContextBenchResult instances.

        """
        all_results: list[ContextBenchResult] = []

        # Run basic NIAH
        if self.config.run_niah_basic:
            basic_results = await self.run_position_sweep(
                progress_callback=progress_callback
            )
            all_results.extend(basic_results)

        # Run semantic NIAH
        if self.config.run_niah_semantic:
            semantic_results = await self.run_semantic_niah()
            all_results.extend(semantic_results)

        return all_results


class NIAHTaskGenerator:
    """Helper class to generate NIAH tasks for external use."""

    def __init__(self, seed: int | None = None):
        self.generator = ContextGenerator(seed=seed)
        self._counter = 0

    def create_basic_task(
        self,
        context_length: int,
        position: NeedlePosition,
        needle_type: NeedleType = NeedleType.FACT,
    ) -> ContextBenchTask:
        """Create a basic NIAH task."""
        self._counter += 1
        return self.generator.generate_niah_task(
            task_id=f"niah_{self._counter}",
            context_length=context_length,
            position=position,
            needle_type=needle_type,
        )

    def create_semantic_task(
        self,
        context_length: int,
        position: NeedlePosition,
    ) -> ContextBenchTask:
        """Create a semantic NIAH task."""
        self._counter += 1
        return self.generator.generate_semantic_niah_task(
            task_id=f"niah_semantic_{self._counter}",
            context_length=context_length,
            position=position,
        )

    def create_batch(
        self,
        context_lengths: list[int],
        positions: list[NeedlePosition],
        include_semantic: bool = True,
    ) -> list[ContextBenchTask]:
        """Create a batch of NIAH tasks."""
        tasks: list[ContextBenchTask] = []

        for length in context_lengths:
            for position in positions:
                # Basic task
                tasks.append(self.create_basic_task(length, position))

                # Semantic task
                if include_semantic:
                    tasks.append(self.create_semantic_task(length, position))

        return tasks
