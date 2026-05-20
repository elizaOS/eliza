"""
Tests for HuggingFace Dataset Reader

Comprehensive tests covering:
- Configuration and initialization
- Dataset loading and parsing
- Trajectory grouping by window
- Error handling for malformed data
- Edge cases (empty datasets, single trajectory, etc.)
- Integration with existing TrajectoryRow format
"""

import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.data_bridge.hf_reader import (
    HFReaderConfig,
    HuggingFaceTrajectoryReader,
    create_trajectory_reader_from_hf,
)
from src.data_bridge.reader import (
    PostgresTrajectoryReader,
    TrajectoryRow,
    count_usable_action_steps,
    count_valid_llm_steps,
    has_minimum_usable_action_steps,
    has_minimum_valid_llm_steps,
    validate_llm_calls,
)

# =============================================================================
# Configuration Tests
# =============================================================================


class TestHFReaderConfig:
    """Tests for HFReaderConfig dataclass."""

    def test_default_values(self):
        """Test default configuration values."""
        config = HFReaderConfig(dataset_id="org/dataset")

        assert config.dataset_id == "org/dataset"
        assert config.split == "raw"
        assert config.streaming is False
        assert config.max_trajectories == 50000
        assert config.min_actions == 3
        assert config.cache_dir is None

    def test_custom_values(self):
        """Test custom configuration values."""
        config = HFReaderConfig(
            dataset_id="myorg/my-dataset",
            split="preferences",
            streaming=True,
            max_trajectories=1000,
            min_actions=5,
            cache_dir="/tmp/hf_cache",
        )

        assert config.dataset_id == "myorg/my-dataset"
        assert config.split == "preferences"
        assert config.streaming is True
        assert config.max_trajectories == 1000
        assert config.min_actions == 5
        assert config.cache_dir == "/tmp/hf_cache"

    def test_hf_token_from_env(self):
        """Test HF token loaded from environment."""
        with patch.dict("os.environ", {"HF_TOKEN": "test-token-123"}):
            config = HFReaderConfig(dataset_id="org/dataset")
            assert config.hf_token == "test-token-123"

    def test_hf_token_explicit(self):
        """Test explicit HF token overrides environment."""
        with patch.dict("os.environ", {"HF_TOKEN": "env-token"}):
            config = HFReaderConfig(dataset_id="org/dataset", hf_token="explicit-token")
            assert config.hf_token == "explicit-token"


# =============================================================================
# Mock Dataset Creation
# =============================================================================


def create_mock_trajectory_row(
    trajectory_id: str,
    window_id: str,
    archetype: str = "trader",
    final_pnl: float = 100.0,
    episode_length: int = 5,
    steps: list[dict] | None = None,
) -> dict[str, Any]:
    """Create a mock trajectory row matching HuggingFace dataset schema."""
    if steps is None:
        steps = create_valid_steps(episode_length, archetype)

    return {
        "trajectory_id": trajectory_id,
        "agent_id": f"agent-{trajectory_id[-3:]}",
        "agent_name": f"Agent {trajectory_id[-3:]}",
        "window_id": window_id,
        "scenario_id": "test-scenario",
        "archetype": archetype,
        "steps": json.dumps(steps),  # Stored as JSON string
        "final_pnl": final_pnl,
        "final_balance": 10000.0 + final_pnl,
        "episode_length": episode_length,
        "total_reward": 0.5,
        "metadata": json.dumps({"test": True}),
        "created_at": "2025-01-22T00:00:00Z",
    }


def create_valid_steps(count: int, archetype: str = "trader") -> list[dict]:
    """Create valid LLM call steps for testing."""
    steps = []
    for i in range(count):
        steps.append(
            {
                "stepNumber": i,
                "llmCalls": [
                    {
                        "purpose": "action",
                        "systemPrompt": f"You are a {archetype} making trading decisions. " * 3,
                        "userPrompt": f"Step {i}: Analyze the market. " * 3,
                        "response": f"Based on my analysis, I will take action {i}. " * 2,
                    }
                ],
                "action": {
                    "actionType": "buy" if i % 2 == 0 else "hold",
                    "parameters": {"amount": 100},
                },
            }
        )
    return steps


