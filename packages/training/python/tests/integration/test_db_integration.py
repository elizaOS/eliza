"""
Database Integration Tests

Tests the complete database-based training data pipeline:
1. Trajectory insertion with archetype
2. Querying trajectories by archetype
3. Scoring database trajectories
4. GRPO group formation from database
5. End-to-end database pipeline

These tests REQUIRE a running PostgreSQL database.
Use docker compose -f docker-compose.test.yml up -d before running.
"""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List
from datetime import datetime
import uuid

import pytest

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.training.rewards import (
    archetype_composite_reward,
    BehaviorMetrics,
    TrajectoryRewardInputs,
)
from src.training.rubric_loader import (
    normalize_archetype,
    has_custom_rubric,
    get_available_archetypes,
)
from tests.integration.conftest import (
    TrajectoryFixture,
    skip_if_no_database,
    is_database_available,
)


# Skip all tests in this module if database is not available
pytestmark = skip_if_no_database()


def generate_test_id() -> str:
    """Generate a unique test ID to avoid conflicts."""
    return f"test-{uuid.uuid4().hex[:8]}"


class TestDatabaseTrajectoryOperations:
    """Test trajectory CRUD operations in database."""

    @pytest.fixture(autouse=True)
    def setup_db(self, database_url: str):
        """Setup database connection and cleanup."""
        import psycopg2
        self.conn = psycopg2.connect(database_url)
        self.test_prefix = f"test-{uuid.uuid4().hex[:8]}"
        yield
        # Cleanup test data
        cur = self.conn.cursor()
        cur.execute(
            'DELETE FROM trajectories WHERE "trajectoryId" LIKE %s',
            (f"{self.test_prefix}%",)
        )
        self.conn.commit()
        cur.close()
        self.conn.close()

    def _insert_trajectory(
        self,
        trajectory_id: str,
        agent_id: str,
        archetype: str,
        window_id: str,
        steps: List[Dict],
        final_pnl: float,
        episode_length: int,
    ):
        """Insert a test trajectory into the database."""
        cur = self.conn.cursor()
        cur.execute(
            '''
            INSERT INTO trajectories (
                "id", "trajectoryId", "agentId", "archetype", "windowId",
                "stepsJson", "rewardComponentsJson", "metricsJson", "metadataJson",
                "finalPnL", "episodeLength", "totalReward",
                "finalStatus", "isTrainingData", "startTime", "endTime",
                "durationMs", "createdAt", "updatedAt"
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            ''',
            (
                trajectory_id,
                trajectory_id,
                agent_id,
                archetype,
                window_id,
                json.dumps(steps),
                "{}",  # rewardComponentsJson
                "{}",  # metricsJson
                "{}",  # metadataJson
                final_pnl,
                episode_length,
                0.5,
                "completed",
                True,
                datetime.now(),
                datetime.now(),
                5000,
                datetime.now(),
                datetime.now(),
            )
        )
        self.conn.commit()
        cur.close()

    def test_insert_trajectory_with_archetype(
        self,
        sample_trader_trajectory: TrajectoryFixture,
    ):
        """Test inserting a trajectory with archetype."""
        traj_id = f"{self.test_prefix}-trader-001"
        
        self._insert_trajectory(
            trajectory_id=traj_id,
            agent_id="test-agent",
            archetype="trader",
            window_id=f"{self.test_prefix}-window-1",
            steps=sample_trader_trajectory.steps,
            final_pnl=sample_trader_trajectory.final_pnl,
            episode_length=sample_trader_trajectory.episode_length,
        )

        # Verify insertion
        cur = self.conn.cursor()
        cur.execute(
            'SELECT "archetype" FROM trajectories WHERE "trajectoryId" = %s',
            (traj_id,)
        )
        row = cur.fetchone()
        cur.close()

        assert row is not None
        assert row[0] == "trader"

    def test_query_trajectories_by_archetype(self):
        """Test querying trajectories filtered by archetype."""
        window_id = f"{self.test_prefix}-window-multi"
        
        # Insert multiple archetypes
        for i, archetype in enumerate(["trader", "degen", "scammer"]):
            self._insert_trajectory(
                trajectory_id=f"{self.test_prefix}-{archetype}-{i}",
                agent_id=f"agent-{archetype}",
                archetype=archetype,
                window_id=window_id,
                steps=[],
                final_pnl=100.0 * (i + 1),
                episode_length=3,
            )

        # Query traders only
        cur = self.conn.cursor()
        cur.execute(
            '''
            SELECT "trajectoryId", "archetype" FROM trajectories 
            WHERE "windowId" = %s AND "archetype" = %s
            ''',
            (window_id, "trader")
        )
        rows = cur.fetchall()
        cur.close()

        assert len(rows) == 1
        assert rows[0][1] == "trader"

    def test_query_trajectories_by_window_with_archetypes(self):
        """Test querying all trajectories in window with their archetypes."""
        window_id = f"{self.test_prefix}-window-group"
        archetypes = ["trader", "degen", "scammer", "social-butterfly"]
        
        # Insert multiple archetypes
        for i, archetype in enumerate(archetypes):
            self._insert_trajectory(
                trajectory_id=f"{self.test_prefix}-group-{i}",
                agent_id=f"agent-{archetype}",
                archetype=archetype,
                window_id=window_id,
                steps=[],
                final_pnl=100.0 * (i + 1),
                episode_length=3,
            )

        # Query all in window
        cur = self.conn.cursor()
        cur.execute(
            '''
            SELECT "trajectoryId", "archetype", "finalPnL" FROM trajectories 
            WHERE "windowId" = %s AND "isTrainingData" = true
            ORDER BY "archetype"
            ''',
            (window_id,)
        )
        rows = cur.fetchall()
        cur.close()

        assert len(rows) == 4
        db_archetypes = {row[1] for row in rows}
        assert db_archetypes == set(archetypes)

    def test_null_archetype_defaults_to_default(self):
        """Test that NULL archetype is handled correctly."""
        traj_id = f"{self.test_prefix}-null-arch"
        
        # Insert with NULL archetype
        cur = self.conn.cursor()
        cur.execute(
            '''
            INSERT INTO trajectories (
                "id", "trajectoryId", "agentId", "archetype", "windowId",
                "stepsJson", "rewardComponentsJson", "metricsJson", "metadataJson",
                "finalPnL", "episodeLength", "totalReward",
                "finalStatus", "isTrainingData", "startTime", "endTime",
                "durationMs", "createdAt", "updatedAt"
            ) VALUES (
                %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            ''',
            (
                traj_id, traj_id, "test-agent", f"{self.test_prefix}-window-null",
                "[]", "{}", "{}", "{}", 100.0, 3, 0.5, "completed", True,
                datetime.now(), datetime.now(), 5000, datetime.now(), datetime.now(),
            )
        )
        self.conn.commit()
        cur.close()

        # Query and normalize
        cur = self.conn.cursor()
        cur.execute(
            'SELECT "archetype" FROM trajectories WHERE "trajectoryId" = %s',
            (traj_id,)
        )
        row = cur.fetchone()
        cur.close()

        archetype = row[0]
        normalized = normalize_archetype(archetype)
        assert normalized == "default"

    def test_archetype_case_normalization_in_scoring(self):
        """Test that archetype case variations are normalized correctly."""
        test_cases = [
            ("TRADER", "trader"),
            ("Social_Butterfly", "social-butterfly"),
            ("goody_twoshoes", "goody-twoshoes"),
        ]
        
        for db_value, expected_normalized in test_cases:
            normalized = normalize_archetype(db_value)
            assert normalized == expected_normalized
            assert has_custom_rubric(normalized)


