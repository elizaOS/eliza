"""
Pytest configuration and fixtures for MINT benchmark tests.
"""

import sys
from pathlib import Path

import pytest

# Add the benchmarks directory to the path
benchmarks_path = Path(__file__).parent.parent.parent
if str(benchmarks_path) not in sys.path:
    sys.path.insert(0, str(benchmarks_path))

# Also add the packages/python directory for elizaos imports
packages_path = benchmarks_path.parent / "packages" / "python"
if str(packages_path) not in sys.path:
    sys.path.insert(0, str(packages_path))


@pytest.fixture
def sample_task():
    """Create a sample MINT task for testing."""
    from benchmarks.mint.types import MINTTask, MINTCategory
    
    return MINTTask(
        id="test-001",
        category=MINTCategory.REASONING,
        description="Simple arithmetic test",
        initial_prompt="What is 2 + 2?",
        ground_truth="4",
        max_turns=5,
        tools_allowed=["python"],
        evaluation_metric="numeric",
        difficulty="easy",
    )


@pytest.fixture
def sample_trajectory():
    """Create a sample trajectory for testing."""
    from benchmarks.mint.types import MINTTrajectory, Turn, TurnType
    
    trajectory = MINTTrajectory(
        task_id="test-001",
        start_time_ms=1000.0,
    )
    trajectory.turns.append(Turn(
        turn_type=TurnType.ASSISTANT,
        content="The answer is 4",
        turn_number=1,
    ))
    trajectory.final_answer = "4"
    trajectory.success = True
    trajectory.end_time_ms = 2000.0
    
    return trajectory


@pytest.fixture
def sample_config():
    """Create a sample configuration for testing."""
    from benchmarks.mint.types import MINTConfig
    
    return MINTConfig(
        data_path="./data/mint",
        output_dir="./test_results",
        max_tasks_per_category=2,
        max_turns=3,
        use_docker=False,
        enable_tools=True,
        enable_feedback=True,
        run_ablation=False,
    )
