"""Tests for RLM benchmark suite."""

from __future__ import annotations

import pytest

from elizaos_rlm_bench.types import (
    RLMBenchConfig,
    RLMBenchTask,
    RLMBenchType,
    RLMStrategy,
)
from elizaos_rlm_bench.generator import (
    RLMBenchGenerator,
    generate_random_value,
    estimate_tokens,
)
from elizaos_rlm_bench.evaluator import (
    RLMBenchEvaluator,
    compute_exact_match,
    compute_partial_match,
    normalize_answer,
)


class TestTypes:
    """Tests for benchmark types."""

    def test_config_validation(self) -> None:
        """Test config validates correctly."""
        config = RLMBenchConfig(
            context_lengths=[1000, 10000],
            max_context_length=100000,
        )
        assert config.context_lengths == [1000, 10000]

    def test_config_validation_fails_for_invalid_length(self) -> None:
        """Test config rejects invalid context lengths."""
        with pytest.raises(ValueError):
            RLMBenchConfig(context_lengths=[-1])

    def test_config_validation_fails_for_exceeding_max(self) -> None:
        """Test config rejects lengths exceeding max."""
        with pytest.raises(ValueError):
            RLMBenchConfig(
                context_lengths=[1000000],
                max_context_length=100000,
            )

    def test_bench_type_enum(self) -> None:
        """Test benchmark type enum values."""
        assert RLMBenchType.S_NIAH.value == "s_niah"
        assert RLMBenchType.OOLONG.value == "oolong"
        assert RLMBenchType.OOLONG_PAIRS.value == "oolong_pairs"

    def test_strategy_enum(self) -> None:
        """Test strategy enum values."""
        assert RLMStrategy.PEEK.value == "peek"
        assert RLMStrategy.GREP.value == "grep"
        assert RLMStrategy.CHUNK.value == "chunk"
        assert RLMStrategy.STITCH.value == "stitch"


class TestGenerator:
    """Tests for task generator."""

    def test_generate_random_value(self) -> None:
        """Test random value generation."""
        value = generate_random_value(8)
        assert len(value) == 8
        assert value.isalnum()

    def test_estimate_tokens(self) -> None:
        """Test token estimation."""
        text = "Hello, world!"  # 13 chars
        tokens = estimate_tokens(text)
        assert tokens == 3  # 13 // 4

    def test_generator_creates_s_niah_task(self) -> None:
        """Test S-NIAH task generation."""
        config = RLMBenchConfig(context_lengths=[1000])
        generator = RLMBenchGenerator(config)

        task = generator.generate_s_niah_task(1000, 0.5)

        assert task.bench_type == RLMBenchType.S_NIAH
        assert task.context_length_tokens > 0
        assert task.question != ""
        assert task.expected_answer != ""
        assert task.needle != ""

    def test_generator_creates_oolong_task(self) -> None:
        """Test OOLONG task generation."""
        config = RLMBenchConfig(context_lengths=[1000])
        generator = RLMBenchGenerator(config)

        task = generator.generate_oolong_task(1000)

        assert task.bench_type == RLMBenchType.OOLONG
        assert len(task.document_ids) == 1

    def test_generator_creates_oolong_pairs_task(self) -> None:
        """Test OOLONG-Pairs task generation."""
        config = RLMBenchConfig(context_lengths=[1000])
        generator = RLMBenchGenerator(config)

        task = generator.generate_oolong_pairs_task(1000)

        assert task.bench_type == RLMBenchType.OOLONG_PAIRS
        assert len(task.document_ids) == 2
        assert task.requires_comparison is True

    def test_generator_all_tasks(self) -> None:
        """Test generating all tasks."""
        config = RLMBenchConfig(
            context_lengths=[1000],
            tasks_per_config=2,
            run_s_niah=True,
            run_s_niah_multi=False,
            run_oolong=True,
            run_oolong_pairs=False,
        )
        generator = RLMBenchGenerator(config)

        tasks = generator.generate_all_tasks()

        # S-NIAH: 5 positions * 2 tasks = 10
        # OOLONG: 1 * 2 tasks = 2
        assert len(tasks) == 12

    def test_insert_needle_at_start(self) -> None:
        """Test needle insertion at start."""
        config = RLMBenchConfig(context_lengths=[1000])
        generator = RLMBenchGenerator(config)

        haystack = "Para 1.\n\nPara 2.\n\nPara 3."
        needle = "SECRET"

        result = generator.insert_needle(haystack, needle, 0.0)

        assert result.startswith("SECRET")

    def test_insert_needle_at_end(self) -> None:
        """Test needle insertion at end."""
        config = RLMBenchConfig(context_lengths=[1000])
        generator = RLMBenchGenerator(config)

        haystack = "Para 1.\n\nPara 2.\n\nPara 3."
        needle = "SECRET"

        result = generator.insert_needle(haystack, needle, 1.0)

        assert result.endswith("SECRET")


