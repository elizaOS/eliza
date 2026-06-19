"""Tests for the unified trajectory database."""

from __future__ import annotations

import json
import os
import tempfile
import time

import pytest

from eliza_robot.trajectory_db.db import TrajectoryDB


@pytest.fixture
def db(tmp_path):
    """Create a fresh in-memory DB for each test."""
    db_path = str(tmp_path / "test.db")
    db = TrajectoryDB(db_path)
    db.initialize()
    yield db
    db.close()


def _make_trajectory(
    trajectory_id: str = "traj-001",
    agent_id: str = "agent-001",
    source: str = "hyperscape_planner",
    archetype: str = "trader",
    num_steps: int = 3,
) -> dict:
    """Create a minimal trajectory dict for testing."""
    steps = []
    for i in range(num_steps):
        steps.append({
            "stepId": f"{trajectory_id}-step-{i}",
            "stepNumber": i,
            "timestamp": time.time() + i,
            "environmentState": {"agentBalance": 100.0 + i},
            "observation": {"market": "bullish"},
            "llmCalls": [
                {
                    "callId": f"{trajectory_id}-call-{i}-0",
                    "timestamp": time.time() + i,
                    "model": "gpt-4",
                    "systemPrompt": "You are a trading agent with deep expertise.",
                    "userPrompt": "Analyze the current market conditions and decide on an action.",
                    "response": "I will buy 10 shares of AAPL based on bullish signals.",
                    "temperature": 0.7,
                    "maxTokens": 1024,
                    "promptTokens": 150,
                    "completionTokens": 50,
                    "latencyMs": 340.0,
                    "purpose": "action",
                }
            ],
            "providerAccesses": [
                {
                    "providerId": f"{trajectory_id}-prov-{i}-0",
                    "providerName": "gameStateProvider",
                    "timestamp": time.time() + i,
                    "query": {"type": "game_state"},
                    "data": {"health": 100},
                    "purpose": "context",
                }
            ],
            "action": {
                "attemptId": f"{trajectory_id}-act-{i}",
                "timestamp": time.time() + i,
                "actionType": "trade",
                "actionName": "buy",
                "parameters": {"symbol": "AAPL", "amount": 10},
                "success": True,
                "result": {"filled": True},
            },
            "reward": 0.5,
            "done": i == num_steps - 1,
        })

    return {
        "trajectoryId": trajectory_id,
        "agentId": agent_id,
        "source": source,
        "archetype": archetype,
        "windowId": "window-001",
        "scenarioId": "scenario-001",
        "startTime": time.time(),
        "endTime": time.time() + num_steps,
        "durationMs": num_steps * 1000,
        "steps": steps,
        "totalReward": sum(s["reward"] for s in steps),
        "finalStatus": "completed",
        "episodeLength": num_steps,
        "metrics": {"successRate": 0.8},
        "metadata": {"agentName": "test-agent"},
        "isTrainingData": True,
    }


class TestSchemaCreation:
    def test_tables_created(self, db):
        """All expected tables should exist after initialize()."""
        cursor = db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        tables = {row[0] for row in cursor.fetchall()}
        expected = {
            "trajectories", "trajectory_steps", "llm_calls",
            "provider_accesses", "control_frames", "embodied_contexts",
        }
        assert expected.issubset(tables)


class TestTrajectoryInsert:
    def test_insert_and_retrieve(self, db):
        traj = _make_trajectory()
        tid = db.insert_trajectory(traj)
        assert tid == "traj-001"

        result = db.get_trajectory(tid)
        assert result is not None
        assert result["trajectory_id"] == "traj-001"
        assert result["agent_id"] == "agent-001"
        assert result["source"] == "hyperscape_planner"

    def test_insert_with_steps(self, db):
        traj = _make_trajectory(num_steps=3)
        db.insert_trajectory(traj)

        steps = db.get_steps("traj-001")
        assert len(steps) == 3
        assert steps[0]["step_number"] == 0
        assert steps[2]["step_number"] == 2

    def test_llm_calls_normalized(self, db):
        traj = _make_trajectory(num_steps=2)
        db.insert_trajectory(traj)

        steps = db.get_steps("traj-001")
        calls = db.get_llm_calls(steps[0]["id"])
        assert len(calls) == 1
        assert calls[0]["model"] == "gpt-4"
        assert calls[0]["purpose"] == "action"
        assert calls[0]["prompt_tokens"] == 150

    def test_provider_accesses_normalized(self, db):
        traj = _make_trajectory(num_steps=1)
        db.insert_trajectory(traj)

        steps = db.get_steps("traj-001")
        # Provider accesses should be stored in provider_accesses table
        cursor = db._conn.execute(
            "SELECT provider_name FROM provider_accesses WHERE step_id = ?",
            (steps[0]["id"],),
        )
        rows = cursor.fetchall()
        assert len(rows) == 1
        assert rows[0][0] == "gameStateProvider"


