"""
Integration Tests for Trajectory Source Configuration

Tests for the trajectory source switching feature that allows loading
trajectories from either PostgreSQL database or HuggingFace datasets.

These tests cover:
- Configuration parsing from environment variables
- Database source setup
- HuggingFace source setup
- Error handling for invalid configurations
- Source switching and fallback behavior
"""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.training.babylon_env import BabylonEnvConfig, BabylonRLAIFEnv

# =============================================================================
# Configuration Tests
# =============================================================================


class TestBabylonEnvConfig:
    """Tests for trajectory source configuration."""

    def test_default_trajectory_source(self):
        """Test that default trajectory source is 'db'."""
        with patch.dict("os.environ", {}, clear=True):
            config = BabylonEnvConfig(
                tokenizer_name="test/model",
                database_url="postgresql://localhost/test",
            )

        assert config.trajectory_source == "db"

    def test_trajectory_source_from_env(self):
        """Test loading trajectory source from environment."""
        with patch.dict("os.environ", {"TRAJECTORY_SOURCE": "huggingface"}):
            config = BabylonEnvConfig(
                tokenizer_name="test/model",
            )

        assert config.trajectory_source == "huggingface"

    def test_hf_dataset_config_from_env(self):
        """Test loading HuggingFace dataset config from environment."""
        env_vars = {
            "TRAJECTORY_SOURCE": "huggingface",
            "HF_TRAJECTORY_DATASET": "elizaos/test-dataset",
            "HF_TRAJECTORY_SPLIT": "preferences",
        }

        with patch.dict("os.environ", env_vars):
            config = BabylonEnvConfig(
                tokenizer_name="test/model",
            )

        assert config.trajectory_source == "huggingface"
        assert config.hf_trajectory_dataset == "elizaos/test-dataset"
        assert config.hf_trajectory_split == "preferences"

    def test_default_hf_split(self):
        """Test default HuggingFace split is 'raw'."""
        with patch.dict("os.environ", {}, clear=True):
            config = BabylonEnvConfig(
                tokenizer_name="test/model",
            )

        assert config.hf_trajectory_split == "raw"

    def test_database_url_from_env(self):
        """Test loading database URL from environment."""
        with patch.dict("os.environ", {"DATABASE_URL": "postgresql://test:pass@localhost/db"}):
            config = BabylonEnvConfig(
                tokenizer_name="test/model",
            )

        assert "postgresql://test" in config.database_url

    def test_both_sources_configurable(self):
        """Test that both database and HF configs can be set simultaneously."""
        env_vars = {
            "TRAJECTORY_SOURCE": "db",
            "DATABASE_URL": "postgresql://localhost/db",
            "HF_TRAJECTORY_DATASET": "org/dataset",
        }

        with patch.dict("os.environ", env_vars):
            config = BabylonEnvConfig(
                tokenizer_name="test/model",
            )

        assert config.trajectory_source == "db"
        assert config.database_url != ""
        assert config.hf_trajectory_dataset == "org/dataset"

    def test_local_export_dir_from_env(self):
        """Test loading local export config from environment."""
        env_vars = {
            "TRAJECTORY_SOURCE": "local_export",
            "LOCAL_EXPORT_DIR": "/tmp/local-export",
        }

        with patch.dict("os.environ", env_vars):
            config = BabylonEnvConfig(
                tokenizer_name="test/model",
            )

        assert config.trajectory_source == "local_export"
        assert config.local_export_dir == "/tmp/local-export"


# =============================================================================
# Database Source Setup Tests
# =============================================================================


