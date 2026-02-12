"""
Integration Test Configuration and Fixtures

Provides shared fixtures for both JSON-mode and DB-mode integration tests.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Generator
from datetime import datetime
from dataclasses import dataclass, field

import pytest

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.training.rewards import BehaviorMetrics, TrajectoryRewardInputs
from src.training.rubric_loader import get_available_archetypes


# =============================================================================
# TEST ENVIRONMENT DETECTION
# =============================================================================


def is_database_available() -> bool:
    """Check if database is available for testing."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return False
    
    try:
        import psycopg2
        conn = psycopg2.connect(database_url)
        conn.close()
        return True
    except Exception:
        return False


def skip_if_no_database():
    """Pytest marker to skip tests requiring database."""
    return pytest.mark.skipif(
        not is_database_available(),
        reason="Database not available (set DATABASE_URL or run docker compose)"
    )


# =============================================================================
# TRAJECTORY FIXTURES
# =============================================================================


@dataclass
class TrajectoryFixture:
    """A complete trajectory fixture for testing."""
    trajectory_id: str
    agent_id: str
    archetype: str
    window_id: str
    steps: List[Dict]
    final_pnl: float
    episode_length: int
    total_reward: float
    metadata: Dict = field(default_factory=dict)
    
    def to_dict(self) -> Dict:
        """Convert to dictionary format matching BabylonTrajectory."""
        return {
            "trajectoryId": self.trajectory_id,
            "trajectory_id": self.trajectory_id,
            "agentId": self.agent_id,
            "agent_id": self.agent_id,
            "archetype": self.archetype,
            "windowId": self.window_id,
            "window_id": self.window_id,
            "stepsJson": json.dumps(self.steps),
            "steps": self.steps,
            "finalPnL": self.final_pnl,
            "final_pnl": self.final_pnl,
            "episodeLength": self.episode_length,
            "episode_length": self.episode_length,
            "totalReward": self.total_reward,
            "total_reward": self.total_reward,
            "metricsJson": json.dumps({
                "episodeLength": self.episode_length,
                "finalStatus": "completed",
            }),
            "metadataJson": json.dumps(self.metadata),
            "id": self.trajectory_id,
        }
    
    def to_json_file_format(self) -> Dict:
        """Convert to JSON file format (as written by TrajectoryRecorder)."""
        return {
            "trajectory": {
                "trajectoryId": self.trajectory_id,
                "agentId": self.agent_id,
                "archetype": self.archetype,
                "windowId": self.window_id,
                "stepsJson": json.dumps(self.steps),
                "finalPnL": self.final_pnl,
                "episodeLength": self.episode_length,
                "totalReward": self.total_reward,
                "finalStatus": "completed",
                "startTime": datetime.now().isoformat(),
                "endTime": datetime.now().isoformat(),
                "durationMs": 5000,
                "scenarioId": f"scenario-{self.window_id}",
                "isTrainingData": True,
                "isEvaluation": False,
            },
            "llmCalls": self._build_llm_calls()
        }
    
    def _build_llm_calls(self) -> List[Dict]:
        """Extract LLM calls from steps."""
        calls = []
        for i, step in enumerate(self.steps):
            for call in step.get("llmCalls", []):
                calls.append({
                    "stepNumber": i,
                    "callIndex": 0,
                    **call
                })
        return calls


def create_trading_step(
    step_number: int,
    action_type: str = "buy_prediction",
    archetype: str = "trader",
    amount: float = 100.0,
    confidence: float = 0.8,
    reasoning: str = "Market analysis suggests bullish momentum",
    balance: float = 10000.0,
    pnl: float = 0.0,
) -> Dict:
    """Create a realistic trading step for testing."""
    return {
        "stepNumber": step_number,
        "environmentState": {
            "agentBalance": balance,
            "agentPoints": 0,
            "agentPnL": pnl,
            "openPositions": 1 if action_type != "hold" else 0,
            "timestamp": int(datetime.now().timestamp() * 1000),
        },
        "llmCalls": [
            {
                "model": "market-decision-model",
                "purpose": "action",
                "actionType": action_type,
                "systemPrompt": f"You are a {archetype} agent making trading decisions.",
                "userPrompt": f"Analyze market conditions. Balance: ${balance:.2f}, P&L: ${pnl:.2f}",
                "response": f"<action type=\"{action_type}\" amount=\"{amount}\" confidence=\"{confidence}\"/>",
                "reasoning": reasoning,
                "temperature": 0.5,
                "maxTokens": 1000,
                "latencyMs": 150,
            }
        ],
        "action": {
            "actionType": action_type,
            "parameters": {
                "npcId": "test-npc",
                "npcName": "Test NPC",
                "archetype": archetype,
                "amount": amount,
                "confidence": confidence,
                "reasoning": reasoning,
            },
            "success": True,
            "result": {
                "action": action_type,
                "amount": amount,
                "archetype": archetype,
            }
        },
        "reward": 0.0,
    }


# =============================================================================
# PYTEST FIXTURES
# =============================================================================


