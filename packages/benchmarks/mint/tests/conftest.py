"""
Pytest configuration and fixtures for MINT benchmark tests.
"""

import sys
import json
from pathlib import Path

import pytest

# Add the benchmarks directory to the path
benchmarks_path = Path(__file__).parent.parent.parent
if str(benchmarks_path) not in sys.path:
    sys.path.insert(0, str(benchmarks_path))


@pytest.fixture
def sample_task():
    """Create a sample MINT task for testing."""
    from benchmarks.mint.types import MINTSubtask, MINTTask

    return MINTTask(
        id="gsm8k-test-001",
        subtask=MINTSubtask.GSM8K,
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

    traj = MINTTrajectory(task_id="gsm8k-test-001", start_time_ms=1000.0)
    traj.turns.append(
        Turn(
            turn_type=TurnType.ASSISTANT,
            content="The answer is 4",
            turn_number=1,
        )
    )
    traj.final_answer = "4"
    traj.success = True
    traj.per_turn_answers = ["4"]
    traj.per_turn_success = [True]
    traj.end_time_ms = 2000.0
    return traj


@pytest.fixture
def sample_config():
    """Create a sample configuration for testing."""
    from benchmarks.mint.types import MINTConfig

    return MINTConfig(
        output_dir="./test_results",
        max_tasks_per_subtask=2,
        max_turns=3,
        use_docker=False,
        enable_tools=True,
        enable_feedback=True,
        run_ablation=False,
        use_sample_tasks=True,
        feedback_mode="templated",
    )


@pytest.fixture
def official_format_data_path(tmp_path: Path) -> Path:
    """Tiny upstream-compatible processed/ tree for offline dataset tests."""
    rows = {
        "gsm8k": [
            {
                "id": 0,
                "prompt": "What is 2 + 2? Solution output format: an integer.",
                "reference": "4",
            }
        ],
        "humaneval": [
            {
                "id": 0,
                "prompt": "def add(a: int, b: int) -> int:\n",
                "reference": "def check(candidate):\n    assert candidate(1, 2) == 3\n",
            }
        ],
        "math": [
            {"id": 0, "prompt": "Compute 6 * 7.", "reference": "42.0"}
        ],
    }
    for subtask, entries in rows.items():
        path = tmp_path / subtask / "test_prompts.json"
        path.parent.mkdir(parents=True)
        path.write_text(
            "\n".join(json.dumps(row) for row in entries) + "\n",
            encoding="utf-8",
        )
    return tmp_path