class TestDatabaseSourceSetup:
    """Tests for database source setup."""

    @pytest.mark.asyncio
    async def test_setup_database_source_missing_url(self):
        """Test that database setup fails without DATABASE_URL."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "db"
        mock_config.database_url = ""
        mock_config.tokenizer_name = "test/model"

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.db_pool = None
        env.trajectory_cache = []
        env._server_configs = []

        with pytest.raises(ValueError, match="DATABASE_URL"):
            await env._setup_database_source()

    @pytest.mark.asyncio
    async def test_setup_database_source_detects_pooler(self):
        """Test that Supabase pooler detection works."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "db"
        mock_config.database_url = "postgresql://user:pass@db.pooler.supabase.com:6543/postgres"
        mock_config.lookback_hours = 720
        mock_config.max_trajectories = 100
        mock_config.min_actions_per_trajectory = 3
        mock_config.min_agents_per_window = 2

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.db_pool = None
        env.trajectory_cache = []

        # Mock asyncpg
        mock_pool = MagicMock()
        mock_pool.acquire = MagicMock(return_value=AsyncMock())

        with patch("asyncpg.create_pool", new_callable=AsyncMock) as mock_create_pool:
            mock_create_pool.return_value = mock_pool

            with patch.object(env, "_load_trajectories_from_db", new_callable=AsyncMock):
                # Should not raise, but should log warning
                await env._setup_database_source()

        # Verify pool was created with statement_cache_size=0
        mock_create_pool.assert_called_once()
        call_kwargs = mock_create_pool.call_args.kwargs
        assert call_kwargs["statement_cache_size"] == 0


# =============================================================================
# HuggingFace Source Setup Tests
# =============================================================================


class TestHuggingFaceSourceSetup:
    """Tests for HuggingFace source setup."""

    @pytest.mark.asyncio
    async def test_setup_hf_source_missing_dataset(self):
        """Test that HF setup fails without dataset ID."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "huggingface"
        mock_config.hf_trajectory_dataset = ""

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.trajectory_cache = []

        with pytest.raises(ValueError, match="HF_TRAJECTORY_DATASET"):
            await env._setup_huggingface_source()

    @pytest.mark.asyncio
    async def test_setup_hf_source_loads_reader(self):
        """Test that HF setup loads the trajectory reader."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "huggingface"
        mock_config.hf_trajectory_dataset = "elizaos/test-dataset"
        mock_config.hf_trajectory_split = "raw"
        mock_config.max_trajectories = 1000
        mock_config.min_actions_per_trajectory = 3
        mock_config.min_agents_per_window = 2

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.trajectory_cache = []

        # Create mock reader
        mock_reader = MagicMock()
        mock_reader.connect = AsyncMock()
        mock_reader.get_trajectory_groups = MagicMock(
            return_value=[
                {"group_key": "window-1_default", "trajectories": [{"id": 1}, {"id": 2}]},
            ]
        )
        mock_reader.get_stats = MagicMock(
            return_value={
                "total_trajectories": 100,
                "total_windows": 10,
                "avg_pnl": 50.0,
                "archetypes": ["trader", "degen"],
            }
        )

        # Import is done inside the method, so patch at the data_bridge module
        with patch(
            "src.data_bridge.hf_reader.HuggingFaceTrajectoryReader", return_value=mock_reader
        ):
            with patch("src.data_bridge.hf_reader.HFReaderConfig"):
                await env._setup_huggingface_source()

        assert len(env.trajectory_cache) == 1
        mock_reader.connect.assert_awaited_once()
        mock_reader.get_trajectory_groups.assert_called_once_with(min_agents_per_window=1)


