"""
Tests for MINT evaluator.
"""

import pytest

from benchmarks.mint.types import MINTCategory, MINTTask, MINTTrajectory, Turn, TurnType
from benchmarks.mint.evaluator import MINTEvaluator, BatchEvaluator


class TestMINTEvaluator:
    """Tests for MINTEvaluator class."""

    @pytest.fixture
    def evaluator(self) -> MINTEvaluator:
        """Create an evaluator instance."""
        return MINTEvaluator()

    @pytest.fixture
    def strict_evaluator(self) -> MINTEvaluator:
        """Create a strict evaluator instance."""
        return MINTEvaluator(strict=True)

    # Exact match tests
    def test_exact_match_success(self, evaluator: MINTEvaluator) -> None:
        """Test exact match with matching strings."""
        success, score, _ = evaluator.evaluate("hello", "hello", "exact_match")
        assert success is True
        assert score == 1.0

    def test_exact_match_case_insensitive(self, evaluator: MINTEvaluator) -> None:
        """Test exact match is case insensitive."""
        success, score, _ = evaluator.evaluate("Hello", "hello", "exact_match")
        assert success is True
        assert score == 1.0

    def test_exact_match_with_whitespace(self, evaluator: MINTEvaluator) -> None:
        """Test exact match ignores leading/trailing whitespace."""
        success, score, _ = evaluator.evaluate("  answer  ", "answer", "exact_match")
        assert success is True
        assert score == 1.0

    def test_exact_match_failure(self, evaluator: MINTEvaluator) -> None:
        """Test exact match with non-matching strings."""
        success, score, _ = evaluator.evaluate("wrong", "right", "exact_match")
        assert success is False
        assert 0.0 <= score < 1.0

    # Numeric match tests
    def test_numeric_match_integer(self, evaluator: MINTEvaluator) -> None:
        """Test numeric match with integers."""
        success, score, _ = evaluator.evaluate("42", "42", "numeric")
        assert success is True
        assert score == 1.0

    def test_numeric_match_float(self, evaluator: MINTEvaluator) -> None:
        """Test numeric match with floats."""
        success, score, _ = evaluator.evaluate("3.14159", "3.14159", "numeric")
        assert success is True
        assert score == 1.0

    def test_numeric_match_tolerance(self, evaluator: MINTEvaluator) -> None:
        """Test numeric match with tolerance."""
        success, score, _ = evaluator.evaluate("100.5", "100", "numeric")
        # 0.5% difference should be within 1% tolerance
        assert success is True
        assert score == 1.0

    def test_numeric_match_extracted(self, evaluator: MINTEvaluator) -> None:
        """Test numeric match extracts number from text."""
        success, score, _ = evaluator.evaluate(
            "The answer is 42 meters",
            "42",
            "numeric"
        )
        assert success is True
        assert score == 1.0

    def test_numeric_match_failure(self, evaluator: MINTEvaluator) -> None:
        """Test numeric match with different numbers."""
        success, score, _ = evaluator.evaluate("10", "100", "numeric")
        assert success is False

    def test_numeric_match_strict(self, strict_evaluator: MINTEvaluator) -> None:
        """Test strict numeric match requires exact equality."""
        success, score, _ = strict_evaluator.evaluate("100.001", "100", "numeric")
        assert success is False

    # Partial match tests
    def test_partial_match_containment(self, evaluator: MINTEvaluator) -> None:
        """Test partial match with containment."""
        success, score, _ = evaluator.evaluate("bab", "bab", "partial_match")
        assert success is True

    def test_partial_match_subset(self, evaluator: MINTEvaluator) -> None:
        """Test partial match where one is subset of other."""
        success, score, _ = evaluator.evaluate("the answer is bab", "bab", "partial_match")
        assert success is True

    def test_partial_match_rejects_empty_normalization(self, evaluator: MINTEvaluator) -> None:
        """Test partial match does not treat empty string as a match."""
        success, score, _ = evaluator.evaluate(":", "20000,66.67", "partial_match")
        assert success is False
        assert score == 0.0

    # Code output tests
    def test_code_output_numeric(self, evaluator: MINTEvaluator) -> None:
        """Test code output matching with numeric result."""
        success, score, _ = evaluator.evaluate("120", "120", "code_output")
        assert success is True
        assert score == 1.0

    # Empty/missing answer tests
    def test_empty_prediction(self, evaluator: MINTEvaluator) -> None:
        """Test evaluation with empty prediction."""
        success, score, details = evaluator.evaluate("", "42", "numeric")
        assert success is False
        assert score == 0.0
        assert "error" in details

    def test_none_prediction(self, evaluator: MINTEvaluator) -> None:
        """Test evaluation handles None gracefully."""
        success, score, _ = evaluator.evaluate(None, "42", "numeric")  # type: ignore
        assert success is False

    # Trajectory evaluation tests
    def test_evaluate_trajectory_success(self, evaluator: MINTEvaluator) -> None:
        """Test evaluating a successful trajectory."""
        task = MINTTask(
            id="test-001",
            category=MINTCategory.REASONING,
            description="Test task",
            initial_prompt="What is 2+2?",
            ground_truth="4",
            evaluation_metric="numeric",
        )
        
        trajectory = MINTTrajectory(
            task_id="test-001",
            final_answer="4",
            success=True,
            start_time_ms=1000.0,
            end_time_ms=2000.0,
        )
        trajectory.turns.append(Turn(
            turn_type=TurnType.ASSISTANT,
            content="The answer is 4",
            turn_number=1,
        ))
        
        result = evaluator.evaluate_trajectory(task, trajectory)
        
        assert result.success is True
        assert result.score == 1.0
        assert result.task_id == "test-001"
        assert result.category == MINTCategory.REASONING

    def test_evaluate_trajectory_failure(self, evaluator: MINTEvaluator) -> None:
        """Test evaluating a failed trajectory."""
        task = MINTTask(
            id="test-002",
            category=MINTCategory.REASONING,
            description="Test task",
            initial_prompt="What is 2+2?",
            ground_truth="4",
            evaluation_metric="numeric",
        )
        
        trajectory = MINTTrajectory(
            task_id="test-002",
            final_answer="5",
            success=False,
            start_time_ms=1000.0,
            end_time_ms=2000.0,
        )
        
        result = evaluator.evaluate_trajectory(task, trajectory)
        
        assert result.success is False
        assert result.score < 1.0


