"""
Tests for MINT benchmark types.
"""

import pytest

from benchmarks.mint.types import (
    MINTCategory,
    MINTConfig,
    MINTMetrics,
    MINTResult,
    MINTTask,
    MINTTrajectory,
    Turn,
    TurnType,
    EvaluationMetric,
    LEADERBOARD_SCORES,
)


class TestMINTCategory:
    """Tests for MINTCategory enum."""

    def test_all_categories_defined(self) -> None:
        """Test all expected categories are defined."""
        expected = {"reasoning", "coding", "decision_making", "information_seeking"}
        actual = {cat.value for cat in MINTCategory}
        assert actual == expected

    def test_category_values(self) -> None:
        """Test category string values."""
        assert MINTCategory.REASONING.value == "reasoning"
        assert MINTCategory.CODING.value == "coding"
        assert MINTCategory.DECISION_MAKING.value == "decision_making"
        assert MINTCategory.INFORMATION_SEEKING.value == "information_seeking"


class TestTurnType:
    """Tests for TurnType enum."""

    def test_all_turn_types_defined(self) -> None:
        """Test all expected turn types are defined."""
        expected = {"user", "assistant", "tool", "feedback"}
        actual = {tt.value for tt in TurnType}
        assert actual == expected


class TestTurn:
    """Tests for Turn dataclass."""

    def test_turn_creation(self) -> None:
        """Test creating a Turn."""
        turn = Turn(
            turn_type=TurnType.ASSISTANT,
            content="This is the answer",
            turn_number=1,
        )
        assert turn.turn_type == TurnType.ASSISTANT
        assert turn.content == "This is the answer"
        assert turn.turn_number == 1
        assert turn.tool_call is None
        assert turn.tool_result is None
        assert turn.feedback is None

    def test_turn_with_tool(self) -> None:
        """Test creating a Turn with tool call."""
        turn = Turn(
            turn_type=TurnType.TOOL,
            content="Let me calculate this",
            turn_number=2,
            tool_call="print(2 + 2)",
            tool_result="4",
            tool_success=True,
        )
        assert turn.tool_call == "print(2 + 2)"
        assert turn.tool_result == "4"
        assert turn.tool_success is True


class TestMINTTask:
    """Tests for MINTTask dataclass."""

    def test_task_creation(self) -> None:
        """Test creating a MINTTask."""
        task = MINTTask(
            id="test-001",
            category=MINTCategory.REASONING,
            description="A test task",
            initial_prompt="What is 2+2?",
            ground_truth="4",
        )
        assert task.id == "test-001"
        assert task.category == MINTCategory.REASONING
        assert task.max_turns == 5  # default
        assert task.evaluation_metric == "exact_match"  # default
        assert "python" in task.tools_allowed  # default

    def test_task_custom_settings(self) -> None:
        """Test creating a MINTTask with custom settings."""
        task = MINTTask(
            id="test-002",
            category=MINTCategory.CODING,
            description="A coding task",
            initial_prompt="Write factorial",
            ground_truth="120",
            max_turns=10,
            evaluation_metric="numeric",
            difficulty="hard",
        )
        assert task.max_turns == 10
        assert task.evaluation_metric == "numeric"
        assert task.difficulty == "hard"


class TestMINTTrajectory:
    """Tests for MINTTrajectory dataclass."""

    def test_trajectory_creation(self) -> None:
        """Test creating a MINTTrajectory."""
        trajectory = MINTTrajectory(task_id="test-001")
        assert trajectory.task_id == "test-001"
        assert trajectory.turns == []
        assert trajectory.final_answer is None
        assert trajectory.success is False
        assert trajectory.num_tool_uses == 0

    def test_trajectory_with_turns(self) -> None:
        """Test trajectory with turns."""
        trajectory = MINTTrajectory(task_id="test-001")
        trajectory.turns.append(Turn(
            turn_type=TurnType.ASSISTANT,
            content="Answer is 4",
            turn_number=1,
        ))
        trajectory.final_answer = "4"
        trajectory.success = True

        assert len(trajectory.turns) == 1
        assert trajectory.final_answer == "4"
        assert trajectory.success is True


class TestMINTResult:
    """Tests for MINTResult dataclass."""

    def test_result_creation(self) -> None:
        """Test creating a MINTResult."""
        trajectory = MINTTrajectory(task_id="test-001")
        result = MINTResult(
            task_id="test-001",
            category=MINTCategory.REASONING,
            trajectory=trajectory,
            success=True,
            turns_used=1,
            tool_uses=0,
            feedback_turns=0,
            latency_ms=1000.0,
            token_usage=500,
            score=1.0,
        )
        assert result.task_id == "test-001"
        assert result.success is True
        assert result.score == 1.0


class TestMINTMetrics:
    """Tests for MINTMetrics dataclass."""

    def test_metrics_creation(self) -> None:
        """Test creating MINTMetrics."""
        metrics = MINTMetrics(
            overall_success_rate=0.75,
            total_tasks=100,
            passed_tasks=75,
            failed_tasks=25,
        )
        assert metrics.overall_success_rate == 0.75
        assert metrics.total_tasks == 100
        assert metrics.passed_tasks == 75
        assert metrics.failed_tasks == 25

    def test_metrics_defaults(self) -> None:
        """Test MINTMetrics default values."""
        metrics = MINTMetrics(
            overall_success_rate=0.5,
            total_tasks=10,
            passed_tasks=5,
            failed_tasks=5,
        )
        assert metrics.tool_usage_rate == 0.0
        assert metrics.feedback_effectiveness == 0.0
        assert metrics.multi_turn_gain == 0.0


class TestMINTConfig:
    """Tests for MINTConfig dataclass."""

    def test_config_defaults(self) -> None:
        """Test MINTConfig default values."""
        config = MINTConfig()
        assert config.data_path == "./data/mint"
        assert config.max_turns == 5
        assert config.use_docker is True
        assert config.enable_tools is True
        assert config.enable_feedback is True

    def test_config_custom(self) -> None:
        """Test MINTConfig with custom values."""
        config = MINTConfig(
            data_path="/custom/path",
            max_turns=10,
            use_docker=False,
            categories=[MINTCategory.REASONING, MINTCategory.CODING],
        )
        assert config.data_path == "/custom/path"
        assert config.max_turns == 10
        assert config.use_docker is False
        assert config.categories is not None
        assert len(config.categories) == 2


class TestLeaderboardScores:
    """Tests for leaderboard reference scores."""

    def test_leaderboard_has_expected_models(self) -> None:
        """Test leaderboard has expected models."""
        expected_models = {"gpt-4-0613", "gpt-3.5-turbo", "claude-2", "llama-2-70b"}
        actual_models = set(LEADERBOARD_SCORES.keys())
        assert expected_models == actual_models

    def test_leaderboard_has_expected_categories(self) -> None:
        """Test each model has expected category scores."""
        expected_keys = {"reasoning", "coding", "decision_making", "information_seeking", "overall"}
        for model, scores in LEADERBOARD_SCORES.items():
            assert set(scores.keys()) == expected_keys, f"Model {model} missing categories"

    def test_leaderboard_scores_in_range(self) -> None:
        """Test all scores are between 0 and 1."""
        for model, scores in LEADERBOARD_SCORES.items():
            for category, score in scores.items():
                assert 0.0 <= score <= 1.0, f"{model}/{category} score {score} out of range"