class TestFiltering:
    def test_filter_by_agent(self, db):
        db.insert_trajectory(_make_trajectory("t1", "agent-A"))
        db.insert_trajectory(_make_trajectory("t2", "agent-B"))

        results = db.list_trajectories(agent_id="agent-A")
        assert len(results) == 1
        assert results[0]["agent_id"] == "agent-A"

    def test_filter_by_archetype(self, db):
        db.insert_trajectory(_make_trajectory("t1", archetype="trader"))
        db.insert_trajectory(_make_trajectory("t2", archetype="social"))

        results = db.list_trajectories(archetype="social")
        assert len(results) == 1

    def test_filter_by_source(self, db):
        db.insert_trajectory(_make_trajectory("t1", source="planner"))
        db.insert_trajectory(_make_trajectory("t2", source="executor"))

        results = db.list_trajectories(source="planner")
        assert len(results) == 1

    def test_filter_by_min_reward(self, db):
        t1 = _make_trajectory("t1")
        t1["totalReward"] = 10.0
        t2 = _make_trajectory("t2")
        t2["totalReward"] = 1.0
        db.insert_trajectory(t1)
        db.insert_trajectory(t2)

        results = db.list_trajectories(min_reward=5.0)
        assert len(results) == 1
        assert results[0]["trajectory_id"] == "t1"

    def test_filter_training_data(self, db):
        t1 = _make_trajectory("t1")
        t1["isTrainingData"] = True
        t2 = _make_trajectory("t2")
        t2["isTrainingData"] = False
        db.insert_trajectory(t1)
        db.insert_trajectory(t2)

        results = db.list_trajectories(is_training=True)
        assert len(results) == 1


class TestControlFrames:
    def test_insert_and_query(self, db):
        db.insert_trajectory(_make_trajectory("t1"))

        for i in range(10):
            db.insert_control_frame("t1", {
                "timestamp": 1000.0 + i * 0.02,
                "joint_positions": [0.0] * 24,
                "imu_roll": 0.01 * i,
                "imu_pitch": -0.005 * i,
                "reward": 0.1,
            })

        frames = db.get_control_frames("t1")
        assert len(frames) == 10
        assert frames[0]["timestamp"] < frames[-1]["timestamp"]

    def test_time_range_query(self, db):
        db.insert_trajectory(_make_trajectory("t1"))

        for i in range(10):
            db.insert_control_frame("t1", {
                "timestamp": 1000.0 + i,
                "joint_positions": [0.0] * 24,
            })

        frames = db.get_control_frames("t1", start_time=1003.0, end_time=1006.0)
        assert len(frames) == 4  # timestamps 1003, 1004, 1005, 1006


class TestEmbodiedContexts:
    def test_insert_and_query(self, db):
        db.insert_trajectory(_make_trajectory("t1"))

        ctx_id = db.insert_embodied_context("t1", {
            "timestamp": time.time(),
            "entities": [
                {"type": "PERSON", "position": [1.0, 0.5, 0.0], "confidence": 0.9},
                {"type": "OBJECT", "position": [2.0, -1.0, 0.0], "confidence": 0.7},
            ],
            "camera_views": ["ego_rgb", "external_rgb"],
            "agent_pose": {"position": [0, 0, 0], "orientation": [0, 0, 0, 1]},
            "task_description": "Walk to the red ball",
            "source": "mujoco",
        })
        assert ctx_id is not None

        cursor = db._conn.execute(
            "SELECT source, task_description FROM embodied_contexts WHERE trajectory_id = ?",
            ("t1",),
        )
        row = cursor.fetchone()
        assert row[0] == "mujoco"
        assert row[1] == "Walk to the red ball"


class TestStats:
    def test_basic_stats(self, db):
        for i in range(5):
            db.insert_trajectory(_make_trajectory(f"t{i}"))

        stats = db.get_stats()
        assert stats["trajectories_count"] == 5
        assert stats["trajectory_steps_count"] == 15  # 5 trajectories × 3 steps


class TestTrainingBatch:
    def test_get_training_batch(self, db):
        for i in range(5):
            t = _make_trajectory(f"t{i}", archetype="trader")
            t["isTrainingData"] = True
            t["totalReward"] = float(i)
            t["status"] = "completed"
            db.insert_trajectory(t)

        batch = db.get_training_batch(archetype="trader", min_score=2.0)
        assert len(batch) == 3  # t2, t3, t4 have reward >= 2.0

    def test_excludes_non_training_data(self, db):
        """Trajectories not flagged as training data must be excluded."""
        t_train = _make_trajectory("train1")
        t_train["isTrainingData"] = True
        t_train["status"] = "completed"
        db.insert_trajectory(t_train)

        t_eval = _make_trajectory("eval1")
        t_eval["isTrainingData"] = False
        t_eval["status"] = "completed"
        db.insert_trajectory(t_eval)

        batch = db.get_training_batch()
        ids = [t["trajectory_id"] for t in batch]
        assert "train1" in ids
        assert "eval1" not in ids

    def test_excludes_non_completed(self, db):
        t = _make_trajectory("active1")
        t["isTrainingData"] = True
        t["status"] = "active"  # not completed
        db.insert_trajectory(t)

        batch = db.get_training_batch()
        assert len(batch) == 0


