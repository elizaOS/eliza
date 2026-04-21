"""Tests for context benchmark types."""


from elizaos_context_bench.types import (
    LEADERBOARD_SCORES,
    ContextBenchConfig,
    ContextBenchResult,
    ContextBenchTask,
    ContextBenchType,
    HaystackDomain,
    NeedlePosition,
    NeedleType,
)


class TestEnums:
    """Tests for enum types."""

    def test_context_bench_types(self) -> None:
        """Test ContextBenchType enum values."""
        assert ContextBenchType.NIAH_BASIC.value == "niah_basic"
        assert ContextBenchType.NIAH_SEMANTIC.value == "niah_semantic"
        assert ContextBenchType.MULTI_HOP.value == "multi_hop"

    def test_needle_positions(self) -> None:
        """Test NeedlePosition enum values."""
        positions = list(NeedlePosition)
        assert len(positions) == 6
        assert NeedlePosition.START in positions
        assert NeedlePosition.MIDDLE in positions
        assert NeedlePosition.END in positions

    def test_needle_types(self) -> None:
        """Test NeedleType enum values."""
        types = list(NeedleType)
        assert len(types) >= 5
        assert NeedleType.FACT in types
        assert NeedleType.NUMBER in types

    def test_haystack_domains(self) -> None:
        """Test HaystackDomain enum values."""
        domains = list(HaystackDomain)
        assert HaystackDomain.GENERAL in domains
        assert HaystackDomain.TECHNICAL in domains


class TestDataclasses:
    """Tests for dataclass structures."""

    def test_context_bench_task_creation(self) -> None:
        """Test creating a ContextBenchTask."""
        task = ContextBenchTask(
            id="test_001",
            bench_type=ContextBenchType.NIAH_BASIC,
            context="This is a test context with some information.",
            context_length=10,
            question="What is this?",
            needle="The secret is XYZ.",
            needle_position=NeedlePosition.MIDDLE,
            expected_answer="XYZ",
        )
        assert task.id == "test_001"
        assert task.bench_type == ContextBenchType.NIAH_BASIC
        assert task.context_length == 10
        assert task.num_hops == 1  # Default value
        assert task.requires_reasoning is False  # Default value

    def test_context_bench_result_creation(self) -> None:
        """Test creating a ContextBenchResult."""
        result = ContextBenchResult(
            task_id="test_001",
            bench_type=ContextBenchType.NIAH_BASIC,
            context_length=1000,
            needle_position=NeedlePosition.MIDDLE,
            actual_position_pct=50.0,
            predicted_answer="XYZ",
            expected_answer="XYZ",
            exact_match=True,
            semantic_similarity=1.0,
            retrieval_success=True,
            latency_ms=150.0,
            tokens_processed=1000,
        )
        assert result.task_id == "test_001"
        assert result.exact_match is True
        assert result.retrieval_success is True
        assert result.error is None

    def test_context_bench_config_defaults(self) -> None:
        """Test ContextBenchConfig default values."""
        config = ContextBenchConfig()
        assert config.run_niah_basic is True
        assert config.run_niah_semantic is True
        assert config.run_multi_hop is True
        assert len(config.context_lengths) > 0
        assert len(config.positions) > 0
        assert config.semantic_threshold == 0.8
        # All default context lengths should be positive
        assert all(length > 0 for length in config.context_lengths)
        # Default tasks_per_position should be valid
        assert config.tasks_per_position > 0


class TestLeaderboardScores:
    """Tests for leaderboard reference scores."""

    def test_leaderboard_has_models(self) -> None:
        """Test that leaderboard scores exist."""
        assert len(LEADERBOARD_SCORES) > 0

    def test_leaderboard_model_structure(self) -> None:
        """Test that leaderboard entries have expected structure."""
        for model_name, scores in LEADERBOARD_SCORES.items():
            assert isinstance(model_name, str)
            assert isinstance(scores, dict)
            # Should have overall score
            assert "overall" in scores
            # Should have lost in middle score
            assert "lost_in_middle" in scores
            # All scores should be floats between 0 and 1
            for key, value in scores.items():
                assert isinstance(value, float)
                assert 0 <= value <= 1, f"{model_name}.{key} = {value} not in [0,1]"

    def test_gpt4_turbo_scores(self) -> None:
        """Test GPT-4-turbo reference scores."""
        scores = LEADERBOARD_SCORES.get("gpt-4-turbo")
        assert scores is not None
        assert scores["overall"] >= 0.9  # GPT-4 should be good
        assert scores["niah_4k"] >= 0.95  # Very good at short context