class TestBatchEvaluator:
    """Tests for BatchEvaluator class."""

    @pytest.fixture
    def batch_evaluator(self) -> BatchEvaluator:
        """Create a batch evaluator instance."""
        return BatchEvaluator()

    def test_evaluate_empty_batch(self, batch_evaluator: BatchEvaluator) -> None:
        """Test evaluating an empty batch."""
        results = batch_evaluator.evaluate_batch([], [])
        assert len(results) == 0

    def test_aggregate_empty_results(self, batch_evaluator: BatchEvaluator) -> None:
        """Test aggregating empty results."""
        stats = batch_evaluator.aggregate_results([])
        assert stats["total"] == 0
        assert stats["success_rate"] == 0.0

    def test_aggregate_results(self, batch_evaluator: BatchEvaluator) -> None:
        """Test aggregating results."""
        task = MINTTask(
            id="test-001",
            category=MINTCategory.REASONING,
            description="Test",
            initial_prompt="Test",
            ground_truth="4",
        )
        
        # Create successful trajectory
        traj1 = MINTTrajectory(task_id="test-001", final_answer="4")
        traj1.start_time_ms = 1000.0
        traj1.end_time_ms = 2000.0
        
        # Create failed trajectory
        traj2 = MINTTrajectory(task_id="test-002", final_answer="5")
        traj2.start_time_ms = 1000.0
        traj2.end_time_ms = 3000.0
        
        results = batch_evaluator.evaluate_batch(
            [task, task],
            [traj1, traj2],
        )
        
        stats = batch_evaluator.aggregate_results(results)
        
        assert stats["total"] == 2
        assert stats["passed"] == 1
        assert stats["failed"] == 1
        assert stats["success_rate"] == 0.5
