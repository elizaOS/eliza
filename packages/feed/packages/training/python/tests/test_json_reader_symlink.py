from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.data_bridge.reader import JsonTrajectoryReader, discover_local_export_files


def make_trajectory(trajectory_id: str) -> dict:
    return {
        "trajectoryId": trajectory_id,
        "windowId": "window-1",
        "steps": [
            {
                "stepNumber": 1,
                "llmCalls": [
                    {
                        "systemPrompt": "System prompt with enough length to count as valid.",
                        "userPrompt": "User prompt with enough length to count as valid.",
                        "response": "Model response with enough length to count as valid.",
                    }
                ],
                "action": {
                    "actionType": "TRADE",
                    "parameters": {"marketId": "market-1", "side": "buy_yes", "amount": 100},
                },
            }
        ],
    }


def test_reader_discovers_symlinked_export_directories(tmp_path: Path) -> None:
    export_dir = tmp_path / "export-a" / "2026-03-27T22-12-41.413Z"
    export_dir.mkdir(parents=True)

    (export_dir / "manifest.json").write_text("{}", encoding="utf-8")
    with (export_dir / "trajectories.jsonl").open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(make_trajectory("traj-1")) + "\n")

    curated_root = tmp_path / "curated"
    curated_root.mkdir()
    (curated_root / "linked-export").symlink_to(export_dir, target_is_directory=True)

    files = discover_local_export_files(curated_root)
    assert (export_dir / "trajectories.jsonl").resolve() in files

    reader = JsonTrajectoryReader(str(curated_root))
    assert reader.get_window_ids() == ["window-1"]
    trajectories = reader.get_trajectories_by_window("window-1")
    assert len(trajectories) == 1
    assert trajectories[0]["trajectoryId"] == "traj-1"


def test_reader_recovers_provenance_and_agent_metadata_from_export_sidecars(
    tmp_path: Path,
) -> None:
    export_dir = tmp_path / "export-b" / "2026-03-27T22-12-41.413Z"
    export_dir.mkdir(parents=True)

    (export_dir / "manifest.json").write_text(
        json.dumps(
            {
                "sourceBatchId": "legacy-batch-1",
                "sourceExperimentRunId": "legacy-run-1",
                "selectionStrategy": "exact_batch_id",
            }
        ),
        encoding="utf-8",
    )
    (export_dir / "matched-agents.json").write_text(
        json.dumps(
            {
                "agents": [
                    {
                        "userId": "agent-123",
                        "modelSize": "3b",
                        "trainingProfile": "24gb",
                        "username": "agent_alpha",
                        "displayName": "Agent Alpha",
                        "instanceId": "alpha-3b-v1",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with (export_dir / "trajectories.jsonl").open("w", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {
                    "trajectoryId": "traj-2",
                    "agentId": "agent-123",
                    "windowId": "window-2",
                    "batchId": None,
                    "metadataJson": "{}",
                    "steps": make_trajectory("traj-2")["steps"],
                }
            )
            + "\n"
        )

    reader = JsonTrajectoryReader(str(export_dir.parent))
    trajectories = reader.get_trajectories_by_window("window-2")
    assert len(trajectories) == 1
    trajectory = trajectories[0]
    assert trajectory["batchId"] == "legacy-batch-1"
    metadata = trajectory["metadata"]
    assert metadata["batchId"] == "legacy-batch-1"
    assert metadata["experimentRunId"] == "legacy-run-1"
    assert metadata["selectionStrategy"] == "exact_batch_id"
    assert metadata["modelSize"] == "3b"
    assert metadata["trainingProfile"] == "24gb"
    assert metadata["instanceId"] == "alpha-3b-v1"
