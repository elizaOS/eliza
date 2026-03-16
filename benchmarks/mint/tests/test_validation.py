"""
Tests for input validation across MINT benchmark components.
"""

import pytest

from benchmarks.mint.types import MINTCategory, MINTConfig
from benchmarks.mint.dataset import MINTDataset
from benchmarks.mint.agent import MINTAgent
from benchmarks.mint.feedback import FeedbackGenerator


class TestDatasetValidation:
    """Tests for dataset input validation."""

    @pytest.fixture
    def dataset(self) -> MINTDataset:
        """Create a dataset instance."""
        return MINTDataset()

    def test_parse_task_requires_id(self, dataset: MINTDataset) -> None:
        """Test that parsing fails without task ID."""
        with pytest.raises(ValueError, match="must have an 'id' field"):
            dataset._parse_task({}, MINTCategory.REASONING)

    def test_parse_task_requires_prompt(self, dataset: MINTDataset) -> None:
        """Test that parsing fails without initial prompt."""
        with pytest.raises(ValueError, match="must have 'initial_prompt'"):
            dataset._parse_task(
                {"id": "test-001"},
                MINTCategory.REASONING,
            )

    def test_parse_task_requires_ground_truth(self, dataset: MINTDataset) -> None:
        """Test that parsing fails without ground truth."""
        with pytest.raises(ValueError, match="must have 'ground_truth'"):
            dataset._parse_task(
                {"id": "test-001", "initial_prompt": "test prompt"},
                MINTCategory.REASONING,
            )

    def test_parse_task_validates_max_turns_bounds(self, dataset: MINTDataset) -> None:
        """Test that max_turns is clamped to valid range."""
        task = dataset._parse_task(
            {
                "id": "test-001",
                "initial_prompt": "test",
                "ground_truth": "answer",
                "max_turns": 100,  # Too high
            },
            MINTCategory.REASONING,
        )
        assert task.max_turns <= 20  # Should be clamped

        task = dataset._parse_task(
            {
                "id": "test-002",
                "initial_prompt": "test",
                "ground_truth": "answer",
                "max_turns": -5,  # Too low
            },
            MINTCategory.REASONING,
        )
        assert task.max_turns >= 1  # Should be clamped

    def test_parse_task_validates_difficulty(self, dataset: MINTDataset) -> None:
        """Test that invalid difficulty defaults to medium."""
        task = dataset._parse_task(
            {
                "id": "test-001",
                "initial_prompt": "test",
                "ground_truth": "answer",
                "difficulty": "impossible",  # Invalid
            },
            MINTCategory.REASONING,
        )
        assert task.difficulty == "medium"

    def test_parse_task_validates_metric(self, dataset: MINTDataset) -> None:
        """Test that invalid metric defaults to exact_match."""
        task = dataset._parse_task(
            {
                "id": "test-001",
                "initial_prompt": "test",
                "ground_truth": "answer",
                "evaluation_metric": "unknown_metric",  # Invalid
            },
            MINTCategory.REASONING,
        )
        assert task.evaluation_metric == "exact_match"


class TestAgentValidation:
    """Tests for agent input validation."""

    def test_agent_clamps_temperature(self) -> None:
        """Test that temperature is clamped to valid range."""
        agent = MINTAgent(temperature=2.0)  # Too high
        assert agent.temperature <= 1.0

        agent = MINTAgent(temperature=-0.5)  # Too low
        assert agent.temperature >= 0.0


class TestFeedbackGeneratorValidation:
    """Tests for feedback generator validation."""

    def test_feedback_generator_without_runtime(self) -> None:
        """Test that feedback generator works without runtime."""
        generator = FeedbackGenerator(runtime=None, use_llm=True)
        # Should not use LLM since runtime is None
        assert generator.use_llm is False

    def test_feedback_generator_with_invalid_runtime(self) -> None:
        """Test that feedback generator handles invalid runtime."""
        # Pass an object that doesn't implement ModelRuntime protocol
        generator = FeedbackGenerator(runtime="not a runtime", use_llm=True)  # type: ignore
        assert generator.use_llm is False
        assert generator.runtime is None


class TestConfigValidation:
    """Tests for configuration validation."""

    def test_config_default_values(self) -> None:
        """Test that config has sensible defaults."""
        config = MINTConfig()
        assert config.max_turns > 0
        assert config.timeout_per_task_ms > 0
        assert config.code_timeout_seconds > 0
        assert 0.0 <= config.temperature <= 1.0

    def test_config_categories_accepts_none(self) -> None:
        """Test that None categories means all categories."""
        config = MINTConfig(categories=None)
        assert config.categories is None

    def test_config_categories_accepts_list(self) -> None:
        """Test that specific categories can be set."""
        config = MINTConfig(categories=[MINTCategory.REASONING, MINTCategory.CODING])
        assert config.categories is not None
        assert len(config.categories) == 2
