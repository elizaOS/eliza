"""
Tests for MINT benchmark types.

These cover the rebuilt 8-subtask taxonomy. The previous 4-bucket category
enum was invented — its tests have been replaced.
"""


from benchmarks.mint.types import (
    MINTSubtask,
    MINTTaskType,
    SUBTASK_TO_TASK_TYPE,
    MINTConfig,
    MINTMetrics,
    MINTResult,
    MINTTask,
    MINTTrajectory,
    Turn,
    TurnType,
    LEADERBOARD_SCORES,
    PAPER_RESULTS_URL,
    MINTCategory,  # back-compat alias
)


class TestSubtaskTaxonomy:
    def test_eight_subtasks_defined(self) -> None:
        expected = {
            "humaneval",
            "mbpp",
            "math",
            "gsm8k",
            "hotpotqa",
            "mmlu",
            "theoremqa",
            "alfworld",
        }
        assert {s.value for s in MINTSubtask} == expected

    def test_three_task_types(self) -> None:
        assert {t.value for t in MINTTaskType} == {
            "reasoning",
            "code_generation",
            "decision_making",
        }

    def test_subtask_to_task_type_complete(self) -> None:
        for st in MINTSubtask:
            assert st in SUBTASK_TO_TASK_TYPE
            assert SUBTASK_TO_TASK_TYPE[st] in MINTTaskType

    def test_mint_category_is_alias(self) -> None:
        assert MINTCategory is MINTSubtask
        assert MINTCategory.HUMANEVAL.value == "humaneval"


class TestTurnType:
    def test_all_turn_types_defined(self) -> None:
        assert {tt.value for tt in TurnType} == {"user", "assistant", "tool", "feedback"}


class TestTurn:
    def test_turn_creation(self) -> None:
        turn = Turn(
            turn_type=TurnType.ASSISTANT,
            content="This is the answer",
            turn_number=1,
        )
        assert turn.turn_type == TurnType.ASSISTANT
        assert turn.turn_number == 1
        assert turn.proposed_solution is False

    def test_turn_with_tool(self) -> None:
        turn = Turn(
            turn_type=TurnType.TOOL,
            content="result",
            turn_number=2,
            tool_call="print(2 + 2)",
            tool_result="4",
            tool_success=True,
        )
        assert turn.tool_call == "print(2 + 2)"
        assert turn.tool_result == "4"


class TestMINTTask:
    def test_task_creation(self) -> None:
        task = MINTTask(
            id="gsm8k-001",
            subtask=MINTSubtask.GSM8K,
            description="A test task",
            initial_prompt="What is 2 + 2?",
            ground_truth="4",
        )
        assert task.subtask is MINTSubtask.GSM8K
        assert task.task_type is MINTTaskType.REASONING
        assert task.category is MINTSubtask.GSM8K  # alias still works
        assert task.evaluation_metric == "exact_match"
        assert "python" in task.tools_allowed


class TestMINTTrajectory:
    def test_trajectory_records_per_turn_answers(self) -> None:
        traj = MINTTrajectory(task_id="t1")
        traj.per_turn_answers.append("first")
        traj.per_turn_answers.append("second")
        traj.per_turn_success.append(False)
        traj.per_turn_success.append(True)
        assert traj.per_turn_answers == ["first", "second"]
        assert traj.per_turn_success == [False, True]


class TestMINTResult:
    def test_result_creation(self) -> None:
        result = MINTResult(
            task_id="t1",
            subtask=MINTSubtask.MATH,
            trajectory=MINTTrajectory(task_id="t1"),
            success=True,
            turns_used=2,
            tool_uses=1,
            feedback_turns=1,
            latency_ms=100.0,
            token_usage=50,
            score=1.0,
            cumulative_success_per_turn=[False, True],
        )
        assert result.subtask is MINTSubtask.MATH
        assert result.category is MINTSubtask.MATH  # alias
        assert result.cumulative_success_per_turn[-1] is True


class TestMINTMetrics:
    def test_metrics_defaults(self) -> None:
        m = MINTMetrics(
            overall_success_rate=0.5,
            total_tasks=10,
            passed_tasks=5,
            failed_tasks=5,
        )
        assert m.tool_usage_rate == 0.0
        assert m.turn_1_success_rate == 0.0
        assert m.turn_5_success_rate == 0.0
        assert m.per_turn_success_rates == []


class TestMINTConfig:
    def test_config_defaults(self) -> None:
        c = MINTConfig()
        assert c.max_turns == 5
        assert c.use_docker is True
        assert c.feedback_mode == "templated"
        assert c.use_mock_executor is False
        assert c.use_sample_tasks is False
        assert c.auto_fetch_upstream is True
        assert c.allow_ground_truth_mock is False


class TestLeaderboard:
    def test_leaderboard_empty_by_default(self) -> None:
        # We deliberately do not ship invented numbers post-rebuild.
        assert LEADERBOARD_SCORES == {}

    def test_paper_results_url_set(self) -> None:
        assert PAPER_RESULTS_URL.startswith("https://arxiv.org/")