def create_mock_dataset(trajectories: list[dict]) -> MagicMock:
    """Create a mock HuggingFace dataset that can be iterated."""
    mock_dataset = MagicMock()
    mock_dataset.__iter__ = lambda self: iter(trajectories)
    mock_dataset.__len__ = lambda self: len(trajectories)
    return mock_dataset


# =============================================================================
# Reader Initialization Tests
# =============================================================================


class TestHuggingFaceTrajectoryReaderInit:
    """Tests for reader initialization."""

    def test_init_creates_empty_state(self):
        """Test that initialization creates empty internal state."""
        config = HFReaderConfig(dataset_id="org/dataset")
        reader = HuggingFaceTrajectoryReader(config)

        assert reader._dataset is None
        assert reader._trajectories_by_window == {}
        assert reader._loaded is False

    def test_not_connected_raises_on_operations(self):
        """Test that operations fail when not connected."""
        config = HFReaderConfig(dataset_id="org/dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with pytest.raises(RuntimeError, match="not connected"):
            reader.get_trajectory_groups()


# =============================================================================
# Dataset Loading Tests
# =============================================================================


class TestDatasetLoading:
    """Tests for loading datasets from HuggingFace."""

    @pytest.mark.asyncio
    async def test_connect_loads_dataset(self):
        """Test that connect() loads and parses the dataset."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1"),
            create_mock_trajectory_row("traj-002", "window-1"),
            create_mock_trajectory_row("traj-003", "window-2"),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            result = await reader.connect()

        assert result is True
        assert reader._loaded is True
        assert len(reader._trajectories_by_window) == 2
        assert "window-1" in reader._trajectories_by_window
        assert "window-2" in reader._trajectories_by_window

    @pytest.mark.asyncio
    async def test_connect_respects_max_trajectories(self):
        """Test that max_trajectories limit is respected."""
        mock_trajectories = [
            create_mock_trajectory_row(f"traj-{i:03d}", f"window-{i}") for i in range(100)
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(
            dataset_id="org/test-dataset",
            max_trajectories=10,
        )
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        total_trajectories = sum(len(t) for t in reader._trajectories_by_window.values())
        assert total_trajectories == 10

    @pytest.mark.asyncio
    async def test_connect_filters_by_min_actions(self):
        """Test that trajectories below min_actions are filtered out."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1", episode_length=5),  # Valid
            create_mock_trajectory_row("traj-002", "window-1", episode_length=2),  # Too short
            create_mock_trajectory_row("traj-003", "window-1", episode_length=3),  # Valid
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(
            dataset_id="org/test-dataset",
            min_actions=3,
        )
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectories = reader._trajectories_by_window.get("window-1", [])
        assert len(trajectories) == 2  # Only 2 valid trajectories


# =============================================================================
# Trajectory Parsing Tests
# =============================================================================


