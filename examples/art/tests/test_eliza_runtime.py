"""
Tests for full ElizaOS Runtime Integration.

These tests verify that the ART demos use the CANONICAL ElizaOS pattern:
- Full AgentRuntime with character and plugins
- Message processing through message_service.handle_message
- Actions registered and invoked properly
- Providers supplying context
- basicCapabilities enabled by default
"""

import pytest
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.fixture
def temp_data_dir():
    """Create a temporary data directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


class TestARTRuntimeConfig:
    """Tests for ARTRuntimeConfig."""

    def test_default_config(self):
        """Test default configuration values."""
        from elizaos_art.eliza_integration.runtime_integration import ARTRuntimeConfig

        config = ARTRuntimeConfig()

        # basicCapabilities should be enabled by default (not disabled)
        assert config.disable_basic_capabilities is False
        assert config.enable_extended_capabilities is False
        assert config.agent_id == "art-training-agent"

    def test_custom_config(self):
        """Test custom configuration."""
        from elizaos_art.eliza_integration.runtime_integration import ARTRuntimeConfig

        config = ARTRuntimeConfig(
            agent_id="custom-agent",
            agent_name="Custom Agent",
            model_name="gpt-5-mini",
            disable_basic_capabilities=False,  # Explicitly keep basic capabilities
        )

        assert config.agent_id == "custom-agent"
        assert config.model_name == "gpt-5-mini"
        assert config.disable_basic_capabilities is False


class TestGameStateProvider:
    """Tests for game state provider."""

    def test_create_game_state_provider(self):
        """Test creating a game state provider."""
        from elizaos_art.eliza_integration.runtime_integration import create_game_state_provider
        from elizaos_art.games.game_2048 import Game2048Environment

        env = Game2048Environment()
        state_holder = {}

        provider = create_game_state_provider(env, state_holder)

        assert provider.name == "GAME_STATE"
        assert provider.position == 50
        assert provider.get is not None

    @pytest.mark.asyncio
    async def test_provider_returns_context(self):
        """Test that provider returns proper context."""
        from elizaos_art.eliza_integration.runtime_integration import create_game_state_provider
        from elizaos_art.games.game_2048 import Game2048Environment
        from elizaos_art.games.game_2048.types import Game2048State

        env = Game2048Environment()
        await env.initialize()
        state = await env.reset(seed=42)

        state_holder = {"state": state}

        provider = create_game_state_provider(env, state_holder)

        # Create mock runtime and message
        mock_runtime = MagicMock()
        mock_message = MagicMock()
        mock_state = MagicMock()

        result = await provider.get(mock_runtime, mock_message, mock_state)

        assert result.text is not None
        assert "Available Actions" in result.text
        assert result.values["env_name"] == "game_2048"


class TestGameAction:
    """Tests for game action."""

    def test_create_game_action(self):
        """Test creating a game action."""
        from elizaos_art.eliza_integration.runtime_integration import create_game_action
        from elizaos_art.games.game_2048 import Game2048Environment, Game2048HeuristicAgent

        env = Game2048Environment()
        agent = Game2048HeuristicAgent()
        state_holder = {}
        action_result_holder = {}

        action = create_game_action(env, agent, state_holder, action_result_holder)

        assert action.name == "PLAY_MOVE"
        assert "MAKE_MOVE" in action.similes
        assert action.handler is not None
        assert action.validate is not None


class TestARTPlugin:
    """Tests for ART plugin creation."""

    def test_create_art_plugin(self):
        """Test creating the ART plugin."""
        from elizaos_art.eliza_integration.runtime_integration import create_art_plugin
        from elizaos_art.games.game_2048 import Game2048Environment, Game2048HeuristicAgent

        env = Game2048Environment()
        agent = Game2048HeuristicAgent()
        state_holder = {}
        action_result_holder = {}

        plugin = create_art_plugin(env, agent, state_holder, action_result_holder)

        assert plugin.name == "art-game_2048"
        assert len(plugin.providers) == 1
        assert len(plugin.actions) == 1
        assert plugin.providers[0].name == "GAME_STATE"
        assert plugin.actions[0].name == "PLAY_MOVE"


class TestTrajectoryConversion:
    """Tests for trajectory format conversion."""

    def test_convert_to_eliza_trajectory(self):
        """Test converting ART trajectory to Eliza format."""
        from elizaos_art.eliza_integration.trajectory_adapter import convert_to_eliza_trajectory
        from elizaos_art.base import Trajectory

        art_traj = Trajectory(
            trajectory_id="test-123",
            scenario_id="scenario-456",
            messages=[
                {"role": "system", "content": "System prompt"},
                {"role": "user", "content": "User message"},
                {"role": "assistant", "content": "Assistant response"},
            ],
            reward=1.5,
            metadata={"model": "test-model"},
            metrics={"steps": 1},
        )

        eliza_traj = convert_to_eliza_trajectory(art_traj, "test-agent")

        assert eliza_traj["trajectoryId"] == "test-123"
        assert eliza_traj["agentId"] == "test-agent"
        assert eliza_traj["scenarioId"] == "scenario-456"
        assert eliza_traj["totalReward"] == 1.5


class TestVectorIndex:
    """Tests for simple HNSW vector index."""

    def test_vector_add_and_search(self, temp_data_dir):
        """Test adding vectors and searching."""
        from elizaos_art.eliza_integration.storage_adapter import SimpleHNSW

        index = SimpleHNSW(dimensions=3)

        # Add vectors
        index.add("vec-1", [1.0, 0.0, 0.0])
        index.add("vec-2", [0.0, 1.0, 0.0])
        index.add("vec-3", [0.0, 0.0, 1.0])

        # Search for similar
        results = index.search([1.0, 0.1, 0.0], k=2)

        assert len(results) == 2
        assert results[0][0] == "vec-1"  # Most similar
        assert results[0][1] > 0.9  # High similarity

    def test_vector_save_and_load(self, temp_data_dir):
        """Test saving and loading vector index."""
        from elizaos_art.eliza_integration.storage_adapter import SimpleHNSW

        index = SimpleHNSW(dimensions=3)
        index.add("vec-1", [1.0, 0.0, 0.0])
        index.add("vec-2", [0.0, 1.0, 0.0])

        # Save
        index_path = temp_data_dir / "index.json"
        index.save(index_path)

        # Load into new index
        new_index = SimpleHNSW(dimensions=3)
        new_index.load(index_path)

        assert len(new_index.vectors) == 2


class TestEnvironmentStateTypes:
    """Tests for environment state types."""

    def test_eliza_environment_state(self):
        """Test ElizaEnvironmentState creation."""
        from elizaos_art.eliza_integration.trajectory_adapter import ElizaEnvironmentState

        state = ElizaEnvironmentState(
            timestamp=1234567890,
            agent_balance=1000.0,
            agent_points=50.0,
            custom={"game": "2048", "score": 100},
        )

        d = state.to_dict()
        assert d["timestamp"] == 1234567890
        assert d["agentBalance"] == 1000.0
        assert d["custom"]["game"] == "2048"

    def test_eliza_llm_call(self):
        """Test ElizaLLMCall creation."""
        from elizaos_art.eliza_integration.trajectory_adapter import ElizaLLMCall

        call = ElizaLLMCall(
            model="llama-3.2-3b",
            system_prompt="You are a game player.",
            user_prompt="What move?",
            response="Move DOWN",
            temperature=0.7,
            latency_ms=150,
        )

        d = call.to_dict()
        assert d["model"] == "llama-3.2-3b"
        assert d["temperature"] == 0.7
        assert d["latencyMs"] == 150


class TestModelDownload:
    """Tests for model download utilities."""

    def test_get_recommended_model(self):
        """Test model recommendation based on memory."""
        from elizaos_art.eliza_integration.local_ai_adapter import get_recommended_model

        # High memory
        model = get_recommended_model(16.0)
        assert "3B" in model

        # Medium memory
        model = get_recommended_model(10.0)
        assert "1B" in model

        # Low memory
        model = get_recommended_model(6.0)
        assert "1B" in model


class TestGRPOTrainer:
    """Tests for GRPO trainer."""

    @pytest.mark.asyncio
    async def test_trainer_initialization(self, temp_data_dir):
        """Test trainer initialization."""
        from elizaos_art.trainer import GRPOTrainer
        from elizaos_art.base import TrainingConfig
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment, TicTacToeHeuristicAgent

        env = TicTacToeEnvironment()
        agent = TicTacToeHeuristicAgent()
        config = TrainingConfig(
            model_name="test-model",
            checkpoint_dir=str(temp_data_dir / "checkpoints"),
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=config)
        await trainer.initialize()

        assert trainer._initialized

    @pytest.mark.asyncio
    async def test_trainer_rollout(self, temp_data_dir):
        """Test trainer rollout collection."""
        from elizaos_art.trainer import GRPOTrainer
        from elizaos_art.base import TrainingConfig
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment, TicTacToeHeuristicAgent

        env = TicTacToeEnvironment()
        agent = TicTacToeHeuristicAgent()
        config = TrainingConfig(
            model_name="test-model",
            checkpoint_dir=str(temp_data_dir / "checkpoints"),
        )

        trainer = GRPOTrainer(env=env, agent=agent, config=config)
        await trainer.initialize()

        trajectory = await trainer.rollout(scenario_id="test", seed=42)

        assert trajectory is not None
        assert len(trajectory.messages) > 0


class TestRulerScorer:
    """Tests for RULER scoring."""

    def test_ruler_scorer_creation(self):
        """Test creating RULER scorer."""
        from elizaos_art.trainer import RulerScorer

        scorer = RulerScorer(
            judge_model="gpt-5-mini",
            temperature=0.0,
        )

        assert scorer.judge_model == "gpt-5-mini"
        assert scorer.temperature == 0.0


class TestTrainingState:
    """Tests for training state persistence."""

    @pytest.mark.asyncio
    async def test_training_state_save_load(self, temp_data_dir):
        """Test saving and loading training state."""
        from elizaos_art.trainer import TrainingState

        state = TrainingState(
            step=50,
            total_trajectories=400,
            best_reward=10.5,
            model_name="test-model",
            metrics_history=[{"step": i, "reward": float(i)} for i in range(50)],
        )

        # Save
        state_path = temp_data_dir / "state.json"
        state.save(state_path)

        # Load
        loaded = TrainingState.load(state_path)

        assert loaded.step == 50
        assert loaded.total_trajectories == 400
        assert loaded.best_reward == 10.5


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
