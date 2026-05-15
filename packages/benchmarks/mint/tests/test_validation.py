"""Tests for input validation across MINT benchmark components."""


from benchmarks.mint.types import MINTConfig, MINTSubtask, MINTTask
from benchmarks.mint.agent import MINTAgent
from benchmarks.mint.feedback import FeedbackGenerator


class TestAgentValidation:
    def test_agent_clamps_temperature(self) -> None:
        agent = MINTAgent(temperature=2.0)
        assert agent.temperature <= 1.0

        agent = MINTAgent(temperature=-0.5)
        assert agent.temperature >= 0.0

    def test_local_agent_does_not_use_ground_truth_by_default(self) -> None:
        task = MINTTask(
            id="test-001",
            subtask=MINTSubtask.HOTPOTQA,
            description="Non-arithmetic task",
            initial_prompt="Name the hidden code.",
            ground_truth="SECRET-CODE",
        )
        agent = MINTAgent()
        assert agent.allow_ground_truth_mock is False
        assert agent._local_answer(task) is None

        mock_agent = MINTAgent(allow_ground_truth_mock=True)
        assert mock_agent._local_answer(task) == "SECRET-CODE"


class TestFeedbackGeneratorValidation:
    def test_feedback_generator_defaults_to_templated(self) -> None:
        generator = FeedbackGenerator(runtime=None, use_llm=True)
        # No runtime -> mode falls back to templated, not LLM.
        assert generator.mode == "templated"

    def test_feedback_generator_with_invalid_runtime(self) -> None:
        generator = FeedbackGenerator(runtime="not a runtime", use_llm=True)  # type: ignore[arg-type]
        assert generator.mode == "templated"
        assert generator.runtime is None


class TestConfigValidation:
    def test_config_default_values(self) -> None:
        config = MINTConfig()
        assert config.max_turns > 0
        assert config.timeout_per_task_ms > 0
        assert config.code_timeout_seconds > 0
        assert 0.0 <= config.temperature <= 1.0
        # Off by default — must be explicitly opted into.
        assert config.allow_ground_truth_mock is False
        assert config.use_mock_executor is False
        assert config.use_sample_tasks is False
        assert config.auto_fetch_upstream is True

    def test_config_subtasks_accepts_none(self) -> None:
        config = MINTConfig(subtasks=None)
        assert config.subtasks is None

    def test_config_subtasks_accepts_list(self) -> None:
        config = MINTConfig(subtasks=[MINTSubtask.GSM8K, MINTSubtask.HUMANEVAL])
        assert config.subtasks is not None
        assert len(config.subtasks) == 2

    def test_legacy_category_keyword_routes_to_subtask(self) -> None:
        task = MINTTask(
            id="legacy-001",
            category=MINTSubtask.MATH,  # legacy kwarg name
            initial_prompt="test",
            ground_truth="42",
        )
        assert task.subtask is MINTSubtask.MATH
        assert task.category is MINTSubtask.MATH
