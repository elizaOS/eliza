"""
Integration tests for ElizaOS ART.

Tests the integration between:
- ART training pipeline
- ElizaOS trajectory logging
- Local AI model inference
- Local database storage
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
        logger.complete_step(
            trajectory_id=traj_id,
            step_id=step_id,
            action_type="TEST_ACTION",
            action_name="test_action",
            parameters={"value": 42},
            success=True,
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


class TestRuntimeIntegration:
    """Tests for ARTRuntime."""

    @pytest.mark.asyncio
    async def test_runtime_creation(self, temp_data_dir):
        """Test runtime creation and initialization."""
        from elizaos_art.eliza_integration.runtime_integration import (
            ARTRuntime,
            ARTRuntimeConfig,
        )
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment
        from elizaos_art.games.tic_tac_toe.agent import TicTacToeRandomAgent

        env = TicTacToeEnvironment()
        agent = TicTacToeRandomAgent()
        config = ARTRuntimeConfig(
            agent_id="test-runtime",
            use_mock_model=True,
            data_dir=str(temp_data_dir),
        )

        runtime = ARTRuntime(env=env, agent=agent, config=config)
        await runtime.initialize()

        assert runtime._initialized

    @pytest.mark.asyncio
    async def test_runtime_rollout(self, temp_data_dir):
        """Test single rollout execution."""
        from elizaos_art.eliza_integration.runtime_integration import (
            ARTRuntime,
            ARTRuntimeConfig,
        )
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment
        from elizaos_art.games.tic_tac_toe.agent import TicTacToeRandomAgent

        env = TicTacToeEnvironment()
        agent = TicTacToeRandomAgent()
        config = ARTRuntimeConfig(
            agent_id="test-rollout",
            use_mock_model=True,
            data_dir=str(temp_data_dir),
        )

        runtime = ARTRuntime(env=env, agent=agent, config=config)
        await runtime.initialize()

        trajectory = await runtime.rollout(
            scenario_id="test-scenario",
            seed=42,
        )

        assert trajectory.trajectory_id is not None
        assert trajectory.scenario_id == "test-scenario"
        assert len(trajectory.messages) > 0

    @pytest.mark.asyncio
    async def test_runtime_evaluation(self, temp_data_dir):
        """Test evaluation run."""
        from elizaos_art.eliza_integration.runtime_integration import (
            ARTRuntime,
            ARTRuntimeConfig,
        )
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment
        from elizaos_art.games.tic_tac_toe.agent import TicTacToeOptimalAgent

        env = TicTacToeEnvironment()
        agent = TicTacToeOptimalAgent()
        config = ARTRuntimeConfig(
            agent_id="test-eval",
            use_mock_model=True,
            data_dir=str(temp_data_dir),
        )

        runtime = ARTRuntime(env=env, agent=agent, config=config)
        await runtime.initialize()

        results = await runtime.evaluate(num_episodes=10)

        assert results["episodes"] == 10
        assert "avg_reward" in results
        assert "win_rate" in results


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
    async def test_tictactoe_environment(self):
        """Test Tic-Tac-Toe environment."""
        from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment
        from elizaos_art.games.tic_tac_toe.types import TicTacToeAction

        env = TicTacToeEnvironment()
        await env.initialize()

        state = await env.reset(seed=42)
        assert state.winner is None

        actions = env.get_available_actions(state)
        assert len(actions) > 0

        new_state, reward, done = await env.step(TicTacToeAction.POS_4)
        assert new_state is not None

    @pytest.mark.asyncio
    async def test_temporal_clue_environment(self):
        """Test Temporal Clue environment."""
        from elizaos_art.games.temporal_clue import TemporalClueEnvironment

        env = TemporalClueEnvironment()
        await env.initialize()

        state = await env.reset(seed=42)
        assert not state.solved

        actions = env.get_available_actions(state)
        assert len(actions) > 0


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