class TestEvaluator:
    """Tests for result evaluator."""

    def test_normalize_answer(self) -> None:
        """Test answer normalization."""
        assert normalize_answer("Hello, World!") == "hello world"
        assert normalize_answer("  ABC  123  ") == "abc 123"

    def test_exact_match(self) -> None:
        """Test exact match detection."""
        assert compute_exact_match("ABC123", "abc123") is True
        assert compute_exact_match("ABC123", "ABC-123") is True
        assert compute_exact_match("ABC", "XYZ") is False

    def test_partial_match(self) -> None:
        """Test partial match scoring."""
        assert compute_partial_match("apple banana", "apple banana") == 1.0
        assert compute_partial_match("apple", "apple banana") == 0.5
        assert compute_partial_match("xyz", "apple banana") == 0.0

    def test_evaluator_correct_answer(self) -> None:
        """Test evaluator marks correct answer."""
        evaluator = RLMBenchEvaluator()

        task = RLMBenchTask(
            id="test-1",
            bench_type=RLMBenchType.S_NIAH,
            context="...",
            context_length_tokens=1000,
            context_length_chars=4000,
            question="What is the code?",
            expected_answer="ABC123",
        )

        result = evaluator.evaluate_result(
            task=task,
            predicted_answer="ABC123",
        )

        assert result.is_correct is True
        assert result.exact_match is True

    def test_evaluator_incorrect_answer(self) -> None:
        """Test evaluator marks incorrect answer."""
        evaluator = RLMBenchEvaluator()

        task = RLMBenchTask(
            id="test-1",
            bench_type=RLMBenchType.S_NIAH,
            context="...",
            context_length_tokens=1000,
            context_length_chars=4000,
            question="What is the code?",
            expected_answer="ABC123",
        )

        result = evaluator.evaluate_result(
            task=task,
            predicted_answer="XYZ789",
        )

        assert result.is_correct is False
        assert result.exact_match is False

    def test_evaluator_computes_metrics(self) -> None:
        """Test evaluator computes aggregate metrics."""
        evaluator = RLMBenchEvaluator()

        from elizaos_rlm_bench.types import RLMBenchResult

        results = [
            RLMBenchResult(
                task_id="1",
                bench_type=RLMBenchType.S_NIAH,
                context_length_tokens=1000,
                predicted_answer="A",
                expected_answer="A",
                exact_match=True,
                semantic_similarity=1.0,
                is_correct=True,
                iterations=1,
                max_depth=0,
                subcall_count=0,
                strategies_used=["peek"],
                input_tokens=1000,
                output_tokens=10,
                total_tokens=1010,
                cost_usd=0.001,
                latency_ms=100,
                tokens_per_second=10100,
            ),
            RLMBenchResult(
                task_id="2",
                bench_type=RLMBenchType.S_NIAH,
                context_length_tokens=1000,
                predicted_answer="X",
                expected_answer="B",
                exact_match=False,
                semantic_similarity=0.0,
                is_correct=False,
                iterations=1,
                max_depth=0,
                subcall_count=0,
                strategies_used=["grep"],
                input_tokens=1000,
                output_tokens=10,
                total_tokens=1010,
                cost_usd=0.001,
                latency_ms=100,
                tokens_per_second=10100,
            ),
        ]

        metrics = evaluator.compute_metrics(results)

        assert metrics.total_tasks == 2
        assert metrics.passed_tasks == 1
        assert metrics.overall_accuracy == 0.5


class TestRunner:
    """Tests for benchmark runner."""

    @pytest.mark.asyncio
    async def test_runner_stub_mode(self) -> None:
        """Test runner works in stub mode."""
        from elizaos_rlm_bench.runner import RLMBenchRunner

        config = RLMBenchConfig(
            context_lengths=[1000],
            tasks_per_config=1,
            run_s_niah=True,
            run_s_niah_multi=False,
            run_oolong=False,
            run_oolong_pairs=False,
        )

        runner = RLMBenchRunner(config)
        results = await runner.run_all(mode="stub")

        assert results.metrics.total_tasks > 0
        assert len(results.results) > 0

    @pytest.mark.asyncio
    async def test_runner_single_task(self) -> None:
        """Test running a single task."""
        from elizaos_rlm_bench.runner import RLMBenchRunner

        config = RLMBenchConfig(context_lengths=[1000])
        runner = RLMBenchRunner(config)

        task = runner.generator.generate_s_niah_task(1000, 0.5)
        result = await runner.run_task(task, mode="stub")

        assert result.task_id == task.id
        assert result.context_length_tokens == task.context_length_tokens


class TestReporting:
    """Tests for result reporting."""

    def test_reporter_generates_summary(self) -> None:
        """Test reporter generates summary string."""
        from elizaos_rlm_bench.reporting import RLMBenchReporter
        from elizaos_rlm_bench.types import (
            RLMBenchConfig,
            RLMBenchMetrics,
            RLMBenchResults,
        )

        metrics = RLMBenchMetrics(
            total_tasks=10,
            passed_tasks=8,
            failed_tasks=2,
            overall_accuracy=0.8,
            avg_semantic_similarity=0.85,
        )

        results = RLMBenchResults(
            config=RLMBenchConfig(),
            metrics=metrics,
            results=[],
        )

        reporter = RLMBenchReporter(results)
        summary = reporter.generate_summary_string()

        assert "80" in summary  # Could be 80% or 80.0%
        assert "8/10" in summary