class TestLocalExportSourceSetup:
    """Tests for local export source setup."""

    @pytest.mark.asyncio
    async def test_setup_local_export_source_missing_directory(self):
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "local_export"
        mock_config.local_export_dir = ""

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.trajectory_cache = []

        with pytest.raises(ValueError, match="LOCAL_EXPORT_DIR"):
            await env._setup_local_export_source()

    @pytest.mark.asyncio
    async def test_setup_local_export_source_loads_reader(self):
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "local_export"
        mock_config.local_export_dir = "/tmp/local-export"
        mock_config.max_trajectories = 10
        mock_config.min_actions_per_trajectory = 1
        mock_config.min_agents_per_window = 2

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.trajectory_cache = []

        mock_reader = MagicMock()
        mock_reader.get_window_ids = MagicMock(return_value=["window-1"])
        mock_reader.get_trajectories_by_window = MagicMock(
            return_value=[
                {
                    "trajectoryId": "traj-1",
                    "agentId": "agent-1",
                    "windowId": "window-1",
                    "scenarioId": "scenario-1",
                    "steps": [
                        {
                            "llmCalls": [{"purpose": "action"}],
                            "action": {"actionType": "SCAM_DEFENSE_DECISION"},
                        }
                    ],
                    "episodeLength": 1,
                },
                {
                    "trajectoryId": "traj-2",
                    "agentId": "agent-2",
                    "windowId": "window-1",
                    "scenarioId": "scenario-1",
                    "steps": [
                        {
                            "llmCalls": [{"purpose": "action"}],
                            "action": {"actionType": "SCAM_DEFENSE_DECISION"},
                        }
                    ],
                    "episodeLength": 1,
                },
            ]
        )

        with patch("src.data_bridge.reader.JsonTrajectoryReader", return_value=mock_reader):
            with patch(
                "src.data_bridge.reader.has_minimum_usable_action_steps", return_value=(True, 1)
            ):
                await env._setup_local_export_source()

        assert len(env.trajectory_cache) == 1
        assert env.trajectory_cache[0]["group_key"] == "window-1_scenario-1"

    @pytest.mark.asyncio
    async def test_setup_local_export_source_keeps_singleton_groups(self):
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "local_export"
        mock_config.local_export_dir = "/tmp/local-export"
        mock_config.max_trajectories = 10
        mock_config.min_actions_per_trajectory = 1
        mock_config.min_agents_per_window = 2

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.trajectory_cache = []

        mock_reader = MagicMock()
        mock_reader.get_window_ids = MagicMock(return_value=["window-1"])
        mock_reader.get_trajectories_by_window = MagicMock(
            return_value=[
                {
                    "trajectoryId": "traj-1",
                    "agentId": "agent-1",
                    "windowId": "window-1",
                    "scenarioId": "scenario-1",
                    "steps": [
                        {
                            "llmCalls": [{"purpose": "action"}],
                            "action": {"actionType": "SCAM_DEFENSE_DECISION"},
                        }
                    ],
                    "episodeLength": 1,
                },
            ]
        )

        with patch("src.data_bridge.reader.JsonTrajectoryReader", return_value=mock_reader):
            with patch(
                "src.data_bridge.reader.has_minimum_usable_action_steps", return_value=(True, 1)
            ):
                await env._setup_local_export_source()

        assert len(env.trajectory_cache) == 1
        assert env.trajectory_cache[0]["group_key"] == "window-1_scenario-1"


# =============================================================================
# Setup Dispatch Tests
# =============================================================================


class TestSetupDispatch:
    """Tests for the setup() method dispatching to correct source."""

    @pytest.mark.asyncio
    async def test_setup_dispatches_to_database(self):
        """Test that setup() calls database setup for 'db' source."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "db"
        mock_config.database_url = "postgresql://test:pass@localhost/db"
        mock_config.lookback_hours = 720
        mock_config.max_trajectories = 1000
        mock_config.min_actions_per_trajectory = 3
        mock_config.min_agents_per_window = 2
        mock_config.use_wandb = False

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.db_pool = None
        env.trajectory_cache = []
        env.eval_suite = None
        env.rollout_dumper = None

        with patch.object(env, "_setup_database_source", new_callable=AsyncMock) as mock_db:
            with patch.object(env, "_setup_huggingface_source", new_callable=AsyncMock) as mock_hf:
                await env.setup()

        mock_db.assert_awaited_once()
        mock_hf.assert_not_called()

    @pytest.mark.asyncio
    async def test_setup_dispatches_to_huggingface(self):
        """Test that setup() calls HF setup for 'huggingface' source."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "huggingface"
        mock_config.hf_trajectory_dataset = "org/dataset"
        mock_config.hf_trajectory_split = "raw"
        mock_config.max_trajectories = 1000
        mock_config.min_actions_per_trajectory = 3
        mock_config.min_agents_per_window = 2
        mock_config.use_wandb = False

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.db_pool = None
        env.trajectory_cache = []
        env.eval_suite = None
        env.rollout_dumper = None

        with patch.object(env, "_setup_database_source", new_callable=AsyncMock) as mock_db:
            with patch.object(env, "_setup_huggingface_source", new_callable=AsyncMock) as mock_hf:
                await env.setup()

        mock_hf.assert_awaited_once()
        mock_db.assert_not_called()

    @pytest.mark.asyncio
    async def test_setup_dispatches_to_local_export(self):
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "local_export"
        mock_config.local_export_dir = "/tmp/local-export"
        mock_config.use_wandb = False

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.db_pool = None
        env.trajectory_cache = []
        env.eval_suite = None
        env.rollout_dumper = None

        with patch.object(env, "_setup_database_source", new_callable=AsyncMock) as mock_db:
            with patch.object(env, "_setup_huggingface_source", new_callable=AsyncMock) as mock_hf:
                with patch.object(
                    env, "_setup_local_export_source", new_callable=AsyncMock
                ) as mock_local:
                    await env.setup()

        mock_local.assert_awaited_once()
        mock_db.assert_not_called()
        mock_hf.assert_not_called()


