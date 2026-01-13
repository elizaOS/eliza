"""
Pytest configuration and shared fixtures for ART tests.
"""

import pytest
import tempfile
from pathlib import Path


@pytest.fixture
def temp_data_dir():
    """Create a temporary data directory for tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def sample_trajectory():
    """Create a sample trajectory for testing."""
    from elizaos_art.base import Trajectory

    return Trajectory(
        trajectory_id="test-traj-123",
        scenario_id="test-scenario",
        messages=[
            {"role": "system", "content": "You are a game-playing agent."},
            {"role": "user", "content": "What is your move?"},
            {"role": "assistant", "content": "I will move DOWN."},
        ],
        reward=1.5,
        metadata={"model": "test-model", "seed": 42},
        metrics={"steps": 1, "total_reward": 1.5},
    )


@pytest.fixture
def sample_trajectories(sample_trajectory):
    """Create multiple sample trajectories for testing."""
    from elizaos_art.base import Trajectory

    trajectories = [sample_trajectory]
    for i in range(5):
        trajectories.append(
            Trajectory(
                trajectory_id=f"test-traj-{i}",
                scenario_id=f"scenario-{i % 2}",
                messages=[
                    {"role": "system", "content": "You are a game-playing agent."},
                    {"role": "user", "content": f"Question {i}"},
                    {"role": "assistant", "content": f"Answer {i}"},
                ],
                reward=float(i),
                metadata={"model": "test-model", "seed": i},
                metrics={"steps": i + 1},
            )
        )
    return trajectories


@pytest.fixture
async def initialized_2048_env():
    """Create an initialized 2048 environment."""
    from elizaos_art.games.game_2048 import Game2048Environment

    env = Game2048Environment()
    await env.initialize()
    return env


@pytest.fixture
async def initialized_tictactoe_env():
    """Create an initialized Tic-Tac-Toe environment."""
    from elizaos_art.games.tic_tac_toe import TicTacToeEnvironment

    env = TicTacToeEnvironment()
    await env.initialize()
    return env


@pytest.fixture
async def initialized_codenames_env():
    """Create an initialized Codenames environment."""
    from elizaos_art.games.codenames import CodenamesEnvironment

    env = CodenamesEnvironment()
    await env.initialize()
    return env


@pytest.fixture
async def initialized_temporal_env():
    """Create an initialized Temporal Clue environment."""
    from elizaos_art.games.temporal_clue import TemporalClueEnvironment

    env = TemporalClueEnvironment()
    await env.initialize()
    return env


@pytest.fixture
def mock_eliza_storage(temp_data_dir):
    """Create a mock ElizaOS storage adapter."""
    from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter

    return ElizaStorageAdapter(data_dir=temp_data_dir)


@pytest.fixture
def mock_trajectory_logger(temp_data_dir):
    """Create a mock trajectory logger."""
    from elizaos_art.eliza_integration.trajectory_adapter import ElizaTrajectoryLogger

    return ElizaTrajectoryLogger(
        agent_id="test-agent",
        data_dir=temp_data_dir / "trajectories",
    )