@pytest.fixture
def temp_trajectory_dir() -> Generator[Path, None, None]:
    """Create a temporary directory for trajectory JSON files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        traj_dir = Path(tmpdir) / "trajectories"
        traj_dir.mkdir(parents=True)
        yield traj_dir


@pytest.fixture
def sample_trader_trajectory() -> TrajectoryFixture:
    """Create a sample trader archetype trajectory."""
    steps = [
        create_trading_step(0, "buy_prediction", "trader", 100, 0.8, "Technical analysis shows support at $50"),
        create_trading_step(1, "hold", "trader", 0, 0.6, "Waiting for confirmation"),
        create_trading_step(2, "sell_prediction", "trader", 100, 0.85, "Target reached, taking profits"),
    ]
    return TrajectoryFixture(
        trajectory_id="traj-trader-001",
        agent_id="agent-trader",
        archetype="trader",
        window_id="window-test-1",
        steps=steps,
        final_pnl=150.0,
        episode_length=3,
        total_reward=0.5,
    )


@pytest.fixture
def sample_degen_trajectory() -> TrajectoryFixture:
    """Create a sample degen archetype trajectory."""
    steps = [
        create_trading_step(0, "open_long", "degen", 500, 0.95, "YOLO max leverage", 10000, 0),
        create_trading_step(1, "open_long", "degen", 500, 0.9, "Doubling down", 9800, -200),
        create_trading_step(2, "open_long", "degen", 500, 0.88, "One more", 9500, -500),
        create_trading_step(3, "close_perp", "degen", 1500, 0.7, "Taking loss", 8000, -2000),
    ]
    return TrajectoryFixture(
        trajectory_id="traj-degen-001",
        agent_id="agent-degen",
        archetype="degen",
        window_id="window-test-1",
        steps=steps,
        final_pnl=-2000.0,
        episode_length=4,
        total_reward=0.2,  # Low PnL but high activity = moderate score for degen
    )


@pytest.fixture
def sample_scammer_trajectory() -> TrajectoryFixture:
    """Create a sample scammer archetype trajectory."""
    steps = [
        create_trading_step(0, "post", "scammer", 0, 0.9, "Spreading FUD about competitor"),
        create_trading_step(1, "open_short", "scammer", 300, 0.85, "Shorting after FUD"),
        create_trading_step(2, "close_perp", "scammer", 300, 0.8, "Taking profits from manipulation"),
    ]
    return TrajectoryFixture(
        trajectory_id="traj-scammer-001",
        agent_id="agent-scammer",
        archetype="scammer",
        window_id="window-test-1",
        steps=steps,
        final_pnl=500.0,
        episode_length=3,
        total_reward=0.7,
    )


@pytest.fixture
def sample_social_butterfly_trajectory() -> TrajectoryFixture:
    """Create a sample social-butterfly archetype trajectory."""
    steps = [
        create_trading_step(0, "post", "social-butterfly", 0, 0.7, "Starting market discussion"),
        create_trading_step(1, "reply", "social-butterfly", 0, 0.8, "Engaging with community"),
        create_trading_step(2, "dm", "social-butterfly", 0, 0.75, "Networking with insider"),
        create_trading_step(3, "buy_prediction", "social-butterfly", 50, 0.6, "Small position based on intel"),
    ]
    return TrajectoryFixture(
        trajectory_id="traj-social-001",
        agent_id="agent-social",
        archetype="social-butterfly",
        window_id="window-test-1",
        steps=steps,
        final_pnl=20.0,
        episode_length=4,
        total_reward=0.6,  # Low PnL but high social activity = good score
    )


@pytest.fixture
def trajectory_group(
    sample_trader_trajectory: TrajectoryFixture,
    sample_degen_trajectory: TrajectoryFixture,
    sample_scammer_trajectory: TrajectoryFixture,
) -> List[TrajectoryFixture]:
    """Create a group of trajectories for comparative scoring."""
    return [
        sample_trader_trajectory,
        sample_degen_trajectory,
        sample_scammer_trajectory,
    ]


@pytest.fixture
def all_archetype_trajectories() -> Dict[str, TrajectoryFixture]:
    """Create one trajectory per valid archetype."""
    trajectories = {}
    archetypes = get_available_archetypes()
    
    for i, archetype in enumerate(archetypes):
        steps = [
            create_trading_step(0, "buy_prediction", archetype, 100, 0.8),
            create_trading_step(1, "hold", archetype, 0, 0.7),
            create_trading_step(2, "sell_prediction", archetype, 100, 0.75),
        ]
        trajectories[archetype] = TrajectoryFixture(
            trajectory_id=f"traj-{archetype}-001",
            agent_id=f"agent-{archetype}",
            archetype=archetype,
            window_id="window-all-archetypes",
            steps=steps,
            final_pnl=100.0 + (i * 10),  # Slight variation
            episode_length=3,
            total_reward=0.5,
        )
    
    return trajectories


@pytest.fixture
def sample_behavior_metrics() -> BehaviorMetrics:
    """Create sample behavior metrics for testing."""
    return BehaviorMetrics(
        trades_executed=5,
        posts_created=3,
        comments_made=10,
        dms_initiated=2,
        predictions_made=5,
        markets_traded=2,
        total_pnl=150.0,
        pnl_variance=50.0,
        win_rate=0.6,
        avg_position_size=100.0,
        largest_loss=-200.0,
        unique_users_interacted=15,
        episode_length=20,
    )


@pytest.fixture
def sample_reward_inputs() -> TrajectoryRewardInputs:
    """Create sample reward inputs for testing."""
    return TrajectoryRewardInputs(
        final_pnl=150.0,
        starting_balance=10000.0,
        end_balance=10150.0,
        format_score=0.8,
        reasoning_score=0.75,
        risky_actions_count=1,
        trades_executed=5,
        total_actions=15,
    )


# =============================================================================
# DATABASE FIXTURES (when available)
# =============================================================================


@pytest.fixture
def database_url() -> str:
    """Get database URL for testing."""
    return os.environ.get(
        "DATABASE_URL",
        "postgresql://babylon_test:test_password@localhost:5434/babylon_test"
    )


@pytest.fixture
def db_connection(database_url: str):
    """Create a database connection for testing."""
    if not is_database_available():
        pytest.skip("Database not available")
    
    import psycopg2
    conn = psycopg2.connect(database_url)
    yield conn
    conn.close()