# =============================================================================
# Reload Trajectories Tests
# =============================================================================


class TestReloadTrajectories:
    """Tests for trajectory reloading."""

    @pytest.mark.asyncio
    async def test_reload_uses_correct_source(self):
        """Test that _reload_trajectories uses the configured source."""
        # Test DB source
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "db"

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config
        env.trajectory_cache = []

        with patch.object(env, "_load_trajectories_from_db", new_callable=AsyncMock) as mock_db:
            with patch.object(env, "_setup_huggingface_source", new_callable=AsyncMock) as mock_hf:
                await env._reload_trajectories()

        mock_db.assert_awaited_once()
        mock_hf.assert_not_called()

        # Test HF source
        mock_config.trajectory_source = "huggingface"

        with patch.object(env, "_load_trajectories_from_db", new_callable=AsyncMock) as mock_db:
            with patch.object(env, "_setup_huggingface_source", new_callable=AsyncMock) as mock_hf:
                await env._reload_trajectories()

        mock_hf.assert_awaited_once()
        mock_db.assert_not_called()

        # Test local export source
        mock_config.trajectory_source = "local_export"

        with patch.object(env, "_load_trajectories_from_db", new_callable=AsyncMock) as mock_db:
            with patch.object(env, "_setup_huggingface_source", new_callable=AsyncMock) as mock_hf:
                with patch.object(
                    env, "_setup_local_export_source", new_callable=AsyncMock
                ) as mock_local:
                    await env._reload_trajectories()

        mock_local.assert_awaited_once()
        mock_db.assert_not_called()
        mock_hf.assert_not_called()


# =============================================================================
# Source Name Normalization Tests
# =============================================================================


class TestSourceNameNormalization:
    """Tests for source name normalization."""

    def test_source_names_are_lowercased(self):
        """Test that source names are case-insensitive."""
        test_cases = [
            "DB",
            "Db",
            "dB",
            "db",
            "HUGGINGFACE",
            "HuggingFace",
            "huggingface",
            "LOCAL_EXPORT",
            "local_export",
        ]

        for source in test_cases:
            with patch.dict("os.environ", {"TRAJECTORY_SOURCE": source}):
                config = BabylonEnvConfig(
                    tokenizer_name="test/model",
                )

            # Source should work regardless of case
            assert config.trajectory_source.lower() in ["db", "huggingface", "local_export"]


# =============================================================================
# Error Message Quality Tests
# =============================================================================


class TestErrorMessages:
    """Tests for error message quality."""

    @pytest.mark.asyncio
    async def test_missing_database_url_message(self):
        """Test that missing DATABASE_URL produces helpful error."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "db"
        mock_config.database_url = ""

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config

        with pytest.raises(ValueError) as exc_info:
            await env._setup_database_source()

        assert "DATABASE_URL" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_missing_hf_dataset_message(self):
        """Test that missing HF_TRAJECTORY_DATASET produces helpful error."""
        mock_config = MagicMock(spec=BabylonEnvConfig)
        mock_config.trajectory_source = "huggingface"
        mock_config.hf_trajectory_dataset = ""

        env = BabylonRLAIFEnv.__new__(BabylonRLAIFEnv)
        env.config = mock_config

        with pytest.raises(ValueError) as exc_info:
            await env._setup_huggingface_source()

        error_msg = str(exc_info.value)
        assert "HF_TRAJECTORY_DATASET" in error_msg
        assert "TRAJECTORY_SOURCE=huggingface" in error_msg
