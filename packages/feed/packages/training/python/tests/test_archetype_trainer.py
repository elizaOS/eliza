"""
Tests for the archetype trainer's real filtering/local-training path.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.models import BabylonTrajectory
from src.training.archetype_trainer import (
    ArchetypeTrainer,
    ArchetypeTrainingConfig,
)


def make_trajectory(
    trajectory_id: str, archetype: str | None, step_archetype: str | None = None
) -> BabylonTrajectory:
    parameters = {"size": 1}
    if step_archetype:
        parameters["archetype"] = step_archetype
    payload = {
        "trajectoryId": trajectory_id,
        "agentId": "agent-1",
        "windowId": "window-1",
        "archetype": archetype,
        "steps": [
            {
                "stepNumber": 1,
                "timestamp": 1001,
                "environmentState": {
                    "agentBalance": 10000,
                    "agentPnL": 5,
                    "openPositions": 0,
                    "activeMarkets": 1,
                },
                "llmCalls": [
                    {
                        "model": "tiny-test",
                        "systemPrompt": "s" * 30,
                        "userPrompt": "u" * 30,
                        "response": "r" * 40,
                        "temperature": 0.2,
                        "maxTokens": 64,
                        "purpose": "action",
                    }
                ],
                "action": {
                    "actionType": "trade",
                    "parameters": parameters,
                    "success": True,
                },
                "reward": 0.1,
            }
        ],
        "finalPnl": 10.0,
        "episodeLength": 1,
        "tradesExecuted": 1,
        "finalStatus": "completed",
    }
    return BabylonTrajectory.model_validate(payload)


def test_extract_trajectory_archetype_falls_back_to_step_parameters():
    trajectory = make_trajectory("traj-step", archetype=None, step_archetype="Trader")

    archetype = ArchetypeTrainer.extract_trajectory_archetype(trajectory)

    assert archetype == "trader"


def test_filter_trajectories_for_archetype_uses_normalized_values():
    trajectories = [
        make_trajectory("traj-trader", archetype="TRADER"),
        make_trajectory("traj-degen", archetype="degen"),
        make_trajectory("traj-step", archetype=None, step_archetype="trader"),
    ]

    filtered = ArchetypeTrainer.filter_trajectories_for_archetype(trajectories, "trader")

    assert [trajectory.trajectory_id for trajectory in filtered] == [
        "traj-trader",
        "traj-step",
    ]


@pytest.mark.asyncio
async def test_train_archetype_uses_filtered_trajectories_for_local_training(tmp_path, monkeypatch):
    trajectories = [
        make_trajectory("traj-trader-1", archetype="trader"),
        make_trajectory("traj-trader-2", archetype=None, step_archetype="trader"),
        make_trajectory("traj-degen-1", archetype="degen"),
    ]

    captured = {}

    def fake_samples(filtered_trajectories):
        captured["trajectory_ids"] = [
            trajectory.trajectory_id for trajectory in filtered_trajectories
        ]
        return [
            {"messages": [{"role": "user", "content": f"prompt-{index}"}]} for index in range(10)
        ]

    def fake_train_cpu(
        samples,
        model_name,
        output_dir,
        epochs,
        batch_size,
        learning_rate,
        max_steps,
        max_seq_length,
        gradient_accumulation_steps,
        seed,
        validation_split_ratio,
        eval_samples=None,
        optimizer_name="adamw",
    ):
        captured["sample_count"] = len(samples)
        captured["model_name"] = model_name
        captured["output_dir"] = output_dir
        output_path = Path(output_dir) / "final_model"
        output_path.mkdir(parents=True, exist_ok=True)
        (Path(output_dir) / "training_metrics.json").write_text(
            json.dumps({"loss": 0.25}),
            encoding="utf-8",
        )
        return str(output_path)

    monkeypatch.setattr("scripts.train_local.trajectories_to_training_samples", fake_samples)
    monkeypatch.setattr("scripts.train_local.train_cpu", fake_train_cpu)

    config = ArchetypeTrainingConfig(
        output_dir=str(tmp_path),
        min_trajectories_per_archetype=1,
        training_steps=4,
        batch_size=1,
        local_backend="cpu",
        local_validate=False,
    )
    trainer = ArchetypeTrainer(config)

    result = await trainer.train_archetype("trader", trajectories=trajectories)

    assert captured["trajectory_ids"] == ["traj-trader-1", "traj-trader-2"]
    assert captured["sample_count"] == 10
    assert result.archetype == "trader"
    assert result.trajectories_used == 2
    assert result.final_loss == 0.25

    manifest = json.loads(
        (tmp_path / "trader" / "training_manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["archetype"] == "trader"
    assert manifest["trajectory_count"] == 2
    assert manifest["sample_count"] == 10
