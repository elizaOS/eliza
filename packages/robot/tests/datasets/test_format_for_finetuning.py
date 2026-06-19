"""Tests for eliza_robot.datasets.format_for_finetuning."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from eliza_robot.datasets.format_for_finetuning import (
    export_dataset,
    format_trajectory_lora,
    format_trajectory_openai,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_trajectory(
    trajectory_id: str = "test-traj-001",
    num_steps: int = 3,
    total_reward: float = 0.8,
) -> dict:
    """Build a minimal trajectory dict mimicking TrajectoryDB output."""
    steps = []
    for i in range(num_steps):
        steps.append({
            "id": f"step-{i}",
            "trajectory_id": trajectory_id,
            "step_number": i,
            "timestamp": 1000.0 + i,
            "observation_json": {
                "entities": [
                    {
                        "label": "red_ball",
                        "entity_type": "object",
                        "distance_to_agent": 1.5 + i * 0.1,
                        "bearing_to_agent": 0.1,
                        "confidence": 0.92,
                    },
                ],
                "is_walking": i > 0,
                "battery_mv": 11500,
                "imu_roll": 0.01,
                "imu_pitch": -0.02,
                "task_description": "walk to the red ball",
            },
            "action_type": "POLICY_START",
            "action_name": "walk_to_target",
            "action_params_json": {"target": "red_ball", "speed": 2},
            "action_success": True,
            "action_result_json": {"status": "ok"},
            "reward": 0.3 if i < num_steps - 1 else 0.8,
            "done": i == num_steps - 1,
            "reasoning": "Walking toward the detected red ball",
            "llm_calls": [],
            "provider_accesses": [],
        })

    return {
        "id": "row-001",
        "trajectory_id": trajectory_id,
        "agent_id": "test-agent",
        "source": "test",
        "status": "completed",
        "total_reward": total_reward,
        "steps": steps,
    }


# ---------------------------------------------------------------------------
# OpenAI format
# ---------------------------------------------------------------------------

class TestFormatOpenAI:
    def test_basic_output_structure(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_openai(traj)

        assert len(examples) == 3  # one per step

        for ex in examples:
            assert "messages" in ex
            assert "trajectory_id" in ex
            assert ex["trajectory_id"] == "test-traj-001"

            messages = ex["messages"]
            assert len(messages) == 3
            assert messages[0]["role"] == "system"
            assert messages[1]["role"] == "user"
            assert messages[2]["role"] == "assistant"

    def test_system_prompt_is_present(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_openai(traj)
        system_msg = examples[0]["messages"][0]
        assert "robot controller" in system_msg["content"].lower()

    def test_user_message_contains_scene(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_openai(traj)
        user_msg = examples[0]["messages"][1]["content"]
        assert "red_ball" in user_msg
        assert "object" in user_msg

    def test_assistant_message_is_valid_json(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_openai(traj)
        for ex in examples:
            assistant_content = ex["messages"][2]["content"]
            parsed = json.loads(assistant_content)
            assert "action_type" in parsed
            assert "action_name" in parsed

    def test_trajectory_id_traceability(self) -> None:
        traj = _make_trajectory(trajectory_id="my-unique-id")
        examples = format_trajectory_openai(traj)
        for ex in examples:
            assert ex["trajectory_id"] == "my-unique-id"

    def test_step_number_included(self) -> None:
        traj = _make_trajectory(num_steps=5)
        examples = format_trajectory_openai(traj)
        step_numbers = [ex["step_number"] for ex in examples]
        assert step_numbers == [0, 1, 2, 3, 4]

    def test_reward_included(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_openai(traj)
        # Last step should have reward 0.8
        assert examples[-1]["reward"] == 0.8


# ---------------------------------------------------------------------------
# LoRA / Alpaca format
# ---------------------------------------------------------------------------

class TestFormatLora:
    def test_basic_output_structure(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_lora(traj)

        assert len(examples) == 3

        for ex in examples:
            assert "instruction" in ex
            assert "input" in ex
            assert "output" in ex
            assert "trajectory_id" in ex

    def test_instruction_field(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_lora(traj)
        assert "humanoid robot" in examples[0]["instruction"].lower()

    def test_input_contains_scene(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_lora(traj)
        assert "red_ball" in examples[0]["input"]

    def test_output_is_valid_json(self) -> None:
        traj = _make_trajectory()
        examples = format_trajectory_lora(traj)
        for ex in examples:
            parsed = json.loads(ex["output"])
            assert "action_name" in parsed

    def test_trajectory_id_traceability(self) -> None:
        traj = _make_trajectory(trajectory_id="lora-test-id")
        examples = format_trajectory_lora(traj)
        for ex in examples:
            assert ex["trajectory_id"] == "lora-test-id"


# ---------------------------------------------------------------------------
# export_dataset (integration)
# ---------------------------------------------------------------------------

class TestExportDataset:
    """Integration tests that write to a real SQLite DB and export."""

    def _setup_db(self, db_path: str) -> None:
        """Create a DB with a few test trajectories."""
        from eliza_robot.trajectory_db.db import TrajectoryDB

        db = TrajectoryDB(db_path)
        db.initialize()

        # Insert two trajectories
        for i in range(2):
            traj_data = {
                "trajectory_id": f"export-test-{i}",
                "agent_id": "test-agent",
                "source": "test",
                "status": "completed",
                "total_reward": 0.5 + i * 0.3,
                "is_training_data": True,
            }
            tid = db.insert_trajectory(traj_data)

            for step_idx in range(3):
                db.insert_step(tid, {
                    "step_number": step_idx,
                    "observation_json": {
                        "entities": [{"label": "ball", "entity_type": "object",
                                      "distance_to_agent": 2.0, "bearing_to_agent": 0.0,
                                      "confidence": 0.9}],
                        "is_walking": True,
                    },
                    "action_type": "WALK",
                    "action_name": "walk_to_target",
                    "action_params_json": {"target": "ball"},
                    "reward": 0.3,
                })

        db.close()

    def test_export_openai_writes_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test.db")
            output_path = os.path.join(tmpdir, "openai.jsonl")

            self._setup_db(db_path)
            count = export_dataset(db_path, output_path, format="openai")

            assert count > 0
            assert Path(output_path).exists()

            lines = Path(output_path).read_text().strip().splitlines()
            assert len(lines) == count

            # Each line should be valid JSON
            for line in lines:
                parsed = json.loads(line)
                assert "messages" in parsed
                assert "trajectory_id" in parsed

    def test_export_lora_writes_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test.db")
            output_path = os.path.join(tmpdir, "lora.jsonl")

            self._setup_db(db_path)
            count = export_dataset(db_path, output_path, format="lora")

            assert count > 0
            lines = Path(output_path).read_text().strip().splitlines()
            for line in lines:
                parsed = json.loads(line)
                assert "instruction" in parsed
                assert "input" in parsed
                assert "output" in parsed

    def test_export_rlds_creates_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test.db")
            output_dir = os.path.join(tmpdir, "rlds_out")

            self._setup_db(db_path)
            count = export_dataset(db_path, output_dir, format="rlds")

            assert count > 0
            assert Path(output_dir).is_dir()
            json_files = list(Path(output_dir).glob("*.json"))
            assert len(json_files) == count

    def test_export_with_min_reward_filter(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "test.db")
            output_path = os.path.join(tmpdir, "filtered.jsonl")

            self._setup_db(db_path)
            # Only the second trajectory has reward 0.8, first has 0.5
            count = export_dataset(
                db_path, output_path, format="openai", min_reward=0.7
            )

            # Should get only steps from the high-reward trajectory
            assert count > 0
            lines = Path(output_path).read_text().strip().splitlines()
            traj_ids = {json.loads(l)["trajectory_id"] for l in lines}
            assert "export-test-1" in traj_ids
            assert "export-test-0" not in traj_ids

    def test_export_empty_db_returns_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "empty.db")
            output_path = os.path.join(tmpdir, "empty.jsonl")

            from eliza_robot.trajectory_db.db import TrajectoryDB
            db = TrajectoryDB(db_path)
            db.initialize()
            db.close()

            count = export_dataset(db_path, output_path, format="openai")
            assert count == 0
