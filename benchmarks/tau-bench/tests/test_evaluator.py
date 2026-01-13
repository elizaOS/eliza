"""
Tests for Tau-bench evaluator.
"""

import pytest
from elizaos_tau_bench.types import (
    TauBenchTask,
    TauBenchResult,
    TauDomain,
    ToolCall,
    PolicyConstraint,
)
from elizaos_tau_bench.evaluator import TauBenchEvaluator


@pytest.fixture
def evaluator():
    """Create an evaluator instance."""
    return TauBenchEvaluator(use_llm_judge=False)


@pytest.fixture
def sample_task():
    """Create a sample task for evaluation."""
    return TauBenchTask(
        task_id="eval_test",
        domain=TauDomain.RETAIL,
        user_instruction="Return my order",
        expected_tool_calls=[
            ToolCall(tool_name="get_order_details", arguments={"order_id": "ORD-123"}),
            ToolCall(tool_name="initiate_return", arguments={"order_id": "ORD-123"}),
        ],
        policy_constraints=[
            PolicyConstraint(
                policy_id="RETURN_WINDOW",
                description="Returns within 30 days",
                check_function="check_return_window",
            ),
        ],
        ground_truth_response="Return initiated successfully for order ORD-123. Refund of $149.99 pending.",
    )


class TestTauBenchEvaluator:
    """Tests for TauBenchEvaluator."""

    def test_evaluate_perfect_performance(self, evaluator, sample_task):
        """Test evaluation with perfect tool calls."""
        tool_calls = [
            ToolCall(tool_name="get_order_details", arguments={"order_id": "ORD-123"}),
            ToolCall(tool_name="initiate_return", arguments={"order_id": "ORD-123"}),
        ]

        result = evaluator.evaluate_task(
            task=sample_task,
            tool_calls_made=tool_calls,
            response="Return initiated successfully for order ORD-123. Your refund of $149.99 will be processed.",
            policy_violations=[],
            goal_achieved=True,
            final_state={},
            duration_ms=1000.0,
        )

        assert result.success
        assert result.tool_call_accuracy > 0.9
        assert result.policy_compliance == 1.0

    def test_evaluate_wrong_tool(self, evaluator, sample_task):
        """Test evaluation with wrong tool call."""
        tool_calls = [
            ToolCall(tool_name="cancel_order", arguments={"order_id": "ORD-123"}),  # Wrong tool
        ]

        result = evaluator.evaluate_task(
            task=sample_task,
            tool_calls_made=tool_calls,
            response="Order cancelled",
            policy_violations=[],
            goal_achieved=False,
            final_state={},
            duration_ms=1000.0,
        )

        assert not result.success
        assert result.tool_call_accuracy < 0.5

    def test_evaluate_policy_violation(self, evaluator, sample_task):
        """Test evaluation with policy violation."""
        tool_calls = [
            ToolCall(tool_name="get_order_details", arguments={"order_id": "ORD-123"}),
            ToolCall(tool_name="initiate_return", arguments={"order_id": "ORD-123"}),
        ]

        result = evaluator.evaluate_task(
            task=sample_task,
            tool_calls_made=tool_calls,
            response="Return initiated",
            policy_violations=["Return outside window"],
            goal_achieved=True,
            final_state={},
            duration_ms=1000.0,
        )

        assert result.policy_compliance == 0.0
        # Even with correct tools, policy violation should prevent success
        assert not result.success

    def test_evaluate_no_expected_calls(self, evaluator):
        """Test evaluation when no tool calls are expected."""
        task = TauBenchTask(
            task_id="no_calls",
            domain=TauDomain.RETAIL,
            user_instruction="What's your return policy?",
            expected_tool_calls=[],  # No tools expected
            ground_truth_response="Our return policy allows returns within 30 days.",
        )

        result = evaluator.evaluate_task(
            task=task,
            tool_calls_made=[],
            response="You can return items within 30 days.",
            policy_violations=[],
            goal_achieved=True,
            final_state={},
            duration_ms=500.0,
        )

        assert result.tool_call_accuracy == 1.0

    def test_evaluate_extra_tool_calls(self, evaluator, sample_task):
        """Test penalty for extra tool calls."""
        tool_calls = [
            ToolCall(tool_name="get_order_details", arguments={"order_id": "ORD-123"}),
            ToolCall(tool_name="initiate_return", arguments={"order_id": "ORD-123"}),
            ToolCall(tool_name="get_customer_info", arguments={"customer_id": "C001"}),  # Extra
            ToolCall(tool_name="get_product_info", arguments={"product_id": "P001"}),  # Extra
        ]

        result = evaluator.evaluate_task(
            task=sample_task,
            tool_calls_made=tool_calls,
            response="Return initiated",
            policy_violations=[],
            goal_achieved=True,
            final_state={},
            duration_ms=1500.0,
        )

        # Should have penalty for extra calls
        assert result.tool_call_accuracy < 1.0

    def test_evaluate_response_quality(self, evaluator, sample_task):
        """Test response quality evaluation."""
        # Test with matching response
        result1 = evaluator.evaluate_task(
            task=sample_task,
            tool_calls_made=sample_task.expected_tool_calls,
            response="Return initiated successfully for order ORD-123. Your refund of $149.99 will be processed within 5 days.",
            policy_violations=[],
            goal_achieved=True,
            final_state={},
            duration_ms=1000.0,
        )

        # Test with non-matching response
        result2 = evaluator.evaluate_task(
            task=sample_task,
            tool_calls_made=sample_task.expected_tool_calls,
            response="Something completely different",
            policy_violations=[],
            goal_achieved=True,
            final_state={},
            duration_ms=1000.0,
        )

        assert result1.response_quality > result2.response_quality


