"""Tests for input validation across context-bench."""

import pytest

from elizaos_context_bench.generator import ContextGenerator
from elizaos_context_bench.types import ContextBenchConfig


class TestConfigValidation:
    """Tests for ContextBenchConfig validation."""

    def test_valid_config(self) -> None:
        """Test that valid config passes validation."""
        config = ContextBenchConfig(
            context_lengths=[1024, 2048],
            tasks_per_position=3,
            semantic_threshold=0.7,
        )
        assert config.tasks_per_position == 3

    def test_empty_context_lengths_raises(self) -> None:
        """Test that empty context_lengths raises ValueError."""
        with pytest.raises(ValueError, match="context_lengths cannot be empty"):
            ContextBenchConfig(context_lengths=[])

    def test_negative_context_length_raises(self) -> None:
        """Test that negative context length raises ValueError."""
        with pytest.raises(ValueError, match="must contain positive integers"):
            ContextBenchConfig(context_lengths=[-100, 1024])

    def test_zero_context_length_raises(self) -> None:
        """Test that zero context length raises ValueError."""
        with pytest.raises(ValueError, match="must contain positive integers"):
            ContextBenchConfig(context_lengths=[0, 1024])

    def test_negative_max_context_length_raises(self) -> None:
        """Test that negative max_context_length raises ValueError."""
        with pytest.raises(ValueError, match="max_context_length must be positive"):
            ContextBenchConfig(max_context_length=-1)

    def test_context_length_exceeds_max_raises(self) -> None:
        """Test that a context length exceeding max_context_length raises ValueError."""
        with pytest.raises(ValueError, match="exceeds max_context_length"):
            ContextBenchConfig(context_lengths=[2048], max_context_length=1024)

    def test_empty_positions_raises(self) -> None:
        """Test that empty positions raises ValueError."""
        with pytest.raises(ValueError, match="positions cannot be empty"):
            ContextBenchConfig(positions=[])

    def test_zero_tasks_per_position_raises(self) -> None:
        """Test that zero tasks_per_position raises ValueError."""
        with pytest.raises(ValueError, match="tasks_per_position must be positive"):
            ContextBenchConfig(tasks_per_position=0)

    def test_invalid_multi_hop_depth_raises(self) -> None:
        """Test that invalid multi_hop_depths raises ValueError."""
        with pytest.raises(ValueError, match="multi_hop_depths must contain positive integers"):
            ContextBenchConfig(multi_hop_depths=[0, 2])

    def test_semantic_threshold_too_low_raises(self) -> None:
        """Test that semantic_threshold < 0 raises ValueError."""
        with pytest.raises(ValueError, match="semantic_threshold must be between"):
            ContextBenchConfig(semantic_threshold=-0.1)

    def test_semantic_threshold_too_high_raises(self) -> None:
        """Test that semantic_threshold > 1 raises ValueError."""
        with pytest.raises(ValueError, match="semantic_threshold must be between"):
            ContextBenchConfig(semantic_threshold=1.5)

    def test_zero_timeout_raises(self) -> None:
        """Test that zero timeout_per_task_ms raises ValueError."""
        with pytest.raises(ValueError, match="timeout_per_task_ms must be positive"):
            ContextBenchConfig(timeout_per_task_ms=0)


class TestGeneratorValidation:
    """Tests for ContextGenerator input validation."""

    def test_empty_task_id_raises(self) -> None:
        """Test that empty task_id raises ValueError."""
        gen = ContextGenerator(seed=42)
        with pytest.raises(ValueError, match="task_id cannot be empty"):
            gen.generate_niah_task(task_id="", context_length=1024)

    def test_zero_context_length_niah_raises(self) -> None:
        """Test that zero context_length raises ValueError in NIAH."""
        gen = ContextGenerator(seed=42)
        with pytest.raises(ValueError, match="context_length must be positive"):
            gen.generate_niah_task(task_id="test", context_length=0)

    def test_negative_context_length_niah_raises(self) -> None:
        """Test that negative context_length raises ValueError in NIAH."""
        gen = ContextGenerator(seed=42)
        with pytest.raises(ValueError, match="context_length must be positive"):
            gen.generate_niah_task(task_id="test", context_length=-100)

    def test_zero_context_length_multihop_raises(self) -> None:
        """Test that zero context_length raises ValueError in multi-hop."""
        gen = ContextGenerator(seed=42)
        with pytest.raises(ValueError, match="context_length must be positive"):
            gen.generate_multi_hop_task(task_id="test", context_length=0)

    def test_zero_num_hops_raises(self) -> None:
        """Test that zero num_hops raises ValueError."""
        gen = ContextGenerator(seed=42)
        with pytest.raises(ValueError, match="num_hops must be >= 1"):
            gen.generate_multi_hop_task(task_id="test", context_length=1024, num_hops=0)

    def test_negative_num_hops_raises(self) -> None:
        """Test that negative num_hops raises ValueError."""
        gen = ContextGenerator(seed=42)
        with pytest.raises(ValueError, match="num_hops must be >= 1"):
            gen.generate_multi_hop_task(task_id="test", context_length=1024, num_hops=-1)


class TestTypeCoercion:
    """Tests for proper type handling."""

    def test_config_context_lengths_are_integers(self) -> None:
        """Test that context_lengths must be integers."""
        # This should work with integers
        config = ContextBenchConfig(context_lengths=[1024, 2048])
        assert all(isinstance(l, int) for l in config.context_lengths)

    def test_generator_produces_valid_types(self) -> None:
        """Test that generator produces correctly typed output."""
        gen = ContextGenerator(seed=42)
        task = gen.generate_niah_task(
            task_id="test_1",
            context_length=500,
        )

        # Verify types
        assert isinstance(task.id, str)
        assert isinstance(task.context, str)
        assert isinstance(task.context_length, int)
        assert isinstance(task.question, str)
        assert isinstance(task.needle, str)
        assert isinstance(task.expected_answer, str)
        assert isinstance(task.actual_position_pct, float)
        assert isinstance(task.num_hops, int)
        assert isinstance(task.requires_reasoning, bool)