class TestDatabaseScoring:
    """Test scoring trajectories from database."""

    @pytest.fixture(autouse=True)
    def setup_db(self, database_url: str):
        """Setup database connection and cleanup."""
        import psycopg2
        self.conn = psycopg2.connect(database_url)
        self.test_prefix = f"test-{uuid.uuid4().hex[:8]}"
        yield
        cur = self.conn.cursor()
        cur.execute(
            'DELETE FROM trajectories WHERE "trajectoryId" LIKE %s',
            (f"{self.test_prefix}%",)
        )
        self.conn.commit()
        cur.close()
        self.conn.close()

    def _insert_and_fetch_trajectory(
        self,
        archetype: str,
        final_pnl: float,
        steps: List[Dict],
    ) -> Dict:
        """Insert trajectory and return fetched data."""
        traj_id = f"{self.test_prefix}-{archetype}-{uuid.uuid4().hex[:4]}"
        window_id = f"{self.test_prefix}-scoring-window"
        
        cur = self.conn.cursor()
        cur.execute(
            '''
            INSERT INTO trajectories (
                "id", "trajectoryId", "agentId", "archetype", "windowId",
                "stepsJson", "rewardComponentsJson", "metricsJson", "metadataJson",
                "finalPnL", "episodeLength", "totalReward",
                "finalStatus", "isTrainingData", "startTime", "endTime",
                "durationMs", "createdAt", "updatedAt"
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            RETURNING "trajectoryId", "archetype", "stepsJson", "finalPnL", "episodeLength"
            ''',
            (
                traj_id, traj_id, f"agent-{archetype}", archetype, window_id,
                json.dumps(steps), "{}", "{}", "{}", final_pnl, len(steps), 0.5, "completed", True,
                datetime.now(), datetime.now(), 5000, datetime.now(), datetime.now(),
            )
        )
        row = cur.fetchone()
        self.conn.commit()
        cur.close()
        
        return {
            "trajectory_id": row[0],
            "archetype": row[1],
            "steps": json.loads(row[2]),
            "final_pnl": float(row[3]),
            "episode_length": row[4],
        }

    def test_score_trader_from_database(
        self,
        sample_trader_trajectory: TrajectoryFixture,
    ):
        """Test scoring a trader trajectory from database."""
        traj_data = self._insert_and_fetch_trajectory(
            archetype="trader",
            final_pnl=150.0,
            steps=sample_trader_trajectory.steps,
        )

        behavior = BehaviorMetrics(
            trades_executed=3,
            total_pnl=traj_data["final_pnl"],
            episode_length=traj_data["episode_length"],
        )

        inputs = TrajectoryRewardInputs(
            final_pnl=traj_data["final_pnl"],
            starting_balance=10000.0,
            end_balance=10000.0 + traj_data["final_pnl"],
            format_score=0.8,
            reasoning_score=0.75,
        )

        score = archetype_composite_reward(
            inputs, 
            normalize_archetype(traj_data["archetype"]), 
            behavior
        )
        
        assert 0.0 <= score <= 1.0
        assert score > 0.3  # Profitable trader should score reasonably

    def test_score_multiple_archetypes_from_database(self):
        """Test scoring multiple archetype trajectories from database."""
        archetypes_pnl = [
            ("trader", 200.0),
            ("degen", -500.0),
            ("scammer", 300.0),
            ("social-butterfly", 20.0),
        ]
        
        scores = {}
        for archetype, pnl in archetypes_pnl:
            traj_data = self._insert_and_fetch_trajectory(
                archetype=archetype,
                final_pnl=pnl,
                steps=[],
            )
            
            behavior = BehaviorMetrics(
                trades_executed=5,
                total_pnl=pnl,
                episode_length=5,
            )
            
            inputs = TrajectoryRewardInputs(
                final_pnl=pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + pnl,
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(
                inputs,
                normalize_archetype(archetype),
                behavior
            )
            scores[archetype] = score

        # All scores should be valid
        for archetype, score in scores.items():
            assert 0.0 <= score <= 1.0, f"{archetype} has invalid score: {score}"

    def test_grpo_group_formation_from_database(self):
        """Test forming GRPO groups from database trajectories."""
        window_id = f"{self.test_prefix}-grpo-window"
        archetypes = ["trader", "degen", "scammer"]
        
        # Insert multiple trajectories to same window
        for i, archetype in enumerate(archetypes):
            cur = self.conn.cursor()
            traj_id = f"{self.test_prefix}-grpo-{i}"
            cur.execute(
                '''
                INSERT INTO trajectories (
                    "id", "trajectoryId", "agentId", "archetype", "windowId",
                    "stepsJson", "rewardComponentsJson", "metricsJson", "metadataJson",
                    "finalPnL", "episodeLength", "totalReward",
                    "finalStatus", "isTrainingData", "startTime", "endTime",
                    "durationMs", "createdAt", "updatedAt"
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ''',
                (
                    traj_id, traj_id, f"agent-{i}", archetype, window_id,
                    "[]", "{}", "{}", "{}", 100.0 * (i + 1), 3, 0.5, "completed", True,
                    datetime.now(), datetime.now(), 5000, datetime.now(), datetime.now(),
                )
            )
            self.conn.commit()
            cur.close()

        # Query group
        cur = self.conn.cursor()
        cur.execute(
            '''
            SELECT "trajectoryId", "archetype", "finalPnL", "stepsJson", "episodeLength"
            FROM trajectories
            WHERE "windowId" = %s AND "isTrainingData" = true
            ''',
            (window_id,)
        )
        rows = cur.fetchall()
        cur.close()

        assert len(rows) >= 2  # GRPO requires at least 2

        # Score all trajectories
        scores = []
        for row in rows:
            archetype = normalize_archetype(row[1])
            pnl = float(row[2])
            
            behavior = BehaviorMetrics(trades_executed=3, total_pnl=pnl)
            inputs = TrajectoryRewardInputs(
                final_pnl=pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + pnl,
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, archetype, behavior)
            scores.append(score)

        # Center for GRPO
        mean_score = sum(scores) / len(scores)
        centered = [s - mean_score for s in scores]
        centered_mean = sum(centered) / len(centered)
        
        assert abs(centered_mean) < 0.01


class TestEndToEndDatabasePipeline:
    """Test complete database pipeline end-to-end."""

    @pytest.fixture(autouse=True)
    def setup_db(self, database_url: str):
        """Setup database connection and cleanup."""
        import psycopg2
        self.conn = psycopg2.connect(database_url)
        self.test_prefix = f"test-{uuid.uuid4().hex[:8]}"
        yield
        cur = self.conn.cursor()
        cur.execute(
            'DELETE FROM trajectories WHERE "trajectoryId" LIKE %s',
            (f"{self.test_prefix}%",)
        )
        self.conn.commit()
        cur.close()
        self.conn.close()

    def test_full_database_pipeline(
        self,
        trajectory_group: List[TrajectoryFixture],
    ):
        """Test full pipeline: insert → query → score → center."""
        window_id = f"{self.test_prefix}-full-pipeline"
        
        # Step 1: Insert trajectories
        cur = self.conn.cursor()
        for traj in trajectory_group:
            traj_id = f"{self.test_prefix}-{traj.archetype}"
            cur.execute(
                '''
                INSERT INTO trajectories (
                    "id", "trajectoryId", "agentId", "archetype", "windowId",
                    "stepsJson", "rewardComponentsJson", "metricsJson", "metadataJson",
                    "finalPnL", "episodeLength", "totalReward",
                    "finalStatus", "isTrainingData", "startTime", "endTime",
                    "durationMs", "createdAt", "updatedAt"
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ''',
                (
                    traj_id, traj_id, traj.agent_id, traj.archetype, window_id,
                    json.dumps(traj.steps), "{}", "{}", "{}", traj.final_pnl, traj.episode_length,
                    traj.total_reward, "completed", True,
                    datetime.now(), datetime.now(), 5000, datetime.now(), datetime.now(),
                )
            )
        self.conn.commit()
        cur.close()

        # Step 2: Query trajectories
        cur = self.conn.cursor()
        cur.execute(
            '''
            SELECT "trajectoryId", "archetype", "stepsJson", "finalPnL", "episodeLength"
            FROM trajectories
            WHERE "windowId" = %s AND "isTrainingData" = true
            ''',
            (window_id,)
        )
        rows = cur.fetchall()
        cur.close()

        assert len(rows) == 3

        # Step 3: Score each trajectory
        scored_trajectories = []
        for row in rows:
            traj_id, archetype, steps_json, pnl, episode_length = row
            archetype_norm = normalize_archetype(archetype)
            steps = json.loads(steps_json)
            
            behavior = BehaviorMetrics(
                trades_executed=len([s for s in steps if s.get("action", {}).get("actionType") != "hold"]),
                total_pnl=float(pnl),
                episode_length=episode_length,
            )
            
            inputs = TrajectoryRewardInputs(
                final_pnl=float(pnl),
                starting_balance=10000.0,
                end_balance=10000.0 + float(pnl),
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, archetype_norm, behavior)
            scored_trajectories.append({
                "trajectory_id": traj_id,
                "archetype": archetype_norm,
                "pnl": float(pnl),
                "score": score,
            })

        # Step 4: Center scores for GRPO
        mean_score = sum(t["score"] for t in scored_trajectories) / len(scored_trajectories)
        for t in scored_trajectories:
            t["centered_score"] = t["score"] - mean_score

        # Verify results
        centered_mean = sum(t["centered_score"] for t in scored_trajectories) / len(scored_trajectories)
        assert abs(centered_mean) < 0.01

        # Verify trader scores higher than degen (positive PnL vs negative)
        trader = next(t for t in scored_trajectories if t["archetype"] == "trader")
        degen = next(t for t in scored_trajectories if t["archetype"] == "degen")
        assert trader["score"] > degen["score"]

    def test_pipeline_with_all_archetypes(self):
        """Test pipeline handles all valid archetypes."""
        window_id = f"{self.test_prefix}-all-archetypes"
        archetypes = get_available_archetypes()
        
        # Insert one trajectory per archetype
        cur = self.conn.cursor()
        for i, archetype in enumerate(archetypes):
            traj_id = f"{self.test_prefix}-all-{i}"
            cur.execute(
                '''
                INSERT INTO trajectories (
                    "id", "trajectoryId", "agentId", "archetype", "windowId",
                    "stepsJson", "rewardComponentsJson", "metricsJson", "metadataJson",
                    "finalPnL", "episodeLength", "totalReward",
                    "finalStatus", "isTrainingData", "startTime", "endTime",
                    "durationMs", "createdAt", "updatedAt"
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ''',
                (
                    traj_id, traj_id, f"agent-{archetype}", archetype, window_id,
                    "[]", "{}", "{}", "{}", 100.0 + i * 10, 3, 0.5, "completed", True,
                    datetime.now(), datetime.now(), 5000, datetime.now(), datetime.now(),
                )
            )
        self.conn.commit()
        cur.close()

        # Query and score all
        cur = self.conn.cursor()
        cur.execute(
            '''
            SELECT "archetype", "finalPnL" FROM trajectories
            WHERE "windowId" = %s
            ''',
            (window_id,)
        )
        rows = cur.fetchall()
        cur.close()

        assert len(rows) == len(archetypes)

        # Score each
        for archetype, pnl in rows:
            normalized = normalize_archetype(archetype)
            assert has_custom_rubric(normalized), f"{archetype} should have rubric"
            
            behavior = BehaviorMetrics(trades_executed=3, total_pnl=float(pnl))
            inputs = TrajectoryRewardInputs(
                final_pnl=float(pnl),
                starting_balance=10000.0,
                end_balance=10000.0 + float(pnl),
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, normalized, behavior)
            assert 0.0 <= score <= 1.0