class TestCompleteTrajectory:
    def test_mark_completed(self, db):
        db.insert_trajectory(_make_trajectory("t1"))
        db.complete_trajectory("t1", "completed", {"accuracy": 0.95})

        result = db.get_trajectory("t1")
        assert result["status"] == "completed"

    def test_updates_metrics(self, db):
        db.insert_trajectory(_make_trajectory("t1"))
        db.complete_trajectory("t1", "completed", {
            "total_reward": 42.0,
            "episode_length": 100,
        })
        result = db.get_trajectory("t1")
        assert result["total_reward"] == 42.0


class TestExportArt:
    def test_art_format_from_trajectory_with_llm_calls(self, db):
        db.insert_trajectory(_make_trajectory("t1", num_steps=2))
        art = db.export_art(["t1"])
        assert len(art) == 1
        record = art[0]
        assert "messages" in record
        assert "reward" in record
        assert "metadata" in record
        # Should have system + user + assistant messages from LLM calls
        assert len(record["messages"]) >= 3
        assert record["messages"][0]["role"] == "system"

    def test_art_missing_trajectory_returns_empty(self, db):
        art = db.export_art(["nonexistent"])
        assert art == []


class TestExportRlds:
    def test_rlds_creates_file(self, db, tmp_path):
        db.insert_trajectory(_make_trajectory("t1", num_steps=2))
        out_dir = str(tmp_path / "rlds_out")
        db.export_rlds(["t1"], out_dir)

        import os
        files = os.listdir(out_dir)
        assert "t1.json" in files

        with open(os.path.join(out_dir, "t1.json")) as f:
            episode = json.load(f)
        assert len(episode["steps"]) == 2
        assert episode["steps"][0]["is_first"] is True
        assert episode["steps"][-1]["is_last"] is True


class TestImportFromJson:
    def test_import_jsonl(self, db, tmp_path):
        """Import from a JSONL file."""
        traj = _make_trajectory("jsonl-1")
        jsonl_path = tmp_path / "test.jsonl"
        jsonl_path.write_text(json.dumps(traj) + "\n")

        count = db.import_from_json(str(jsonl_path))
        assert count == 1
        result = db.get_trajectory("jsonl-1")
        assert result is not None

    def test_import_json_array(self, db, tmp_path):
        """Import from a JSON array file."""
        trajs = [_make_trajectory(f"arr-{i}") for i in range(3)]
        json_path = tmp_path / "test.json"
        json_path.write_text(json.dumps(trajs))

        count = db.import_from_json(str(json_path))
        assert count == 3


class TestImportFromPostgresDump:
    def test_normalize_steps_json(self, db):
        """Importing a PostgreSQL-style row with stepsJson blob should normalize."""
        steps = [
            {
                "stepId": "s0",
                "stepNumber": 0,
                "timestamp": time.time(),
                "environmentState": {},
                "observation": {},
                "llmCalls": [{
                    "callId": "c0",
                    "timestamp": time.time(),
                    "model": "gpt-4",
                    "systemPrompt": "You are a helpful agent for this task.",
                    "userPrompt": "What should I do next in the current situation?",
                    "response": "Based on my analysis, you should proceed with the trade.",
                    "temperature": 0.7,
                    "maxTokens": 512,
                    "purpose": "action",
                }],
                "providerAccesses": [],
                "action": {
                    "attemptId": "a0",
                    "timestamp": time.time(),
                    "actionType": "trade",
                    "actionName": "buy",
                    "parameters": {},
                    "success": True,
                },
                "reward": 1.0,
                "done": True,
            }
        ]
        rows = [{
            "trajectoryId": "pg-001",
            "agentId": "agent-pg",
            "windowId": "w1",
            "stepsJson": json.dumps(steps),
            "metricsJson": "{}",
            "metadataJson": "{}",
            "totalReward": 1.0,
            "episodeLength": 1,
            "finalStatus": "completed",
            "archetype": "trader",
            "isTrainingData": True,
        }]

        count = db.import_from_postgres_dump(rows)
        assert count == 1

        result = db.get_trajectory("pg-001")
        assert result is not None
        steps_out = db.get_steps("pg-001")
        assert len(steps_out) == 1