class TestTrajectoryParsing:
    """Tests for parsing trajectory data from dataset rows."""

    @pytest.mark.asyncio
    async def test_parse_steps_from_json_string(self):
        """Test parsing steps from JSON string format."""
        steps = create_valid_steps(5)
        mock_trajectories = [
            {
                **create_mock_trajectory_row("traj-001", "window-1"),
                "steps": json.dumps(steps),  # JSON string
            }
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectories = reader._trajectories_by_window["window-1"]
        assert len(trajectories) == 1
        assert len(trajectories[0]["steps"]) == 5

    @pytest.mark.asyncio
    async def test_parse_steps_from_list(self):
        """Test parsing steps when already a list (not JSON string)."""
        steps = create_valid_steps(5)
        mock_trajectories = [
            {
                **create_mock_trajectory_row("traj-001", "window-1"),
                "steps": steps,  # Already a list
            }
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectories = reader._trajectories_by_window["window-1"]
        assert len(trajectories) == 1
        assert len(trajectories[0]["steps"]) == 5

    @pytest.mark.asyncio
    async def test_parse_metadata_from_json_string(self):
        """Test parsing metadata from JSON string."""
        mock_trajectories = [
            {
                **create_mock_trajectory_row("traj-001", "window-1"),
                "metadata": json.dumps({"custom_field": "value", "score": 0.9}),
            }
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectory = reader._trajectories_by_window["window-1"][0]
        assert trajectory["metadata"]["custom_field"] == "value"
        assert trajectory["metadata"]["score"] == 0.9

    @pytest.mark.asyncio
    async def test_compute_starting_balance(self):
        """Test that starting_balance is computed correctly."""
        mock_trajectories = [
            {
                **create_mock_trajectory_row("traj-001", "window-1"),
                "final_pnl": 150.0,
                "final_balance": 10150.0,
            }
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectory = reader._trajectories_by_window["window-1"][0]
        assert trajectory["starting_balance"] == 10000.0  # 10150 - 150


# =============================================================================
# Edge Cases and Error Handling
# =============================================================================


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    @pytest.mark.asyncio
    async def test_empty_dataset(self):
        """Test handling of empty dataset."""
        mock_dataset = create_mock_dataset([])

        config = HFReaderConfig(dataset_id="org/empty-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        assert reader._loaded is True
        assert len(reader._trajectories_by_window) == 0

    @pytest.mark.asyncio
    async def test_malformed_steps_skipped(self):
        """Test that trajectories with malformed steps are skipped."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1"),  # Valid
            {
                **create_mock_trajectory_row("traj-002", "window-1"),
                "steps": "not valid json {{{",  # Invalid JSON
            },
            {
                **create_mock_trajectory_row("traj-003", "window-1"),
                "steps": None,  # None
            },
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        # Only valid trajectory should be loaded
        trajectories = reader._trajectories_by_window.get("window-1", [])
        assert len(trajectories) == 1
        assert trajectories[0]["trajectory_id"] == "traj-001"

    @pytest.mark.asyncio
    async def test_missing_window_id_uses_default(self):
        """Test that missing window_id uses default."""
        mock_trajectories = [
            {
                **create_mock_trajectory_row("traj-001", "window-1"),
                "window_id": None,  # Missing
            }
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        assert "default_window" in reader._trajectories_by_window

    @pytest.mark.asyncio
    async def test_missing_archetype_uses_default(self):
        """Test that missing archetype uses default."""
        mock_trajectories = [
            {
                **create_mock_trajectory_row("traj-001", "window-1"),
                "archetype": None,
            }
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectory = reader._trajectories_by_window["window-1"][0]
        assert trajectory["archetype"] == "default"


# =============================================================================
# Window ID and Grouping Tests
# =============================================================================


class TestWindowGrouping:
    """Tests for trajectory grouping by window."""

    @pytest.mark.asyncio
    async def test_get_window_ids(self):
        """Test getting distinct window IDs."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-a"),
            create_mock_trajectory_row("traj-002", "window-a"),
            create_mock_trajectory_row("traj-003", "window-b"),
            create_mock_trajectory_row("traj-004", "window-c"),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        window_ids = await reader.get_window_ids()
        assert set(window_ids) == {"window-a", "window-b", "window-c"}

    @pytest.mark.asyncio
    async def test_get_window_ids_with_min_agents(self):
        """Test filtering windows by minimum agent count."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-a"),
            create_mock_trajectory_row("traj-002", "window-a"),  # 2 in window-a
            create_mock_trajectory_row("traj-003", "window-b"),  # 1 in window-b
            create_mock_trajectory_row("traj-004", "window-c"),
            create_mock_trajectory_row("traj-005", "window-c"),
            create_mock_trajectory_row("traj-006", "window-c"),  # 3 in window-c
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        # Only windows with >= 2 trajectories
        window_ids = await reader.get_window_ids(min_agents=2)
        assert "window-a" in window_ids
        assert "window-c" in window_ids
        assert "window-b" not in window_ids

    @pytest.mark.asyncio
    async def test_get_window_ids_with_min_agents_counts_distinct_agents(self):
        """Windows should pass only when they have enough distinct agents."""
        window_a_rows = [
            create_mock_trajectory_row("traj-001", "window-a"),
            create_mock_trajectory_row("traj-002", "window-a"),
        ]
        for row in window_a_rows:
            row["agent_id"] = "agent-shared"

        window_b_rows = [
            create_mock_trajectory_row("traj-003", "window-b"),
            create_mock_trajectory_row("traj-004", "window-b"),
        ]
        window_b_rows[0]["agent_id"] = "agent-1"
        window_b_rows[1]["agent_id"] = "agent-2"

        mock_dataset = create_mock_dataset(window_a_rows + window_b_rows)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        window_ids = await reader.get_window_ids(min_agents=2)
        assert "window-b" in window_ids
        assert "window-a" not in window_ids

    @pytest.mark.asyncio
    async def test_get_window_ids_with_limit(self):
        """Test limiting number of windows returned."""
        mock_trajectories = [
            create_mock_trajectory_row(f"traj-{i}", f"window-{i}") for i in range(20)
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        window_ids = await reader.get_window_ids(limit=5)
        assert len(window_ids) == 5


# =============================================================================
# Trajectory Retrieval Tests
# =============================================================================


class TestTrajectoryRetrieval:
    """Tests for retrieving trajectories by window."""

    @pytest.mark.asyncio
    async def test_get_trajectories_by_window(self):
        """Test getting trajectories for a specific window."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1", "trader", 100.0),
            create_mock_trajectory_row("traj-002", "window-1", "degen", -50.0),
            create_mock_trajectory_row("traj-003", "window-2", "analyst", 200.0),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectories = await reader.get_trajectories_by_window("window-1")

        assert len(trajectories) == 2
        assert all(isinstance(t, TrajectoryRow) for t in trajectories)
        assert trajectories[0].window_id == "window-1"
        assert trajectories[1].window_id == "window-1"

    @pytest.mark.asyncio
    async def test_get_trajectories_nonexistent_window(self):
        """Test getting trajectories for a non-existent window returns empty."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1"),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        trajectories = await reader.get_trajectories_by_window("nonexistent")
        assert len(trajectories) == 0

    @pytest.mark.asyncio
    async def test_get_trajectories_validates_llm_calls(self):
        """Test that LLM call validation is applied when requested."""
        # Create trajectory with invalid LLM calls (too short)
        invalid_steps = [
            {
                "stepNumber": 0,
                "llmCalls": [
                    {
                        "purpose": "action",
                        "systemPrompt": "This is a valid system prompt with enough content.",
                        "userPrompt": "This is a valid user prompt with enough content.",
                        "response": "This is a valid response with enough content.",
                    }
                ],
                "action": {
                    "actionType": "trade",
                    "parameters": {"marketId": "BTC"},
                },
            }
        ]

        mock_trajectories = [
            {
                **create_mock_trajectory_row("traj-001", "window-1"),
                "steps": json.dumps(invalid_steps),
                "episode_length": 1,
            },
            create_mock_trajectory_row("traj-002", "window-1"),  # Valid
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset", min_actions=1)
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        # With validation
        trajectories = await reader.get_trajectories_by_window("window-1", validate=True)
        assert len(trajectories) == 1  # Only valid trajectory

        # Without validation
        trajectories = await reader.get_trajectories_by_window("window-1", validate=False)
        assert len(trajectories) == 2  # Both trajectories


# =============================================================================
# Trajectory Groups for Training Tests
# =============================================================================


class TestTrajectoryGroups:
    """Tests for getting trajectory groups formatted for training."""

    @pytest.mark.asyncio
    async def test_get_trajectory_groups(self):
        """Test getting trajectory groups in training format."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1"),
            create_mock_trajectory_row("traj-002", "window-1"),
            create_mock_trajectory_row("traj-003", "window-2"),
            create_mock_trajectory_row("traj-004", "window-2"),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        groups = reader.get_trajectory_groups(min_agents_per_window=2)

        assert len(groups) == 2
        for group in groups:
            assert "group_key" in group
            assert "trajectories" in group
            assert len(group["trajectories"]) >= 2

    @pytest.mark.asyncio
    async def test_get_trajectory_groups_filters_small_windows(self):
        """Test that small windows are filtered out."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1"),
            create_mock_trajectory_row("traj-002", "window-1"),  # 2 in window-1
            create_mock_trajectory_row("traj-003", "window-2"),  # 1 in window-2
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        groups = reader.get_trajectory_groups(min_agents_per_window=2)

        assert len(groups) == 1
        assert groups[0]["group_key"].startswith("window-1")


# =============================================================================
# Statistics Tests
# =============================================================================


class TestStatistics:
    """Tests for dataset statistics."""

    @pytest.mark.asyncio
    async def test_get_stats(self):
        """Test getting dataset statistics."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1", "trader", 100.0, 5),
            create_mock_trajectory_row("traj-002", "window-1", "degen", -50.0, 10),
            create_mock_trajectory_row("traj-003", "window-2", "trader", 200.0, 3),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            await reader.connect()

        stats = reader.get_stats()

        assert stats["loaded"] is True
        assert stats["dataset_id"] == "org/test-dataset"
        assert stats["total_trajectories"] == 3
        assert stats["total_windows"] == 2
        assert stats["avg_trajectories_per_window"] == 1.5
        assert stats["avg_pnl"] == pytest.approx(83.33, rel=0.1)  # (100-50+200)/3
        assert "trader" in stats["archetypes"]
        assert "degen" in stats["archetypes"]

    def test_get_stats_not_loaded(self):
        """Test stats when reader is not loaded."""
        config = HFReaderConfig(dataset_id="org/test-dataset")
        reader = HuggingFaceTrajectoryReader(config)

        stats = reader.get_stats()

        assert stats["loaded"] is False


# =============================================================================
# Async Context Manager Tests
# =============================================================================


class TestAsyncContextManager:
    """Tests for async context manager support."""

    @pytest.mark.asyncio
    async def test_async_context_manager(self):
        """Test using reader as async context manager."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1"),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        config = HFReaderConfig(dataset_id="org/test-dataset")

        with patch("datasets.load_dataset", return_value=mock_dataset):
            async with HuggingFaceTrajectoryReader(config) as reader:
                assert reader._loaded is True
                window_ids = await reader.get_window_ids()
                assert len(window_ids) == 1

        # After exit, state should be cleared
        assert reader._loaded is False
        assert reader._trajectories_by_window == {}


# =============================================================================
# Factory Function Tests
# =============================================================================


class TestFactoryFunction:
    """Tests for the create_trajectory_reader_from_hf factory."""

    @pytest.mark.asyncio
    async def test_factory_creates_connected_reader(self):
        """Test factory function creates and connects reader."""
        mock_trajectories = [
            create_mock_trajectory_row("traj-001", "window-1"),
        ]
        mock_dataset = create_mock_dataset(mock_trajectories)

        with patch("datasets.load_dataset", return_value=mock_dataset):
            reader = await create_trajectory_reader_from_hf(
                dataset_id="org/test-dataset",
                split="raw",
                max_trajectories=100,
                min_actions=3,
            )

        assert reader._loaded is True
        assert reader.config.dataset_id == "org/test-dataset"
        assert reader.config.split == "raw"
        assert reader.config.max_trajectories == 100


# =============================================================================
# LLM Call Validation Tests (unit tests for validate_llm_calls)
# =============================================================================


class TestValidateLLMCalls:
    """Tests for LLM call validation function."""

    def test_valid_llm_calls(self):
        """Test validation of valid LLM calls."""
        steps = create_valid_steps(3)
        is_valid, issues = validate_llm_calls(steps)

        assert is_valid is True
        assert len(issues) == 0

    def test_empty_steps(self):
        """Test validation of empty steps."""
        is_valid, issues = validate_llm_calls([])

        assert is_valid is False
        assert any("no steps" in issue.lower() for issue in issues)

    def test_short_prompts(self):
        """Test validation rejects short prompts."""
        steps = [
            {
                "stepNumber": 0,
                "llmCalls": [
                    {
                        "systemPrompt": "hi",  # Too short
                        "userPrompt": "test",  # Too short
                        "response": "ok",  # Too short
                    }
                ],
            }
        ]

        is_valid, issues = validate_llm_calls(steps, min_steps_with_llm=1)

        assert is_valid is False
        assert len(issues) > 0

    def test_insufficient_valid_steps(self):
        """Test validation with insufficient valid steps."""
        # Only 1 valid step, but need 3
        steps = [
            *[
                {
                    "stepNumber": i,
                    "llmCalls": [
                        {
                            "systemPrompt": "short",
                            "userPrompt": "short",
                            "response": "short",
                        }
                    ],
                }
                for i in range(2)
            ],
            {
                "stepNumber": 2,
                "llmCalls": [
                    {
                        "purpose": "action",
                        "systemPrompt": "This is a valid system prompt with enough content for validation.",
                        "userPrompt": "This is a valid user prompt with enough content for validation.",
                        "response": "This is a valid response with enough content for validation.",
                    }
                ],
            },
        ]

        is_valid, _issues = validate_llm_calls(steps, min_steps_with_llm=2)

        assert is_valid is False

    def test_steps_without_llm_calls(self):
        """Test validation of steps without LLM calls."""
        steps = [
            {"stepNumber": 0, "action": {"type": "buy"}},
            {"stepNumber": 1, "action": {"type": "sell"}},
        ]

        is_valid, _issues = validate_llm_calls(steps, min_steps_with_llm=1)

        assert is_valid is False

    def test_count_valid_llm_steps_allows_mixed_quality_trajectories(self):
        """Mixed-quality trajectories should still report usable steps."""
        steps = [
            {
                "stepNumber": 0,
                "llmCalls": [
                    {
                        "systemPrompt": "This is a valid system prompt with enough content.",
                        "userPrompt": "This is a valid user prompt with enough content.",
                        "response": "This is a valid response with enough content.",
                    }
                ],
            },
            {
                "stepNumber": 1,
                "llmCalls": [
                    {
                        "systemPrompt": "This is a valid system prompt with enough content.",
                        "userPrompt": "This is a valid user prompt with enough content.",
                        "response": "short",
                    }
                ],
            },
        ]

        assert count_valid_llm_steps(steps) == 1
        assert has_minimum_valid_llm_steps(steps, min_steps_with_llm=1) == (True, 1)

    def test_count_usable_action_steps_requires_an_action_payload(self):
        steps = [
            {
                "stepNumber": 0,
                "llmCalls": [
                    {
                        "systemPrompt": "This is a valid system prompt with enough content.",
                        "userPrompt": "This is a valid user prompt with enough content.",
                        "response": "This is a valid response with enough content.",
                    }
                ],
                "action": {
                    "actionType": "trade",
                    "parameters": {"marketId": "BTC"},
                },
            },
            {
                "stepNumber": 1,
                "llmCalls": [
                    {
                        "systemPrompt": "This is a valid system prompt with enough content.",
                        "userPrompt": "This is a valid user prompt with enough content.",
                        "response": "This is a valid response with enough content.",
                    }
                ],
            },
        ]

        assert count_usable_action_steps(steps) == 1
        assert has_minimum_usable_action_steps(steps, min_actions=1) == (True, 1)
        assert has_minimum_usable_action_steps(steps, min_actions=2) == (False, 1)

    def test_count_usable_action_steps_accepts_action_llm_calls(self):
        steps = [
            {
                "stepNumber": 0,
                "llmCalls": [
                    {
                        "purpose": "action",
                        "actionType": "scam_defense_decision",
                        "systemPrompt": "This is a valid system prompt with enough content.",
                        "userPrompt": "This is a valid user prompt with enough content.",
                        "response": "I will refuse the unsafe request and protect secrets.",
                    }
                ],
            }
        ]

        assert count_usable_action_steps(steps) == 1
        assert has_minimum_usable_action_steps(steps, min_actions=1) == (True, 1)


class TestPostgresTrajectoryReaderContract:
    @pytest.mark.asyncio
    async def test_get_window_ids_uses_distinct_agents_and_limit(self, monkeypatch):
        captured: dict[str, object] = {}

        class FakeCursor:
            def __init__(self):
                self.rows = [("window-b",), ("window-a",)]

            def execute(self, query, params):
                captured["query"] = query
                captured["params"] = params

            def fetchall(self):
                return self.rows

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        class FakeConn:
            def __init__(self):
                self.cursor_obj = FakeCursor()

            def cursor(self):
                return self.cursor_obj

            def close(self):
                return None

        fake_conn = FakeConn()
        monkeypatch.setattr(
            "src.data_bridge.reader.psycopg2.connect",
            lambda *_args, **_kwargs: fake_conn,
        )

        async with PostgresTrajectoryReader("postgresql://example") as reader:
            window_ids = await reader.get_window_ids(
                limit=5,
                only_scored=True,
                lookback_hours=24,
                min_agents=2,
            )

        assert window_ids == ["window-b", "window-a"]
        assert 'COUNT(DISTINCT "agentId") >= %s' in captured["query"]
        assert captured["params"] == (24, 2, 5)

    @pytest.mark.asyncio
    async def test_get_trajectories_by_window_filters_on_usable_action_steps(self, monkeypatch):
        captured: dict[str, object] = {}
        bad_steps = [
            {
                "stepNumber": 0,
                "llmCalls": [
                    {
                        "systemPrompt": "s" * 30,
                        "userPrompt": "u" * 30,
                        "response": "r" * 30,
                    }
                ],
            }
        ]
        good_steps = [
            {
                "stepNumber": 0,
                "llmCalls": [
                    {
                        "systemPrompt": "s" * 30,
                        "userPrompt": "u" * 30,
                        "response": "r" * 30,
                    }
                ],
                "action": {"actionType": "trade", "parameters": {"marketId": "BTC"}},
            },
            {
                "stepNumber": 1,
                "llmCalls": [
                    {
                        "systemPrompt": "s" * 30,
                        "userPrompt": "u" * 30,
                        "response": "r" * 30,
                    }
                ],
                "action": {"actionType": "hold"},
            },
        ]

        class FakeCursor:
            def __init__(self):
                self.rows = [
                    (
                        "traj-bad",
                        "agent-1",
                        "window-1",
                        json.dumps(bad_steps),
                        "{}",
                        "{}",
                        0.0,
                        1,
                        "completed",
                        0.0,
                        0,
                        None,
                        "trader",
                    ),
                    (
                        "traj-good",
                        "agent-2",
                        "window-1",
                        json.dumps(good_steps),
                        "{}",
                        "{}",
                        1.0,
                        2,
                        "completed",
                        5.0,
                        1,
                        0.1,
                        "trader",
                    ),
                ]

            def execute(self, query, params):
                captured["query"] = query
                captured["params"] = params

            def fetchall(self):
                return self.rows

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        class FakeConn:
            def __init__(self):
                self.cursor_obj = FakeCursor()

            def cursor(self):
                return self.cursor_obj

            def close(self):
                return None

        fake_conn = FakeConn()
        monkeypatch.setattr(
            "src.data_bridge.reader.psycopg2.connect",
            lambda *_args, **_kwargs: fake_conn,
        )

        async with PostgresTrajectoryReader("postgresql://example") as reader:
            trajectories = await reader.get_trajectories_by_window(
                "window-1",
                validate=True,
                min_actions=2,
            )

        assert 'episodeLength" >= %s' in captured["query"]
        assert captured["params"] == ("window-1", 2)
        assert len(trajectories) == 1
        assert trajectories[0].trajectory_id == "traj-good"
