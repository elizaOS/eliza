"""
Integration tests for ElizaOS ART.

Tests the integration between:
- ART training pipeline
- ElizaOS trajectory logging
- Local AI model inference
- Local database storage
- Full ElizaOS AgentRuntime
"""

import asyncio
import pytest
import tempfile
from pathlib import Path


@pytest.fixture
def temp_data_dir():
    """Create a temporary data directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


class TestTrajectoryAdapter:
    """Tests for ElizaTrajectoryLogger."""

    @pytest.mark.asyncio
    async def test_trajectory_lifecycle(self, temp_data_dir):
        """Test complete trajectory logging lifecycle."""
        from elizaos_art.eliza_integration.trajectory_adapter import (
            ElizaActionAttempt,
            ElizaEnvironmentState,
            ElizaLLMCall,
            ElizaTrajectoryLogger,
        )

        logger = ElizaTrajectoryLogger(
            agent_id="test-agent",
            data_dir=temp_data_dir / "trajectories",
        )

        # Start trajectory
        traj_id = logger.start_trajectory(
            scenario_id="test-scenario",
            metadata={"test": True},
        )
        assert traj_id is not None

        # Start step
        env_state = ElizaEnvironmentState(
            timestamp=1234567890,
            agent_balance=1000.0,
            custom={"score": 100},
        )
        step_id = logger.start_step(traj_id, env_state)
        assert step_id is not None

        # Log LLM call
        llm_call = ElizaLLMCall(
            model="test-model",
            system_prompt="You are a test agent.",
            user_prompt="What should I do?",
            response="I will do something.",
            latency_ms=100,
        )
        logger.log_llm_call(step_id, llm_call)

        # Complete step
        action = ElizaActionAttempt(
            action_type="TEST_ACTION",
            action_name="test_action",
            parameters={"value": 42},
            success=True,
        )
        logger.complete_step(
            trajectory_id=traj_id,
            step_id=step_id,
            action=action,
            reward=1.0,
        )

        # End trajectory
        result = logger.end_trajectory(
            traj_id,
            status="completed",
            final_metrics={"final_score": 200},
        )

        # Verify result
        assert result["trajectoryId"] == traj_id
        assert result["scenarioId"] == "test-scenario"
        assert result["totalReward"] == 1.0
        assert len(result["steps"]) == 1
        assert len(result["steps"][0]["llmCalls"]) == 1

        # Verify file was saved
        traj_file = temp_data_dir / "trajectories" / f"{traj_id}.json"
        assert traj_file.exists()


class TestStorageAdapter:
    """Tests for ElizaStorageAdapter."""

    @pytest.mark.asyncio
    async def test_trajectory_storage(self, temp_data_dir):
        """Test trajectory storage and retrieval."""
        from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter

        storage = ElizaStorageAdapter(data_dir=temp_data_dir)

        # Save trajectory
        trajectory = {
            "trajectoryId": "test-123",
            "agentId": "agent-456",
            "scenarioId": "scenario-789",
            "totalReward": 10.0,
            "steps": [],
            "metrics": {},
        }
        await storage.save_trajectory(trajectory)

        # Retrieve trajectory
        retrieved = await storage.get_trajectory("test-123")
        assert retrieved is not None
        assert retrieved["trajectoryId"] == "test-123"
        assert retrieved["totalReward"] == 10.0

    @pytest.mark.asyncio
    async def test_trajectory_search_by_scenario(self, temp_data_dir):
        """Test searching trajectories by scenario."""
        from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter

        storage = ElizaStorageAdapter(data_dir=temp_data_dir)

        # Save multiple trajectories
        for i in range(5):
            await storage.save_trajectory({
                "trajectoryId": f"traj-{i}",
                "scenarioId": f"scenario-{i % 2}",
                "totalReward": float(i),
                "steps": [],
            })

        # Search by scenario
        scenario_0 = await storage.get_trajectories_by_scenario("scenario-0")
        assert len(scenario_0) == 3  # 0, 2, 4

        scenario_1 = await storage.get_trajectories_by_scenario("scenario-1")
        assert len(scenario_1) == 2  # 1, 3

    @pytest.mark.asyncio
    async def test_cache_operations(self, temp_data_dir):
        """Test cache operations."""
        from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter

        storage = ElizaStorageAdapter(data_dir=temp_data_dir)

        # Set and get
        await storage.set_cache("test-key", {"value": 42})
        result = await storage.get_cache("test-key")
        assert result == {"value": 42}

        # Delete
        await storage.delete_cache("test-key")
        result = await storage.get_cache("test-key")
        assert result is None

    @pytest.mark.asyncio
    async def test_checkpoint_operations(self, temp_data_dir):
        """Test checkpoint save and load."""
        from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter

        storage = ElizaStorageAdapter(data_dir=temp_data_dir)

        # Save checkpoint
        checkpoint_data = {
            "step": 100,
            "model_state": {"weights": [1.0, 2.0, 3.0]},
            "optimizer_state": {"lr": 0.001},
        }
        await storage.save_checkpoint("checkpoint-100", checkpoint_data)

        # Load checkpoint
        loaded = await storage.get_checkpoint("checkpoint-100")
        assert loaded is not None
        assert loaded["step"] == 100

        # List checkpoints
        checkpoints = await storage.list_checkpoints()
        assert "checkpoint-100" in checkpoints


class TestLocalAIAdapter:
    """Tests for ElizaLocalAIProvider."""

    @pytest.mark.asyncio
    async def test_mock_provider(self):
        """Test mock provider for testing without models."""
        from elizaos_art.eliza_integration.local_ai_adapter import MockLocalAIProvider

        provider = MockLocalAIProvider()

        # Generate text
        response = await provider.generate_text(
            prompt="Hello, world!",
            system_prompt="You are a test assistant.",
        )
        assert response is not None
        assert len(response) > 0

        # Generate embedding
        embedding = await provider.generate_embedding("test text")
        assert len(embedding) == 48  # SHA-384 / 8 bytes

    @pytest.mark.asyncio
    async def test_config_defaults(self):
        """Test configuration defaults."""
        from elizaos_art.eliza_integration.local_ai_adapter import LocalModelConfig

        config = LocalModelConfig()
        assert "Llama" in config.small_model or "gguf" in config.small_model.lower()
        assert config.context_length == 8192
        assert config.gpu_layers == 43


class TestGameEnvironments:
    """Tests for game environments."""

    @pytest.mark.asyncio
    async def test_2048_environment(self):
        """Test 2048 game environment."""
        from elizaos_art.games.game_2048 import Game2048Environment
        from elizaos_art.games.game_2048.types import Game2048Action

        env = Game2048Environment()
        await env.initialize()

        state = await env.reset(seed=42)
        assert not state.game_over
        assert state.score == 0

        actions = env.get_available_actions(state)
        assert len(actions) > 0

        new_state, reward, done = await env.step(Game2048Action.DOWN)
        assert new_state is not None

    @pytest.mark.asyncio
    async def test_2048_full_game(self):
        """Test playing a full 2048 game."""
        from elizaos_art.games.game_2048 import Game2048Environment, Game2048HeuristicAgent

        env = Game2048Environment()
        agent = Game2048HeuristicAgent()
        await env.initialize()

        state = await env.reset(seed=42)
        moves = 0

        while not state.game_over and moves < 1000:
            actions = env.get_available_actions(state)
            if not actions:
                break
            action = await agent.decide(state, actions)
            state, reward, done = await env.step(action)
            moves += 1

        assert moves > 0
        assert state.max_tile >= 4

    @pytest.mark.asyncio
    async def test_tictactoe_environment(self):
        """Test Tic-Tac-Toe environment."""
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment
        from elizaos_art.games.tic_tac_toe.types import TicTacToeAction

        env = TicTacToeEnvironment()
        await env.initialize()

        state = await env.reset(seed=42)
        assert state.winner is None
        assert not state.is_draw

        actions = env.get_available_actions(state)
        assert len(actions) > 0

        new_state, reward, done = await env.step(TicTacToeAction.POS_4)
        assert new_state is not None

    @pytest.mark.asyncio
    async def test_tictactoe_full_game(self):
        """Test playing a full Tic-Tac-Toe game."""
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment, TicTacToeHeuristicAgent

        env = TicTacToeEnvironment()
        agent = TicTacToeHeuristicAgent()
        await env.initialize()

        state = await env.reset(seed=42)

        while not state.is_terminal():
            actions = env.get_available_actions(state)
            if not actions:
                break
            action = await agent.decide(state, actions)
            state, reward, done = await env.step(action)

        assert state.is_terminal()

    @pytest.mark.asyncio
    async def test_codenames_environment(self):
        """Test Codenames environment."""
        from elizaos_art.games.codenames import CodenamesEnvironment
        from elizaos_art.games.codenames.types import CodenamesAction, CodenamesConfig, Role, CardColor

        config = CodenamesConfig(ai_role=Role.GUESSER, ai_team=CardColor.RED)
        env = CodenamesEnvironment(config)
        await env.initialize()

        state = await env.reset(seed=42)
        assert not state.game_over
        assert len(state.words) == 25

        actions = env.get_available_actions(state)
        assert len(actions) > 0

    @pytest.mark.asyncio
    async def test_temporal_clue_environment(self):
        """Test Temporal Clue environment."""
        from elizaos_art.games.temporal_clue import TemporalClueEnvironment
        from elizaos_art.games.temporal_clue.types import TemporalClueAction

        env = TemporalClueEnvironment()
        await env.initialize()

        state = await env.reset(seed=42)
        assert not state.submitted
        assert len(state.events) > 0

        actions = env.get_available_actions(state)
        assert len(actions) > 0

    @pytest.mark.asyncio
    async def test_temporal_clue_full_puzzle(self):
        """Test solving a full Temporal Clue puzzle."""
        from elizaos_art.games.temporal_clue import TemporalClueEnvironment, TemporalClueHeuristicAgent

        env = TemporalClueEnvironment()
        agent = TemporalClueHeuristicAgent()
        await env.initialize()

        state = await env.reset(seed=42)

        while not state.submitted:
            actions = env.get_available_actions(state)
            if not actions:
                break
            action = await agent.decide(state, actions)
            state, reward, done = await env.step(action)

        assert state.submitted


class TestAgents:
    """Tests for game agents."""

    @pytest.mark.asyncio
    async def test_2048_agent_parsing(self):
        """Test 2048 agent action parsing."""
        from elizaos_art.games.game_2048 import Game2048Agent
        from elizaos_art.games.game_2048.types import Game2048Action

        agent = Game2048Agent()

        # Test various response formats
        available = list(Game2048Action)

        action = agent.parse_action("DOWN", available)
        assert action == Game2048Action.DOWN

        action = agent.parse_action("I think I should move down.", available)
        assert action == Game2048Action.DOWN

        action = agent.parse_action("LEFT is the best move here.", available)
        assert action == Game2048Action.LEFT

    @pytest.mark.asyncio
    async def test_tictactoe_agent_parsing(self):
        """Test Tic-Tac-Toe agent action parsing."""
        from elizaos_art.games.tic_tac_toe import TicTacToeAgent
        from elizaos_art.games.tic_tac_toe.types import TicTacToeAction

        agent = TicTacToeAgent()

        available = [TicTacToeAction.POS_0, TicTacToeAction.POS_4, TicTacToeAction.POS_8]

        action = agent.parse_action("4", available)
        assert action == TicTacToeAction.POS_4

        action = agent.parse_action("I'll take position 4 in the center.", available)
        assert action == TicTacToeAction.POS_4


class TestExport:
    """Tests for export functionality."""

    @pytest.mark.asyncio
    async def test_export_for_art(self, temp_data_dir):
        """Test export to ART format."""
        from elizaos_art.eliza_integration.export import ExportOptions, export_for_art
        from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter

        storage = ElizaStorageAdapter(data_dir=temp_data_dir)

        # Add test trajectories
        for i in range(10):
            await storage.save_trajectory({
                "trajectoryId": f"traj-{i}",
                "agentId": "test-agent",
                "scenarioId": f"scenario-{i % 2}",
                "totalReward": float(i),
                "steps": [{
                    "stepId": f"step-{i}",
                    "llmCalls": [{
                        "systemPrompt": "You are a test agent.",
                        "userPrompt": f"Question {i}",
                        "response": f"Answer {i}",
                    }],
                }],
                "metrics": {},
            })

        # Export
        options = ExportOptions(
            output_dir=str(temp_data_dir / "exports"),
            train_ratio=0.8,
            validation_ratio=0.1,
            test_ratio=0.1,
        )
        result = await export_for_art(storage, options)

        assert result.total_trajectories == 10
        assert result.train_count == 8
        assert len(result.output_files) > 0

    @pytest.mark.asyncio
    async def test_export_jsonl(self, temp_data_dir):
        """Test JSONL export."""
        from elizaos_art.eliza_integration.export import export_trajectories_jsonl

        trajectories = [
            {"trajectoryId": f"traj-{i}", "reward": float(i)}
            for i in range(5)
        ]

        output_path = temp_data_dir / "export.jsonl"
        result = await export_trajectories_jsonl(trajectories, output_path)

        assert Path(result).exists()
        with open(result) as f:
            lines = f.readlines()
        assert len(lines) == 5


class TestBaseTypes:
    """Tests for base types and utilities."""

    def test_trajectory_creation(self):
        """Test Trajectory dataclass."""
        from elizaos_art.base import Trajectory

        traj = Trajectory(
            trajectory_id="test-123",
            scenario_id="scenario-456",
            messages=[
                {"role": "system", "content": "You are helpful."},
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there!"},
            ],
            reward=1.0,
            metadata={"model": "test"},
            metrics={"steps": 3},
        )

        assert traj.trajectory_id == "test-123"
        assert len(traj.messages) == 3
        assert traj.reward == 1.0

    def test_training_config(self):
        """Test TrainingConfig dataclass."""
        from elizaos_art.base import TrainingConfig

        config = TrainingConfig(
            model_name="meta-llama/Llama-3.2-3B-Instruct",
            max_steps=100,
            rollouts_per_group=8,
        )

        assert config.model_name == "meta-llama/Llama-3.2-3B-Instruct"
        assert config.max_steps == 100
        assert config.rollouts_per_group == 8


class TestBenchmarkRunner:
    """Tests for benchmark runner."""

    @pytest.mark.asyncio
    async def test_run_game_baseline(self):
        """Test running baseline for a single game."""
        from elizaos_art.benchmark_runner import run_game_baseline

        result = await run_game_baseline("tic_tac_toe", episodes=10)

        assert result.game == "tic_tac_toe"
        assert result.episodes == 10
        assert result.wins + result.losses + result.draws == 10

    @pytest.mark.asyncio
    async def test_benchmark_result_properties(self):
        """Test BenchmarkResult properties."""
        from elizaos_art.benchmark_runner import BenchmarkResult

        result = BenchmarkResult(
            game="test",
            agent_type="heuristic",
            episodes=100,
            wins=60,
            losses=30,
            draws=10,
            avg_reward=5.0,
            max_reward=10.0,
            min_reward=0.0,
            duration_seconds=1.5,
        )

        assert result.win_rate == 0.6
        assert result.to_dict()["win_rate"] == 0.6


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