class TestPassKCalculation:
    """Tests for Pass^k metric calculation."""

    def test_calculate_pass_k_metrics(self, evaluator):
        """Test Pass^k calculation with multiple trials."""
        # Create results with varying success
        # Pass^k requires ALL k trials to pass for a task to count as passed
        results = [
            # Task 1: passes all trials -> passes Pass^1, Pass^2, Pass^4
            TauBenchResult(task_id="t1", domain=TauDomain.RETAIL, trial_number=1, success=True),
            TauBenchResult(task_id="t1", domain=TauDomain.RETAIL, trial_number=2, success=True),
            TauBenchResult(task_id="t1", domain=TauDomain.RETAIL, trial_number=3, success=True),
            TauBenchResult(task_id="t1", domain=TauDomain.RETAIL, trial_number=4, success=True),
            # Task 2: passes first 2, fails later -> passes Pass^1, Pass^2, fails Pass^4
            TauBenchResult(task_id="t2", domain=TauDomain.RETAIL, trial_number=1, success=True),
            TauBenchResult(task_id="t2", domain=TauDomain.RETAIL, trial_number=2, success=True),
            TauBenchResult(task_id="t2", domain=TauDomain.RETAIL, trial_number=3, success=False),
            TauBenchResult(task_id="t2", domain=TauDomain.RETAIL, trial_number=4, success=False),
            # Task 3: fails first trial -> fails all Pass^k
            TauBenchResult(task_id="t3", domain=TauDomain.RETAIL, trial_number=1, success=False),
            TauBenchResult(task_id="t3", domain=TauDomain.RETAIL, trial_number=2, success=True),
            TauBenchResult(task_id="t3", domain=TauDomain.RETAIL, trial_number=3, success=True),
            TauBenchResult(task_id="t3", domain=TauDomain.RETAIL, trial_number=4, success=True),
        ]

        metrics = evaluator.calculate_pass_k(results, [1, 2, 4])

        # Pass^1: t1 and t2 pass first trial (t3 fails first trial) = 2/3
        assert metrics[1].pass_rate == pytest.approx(2/3, rel=0.01)

        # Pass^2: t1 and t2 pass first 2 trials = 2/3
        assert metrics[2].pass_rate == pytest.approx(2/3, rel=0.01)

        # Pass^4: only t1 passes all 4 = 1/3
        assert metrics[4].pass_rate == pytest.approx(1/3, rel=0.01)

    def test_compare_to_leaderboard(self, evaluator):
        """Test leaderboard comparison."""
        results = [
            TauBenchResult(
                task_id="t1",
                domain=TauDomain.RETAIL,
                success=True,
            ),
            TauBenchResult(
                task_id="t2",
                domain=TauDomain.RETAIL,
                success=False,
            ),
        ]

        leaderboard = {
            "gpt-5": {"retail": 0.485, "airline": 0.462},
            "claude-3-opus": {"retail": 0.512, "airline": 0.489},
        }

        comparison = evaluator.compare_to_leaderboard(results, leaderboard)

        # Our retail score is 0.5 (1/2 success)
        # gpt-5 retail is 0.485, difference should be +0.015
        assert "gpt-5" in comparison
        assert "claude-3-opus" in comparison
