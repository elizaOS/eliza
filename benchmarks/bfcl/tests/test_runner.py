"""
Tests for BFCL Benchmark Runner
"""

import pytest

from benchmarks.bfcl.runner import BFCLRunner
from benchmarks.bfcl.types import (
    BFCLCategory,
    BFCLConfig,
    BFCLTestCase,
    FunctionCall,
    FunctionDefinition,
    FunctionParameter,
)
from benchmarks.bfcl.metrics import MetricsCalculator


class TestBFCLRunner:
    """Tests for the BFCL benchmark runner."""

    @pytest.fixture
    def config(self) -> BFCLConfig:
        """Create test configuration."""
        return BFCLConfig(
            output_dir="./test_results",
            max_tests_per_category=5,
            use_huggingface=False,  # Use local for testing
            generate_report=False,
        )

    @pytest.fixture
    def mock_test_case(self) -> BFCLTestCase:
        """Create a mock test case."""
        return BFCLTestCase(
            id="test_001",
            category=BFCLCategory.SIMPLE,
            question="What's the weather in San Francisco?",
            functions=[
                FunctionDefinition(
                    name="get_weather",
                    description="Get weather for a location",
                    parameters={
                        "location": FunctionParameter(
                            name="location",
                            param_type="string",
                            description="City name",
                            required=True,
                        ),
                    },
                    required_params=["location"],
                ),
            ],
            expected_calls=[
                FunctionCall(
                    name="get_weather",
                    arguments={"location": "San Francisco"},
                ),
            ],
        )

    @pytest.mark.asyncio
    async def test_runner_initialization(self, config: BFCLConfig) -> None:
        """Test runner initialization."""
        runner = BFCLRunner(config, use_mock_agent=True)
        assert runner.config == config
        assert runner.dataset is not None

    @pytest.mark.asyncio
    async def test_mock_agent_returns_expected(self, config: BFCLConfig) -> None:
        """Test mock agent returns expected calls."""
        runner = BFCLRunner(config, use_mock_agent=True)
        await runner._initialize()

        test_case = BFCLTestCase(
            id="test_001",
            category=BFCLCategory.SIMPLE,
            question="Test question",
            functions=[],
            expected_calls=[
                FunctionCall(name="test_func", arguments={"x": 1}),
            ],
        )

        calls, response, latency = await runner.agent.query(test_case)

        assert len(calls) == 1
        assert calls[0].name == "test_func"
        assert latency > 0


class TestMetricsCalculator:
    """Tests for metrics calculation."""

    @pytest.fixture
    def calculator(self) -> MetricsCalculator:
        return MetricsCalculator()

    def test_calculate_empty_results(self, calculator: MetricsCalculator) -> None:
        """Test metrics calculation with empty results."""
        metrics = calculator.calculate([])
        assert metrics.overall_score == 0.0
        assert metrics.total_tests == 0

    def test_calculate_perfect_results(self, calculator: MetricsCalculator) -> None:
        """Test metrics calculation with perfect results."""
        from benchmarks.bfcl.types import BFCLResult

        results = [
            BFCLResult(
                test_case_id=f"test_{i}",
                category=BFCLCategory.SIMPLE,
                predicted_calls=[FunctionCall(name="func", arguments={})],
                expected_calls=[FunctionCall(name="func", arguments={})],
                ast_match=True,
                exec_success=True,
                relevance_correct=True,
                latency_ms=100.0,
            )
            for i in range(10)
        ]

        metrics = calculator.calculate(results)
        assert metrics.ast_accuracy == 1.0
        assert metrics.exec_accuracy == 1.0
        assert metrics.relevance_accuracy == 1.0

    def test_calculate_mixed_results(self, calculator: MetricsCalculator) -> None:
        """Test metrics calculation with mixed results."""
        from benchmarks.bfcl.types import BFCLResult

        results = [
            BFCLResult(
                test_case_id="test_1",
                category=BFCLCategory.SIMPLE,
                predicted_calls=[],
                expected_calls=[FunctionCall(name="func", arguments={})],
                ast_match=True,
                exec_success=True,
                relevance_correct=True,
                latency_ms=100.0,
            ),
            BFCLResult(
                test_case_id="test_2",
                category=BFCLCategory.SIMPLE,
                predicted_calls=[],
                expected_calls=[FunctionCall(name="func", arguments={})],
                ast_match=False,
                exec_success=False,
                relevance_correct=True,
                latency_ms=150.0,
            ),
        ]

        metrics = calculator.calculate(results)
        assert metrics.ast_accuracy == 0.5
        assert metrics.total_tests == 2
        assert metrics.passed_tests == 1
        assert metrics.failed_tests == 1

    def test_latency_statistics(self, calculator: MetricsCalculator) -> None:
        """Test latency statistics calculation."""
        from benchmarks.bfcl.types import BFCLResult

        results = [
            BFCLResult(
                test_case_id=f"test_{i}",
                category=BFCLCategory.SIMPLE,
                predicted_calls=[],
                expected_calls=[],
                ast_match=True,
                exec_success=True,
                relevance_correct=True,
                latency_ms=float(i * 100),
            )
            for i in range(1, 11)
        ]

        metrics = calculator.calculate(results)
        assert metrics.avg_latency_ms == 550.0  # Average of 100-1000
        # P50 is the median - for 10 items, index 5 gives 600
        assert metrics.latency_p50 >= 500.0
        assert metrics.latency_p50 <= 600.0

    def test_baseline_comparison(self, calculator: MetricsCalculator) -> None:
        """Test baseline comparison."""
        from benchmarks.bfcl.types import BFCLMetrics

        metrics = BFCLMetrics(
            overall_score=0.85,
            ast_accuracy=0.88,
            exec_accuracy=0.82,
            relevance_accuracy=0.90,
        )

        comparison = calculator.compare_to_baselines(metrics)

        assert "gpt-4-turbo" in comparison
        assert "claude-3-opus" in comparison
        # Our score (0.85) vs GPT-4 Turbo (0.887)
        assert comparison["gpt-4-turbo"] < 0  # We're behind GPT-4 Turbo

    def test_format_metrics_table(self, calculator: MetricsCalculator) -> None:
        """Test metrics table formatting."""
        from benchmarks.bfcl.types import BFCLMetrics

        metrics = BFCLMetrics(
            overall_score=0.75,
            ast_accuracy=0.80,
            exec_accuracy=0.70,
            relevance_accuracy=0.85,
            total_tests=100,
            passed_tests=75,
            failed_tests=25,
        )

        table = calculator.format_metrics_table(metrics)
        assert "BFCL BENCHMARK RESULTS" in table
        assert "Overall Score: 75" in table
        assert "AST Accuracy:  80" in table


@pytest.mark.asyncio
async def test_run_bfcl_benchmark_mock() -> None:
    """Test the convenience function with mock mode."""
    benchmark_config = BFCLConfig(
        max_tests_per_category=2,
        generate_report=False,
    )

    # Verify the config is valid
    assert benchmark_config.max_tests_per_category == 2
    assert not benchmark_config.generate_report
    
    # Note: Full run requires dataset access
