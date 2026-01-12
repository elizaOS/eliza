"""
Export utilities for ART trajectories.

Provides export to:
- JSONL (for OpenPipe ART)
- HuggingFace datasets
- GRPO grouped format
"""

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from elizaos_art.eliza_integration.storage_adapter import ElizaStorageAdapter


@dataclass
class ExportOptions:
    """Options for trajectory export."""

    # Output configuration
    output_dir: str = "./exports"
    format: str = "jsonl"  # "jsonl", "parquet", "arrow"

    # Filtering
    scenario_ids: list[str] | None = None
    agent_ids: list[str] | None = None
    min_reward: float | None = None
    max_reward: float | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None

    # Limits
    max_trajectories: int | None = None

    # Dataset splits
    train_ratio: float = 0.8
    validation_ratio: float = 0.1
    test_ratio: float = 0.1


@dataclass
class ExportResult:
    """Result of an export operation."""

    total_trajectories: int
    train_count: int
    validation_count: int
    test_count: int
    output_files: list[str]


async def export_for_art(
    storage: ElizaStorageAdapter,
    options: ExportOptions | None = None,
) -> ExportResult:
    """
    Export trajectories in OpenPipe ART format.
    
    Output format (JSONL):
    ```json
    {"messages": [...], "reward": 0.5, "metadata": {...}}
    ```
    """
    opts = options or ExportOptions()
    output_dir = Path(opts.output_dir) / "openpipe-art"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Build filter predicate
    def matches_filter(traj: dict) -> bool:
        if opts.scenario_ids and traj.get("scenarioId") not in opts.scenario_ids:
            return False
        if opts.agent_ids and traj.get("agentId") not in opts.agent_ids:
            return False
        if opts.min_reward is not None and traj.get("totalReward", 0) < opts.min_reward:
            return False
        if opts.max_reward is not None and traj.get("totalReward", 0) > opts.max_reward:
            return False
        return True

    # Get matching trajectories
    trajectories = await storage.trajectories.get_trajectories_where(matches_filter)

    if opts.max_trajectories:
        trajectories = trajectories[: opts.max_trajectories]

    # Convert to ART format
    art_trajectories = []
    for traj in trajectories:
        art_traj = _convert_to_art_format(traj)
        art_trajectories.append(art_traj)

    # Split into train/validation/test
    n = len(art_trajectories)
    train_end = int(n * opts.train_ratio)
    val_end = train_end + int(n * opts.validation_ratio)

    splits = {
        "train": art_trajectories[:train_end],
        "validation": art_trajectories[train_end:val_end],
        "test": art_trajectories[val_end:],
    }

    # Write output files
    output_files = []
    for split_name, split_data in splits.items():
        if not split_data:
            continue

        output_file = output_dir / f"{split_name}.jsonl"
        with open(output_file, "w") as f:
            for traj in split_data:
                f.write(json.dumps(traj) + "\n")
        output_files.append(str(output_file))

    return ExportResult(
        total_trajectories=n,
        train_count=len(splits["train"]),
        validation_count=len(splits["validation"]),
        test_count=len(splits["test"]),
        output_files=output_files,
    )


async def export_grouped_for_grpo(
    storage: ElizaStorageAdapter,
    options: ExportOptions | None = None,
) -> ExportResult:
    """
    Export trajectories grouped by scenario for GRPO training.
    
    Output format (JSONL):
    ```json
    {
        "groupId": "...",
        "scenarioId": "...",
        "trajectories": [...],
        "sharedPrefix": [...]
    }
    ```
    """
    opts = options or ExportOptions()
    output_dir = Path(opts.output_dir) / "grpo-groups"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Get all trajectories
    all_trajectories = await storage.trajectories.get_all_trajectories()

    # Group by scenario
    groups: dict[str, list[dict]] = {}
    for traj in all_trajectories:
        scenario_id = traj.get("scenarioId", "default")
        if scenario_id not in groups:
            groups[scenario_id] = []
        groups[scenario_id].append(traj)

    # Filter to scenarios with multiple trajectories
    valid_groups = {k: v for k, v in groups.items() if len(v) >= 2}

    # Convert to GRPO format
    grpo_groups = []
    for scenario_id, trajs in valid_groups.items():
        art_trajs = [_convert_to_art_format(t) for t in trajs]
        shared_prefix = _extract_shared_prefix(art_trajs)

        grpo_groups.append({
            "groupId": f"group-{len(grpo_groups)}",
            "scenarioId": scenario_id,
            "trajectories": art_trajs,
            "sharedPrefix": shared_prefix,
            "createdAt": int(datetime.now().timestamp() * 1000),
        })

    # Write output
    output_file = output_dir / "groups.jsonl"
    with open(output_file, "w") as f:
        for group in grpo_groups:
            f.write(json.dumps(group) + "\n")

    return ExportResult(
        total_trajectories=sum(len(g["trajectories"]) for g in grpo_groups),
        train_count=len(grpo_groups),
        validation_count=0,
        test_count=0,
        output_files=[str(output_file)],
    )


def _convert_to_art_format(eliza_traj: dict) -> dict:
    """Convert ElizaOS trajectory to ART format."""
    messages = []

    # Extract messages from steps
    for step in eliza_traj.get("steps", []):
        for llm_call in step.get("llmCalls", []):
            # System prompt (only add once)
            if llm_call.get("systemPrompt") and not any(
                m.get("role") == "system" for m in messages
            ):
                messages.append({
                    "role": "system",
                    "content": llm_call["systemPrompt"],
                })

            # User prompt
            if llm_call.get("userPrompt"):
                messages.append({
                    "role": "user",
                    "content": llm_call["userPrompt"],
                })

            # Assistant response
            if llm_call.get("response"):
                messages.append({
                    "role": "assistant",
                    "content": llm_call["response"],
                })

    return {
        "messages": messages,
        "reward": eliza_traj.get("totalReward", 0.0),
        "metadata": {
            "trajectoryId": eliza_traj.get("trajectoryId"),
            "agentId": eliza_traj.get("agentId"),
            "scenarioId": eliza_traj.get("scenarioId"),
            "environmentContext": {
                "actionsTaken": [
                    s.get("action", {}).get("actionType", "unknown")
                    for s in eliza_traj.get("steps", [])
                ],
            },
            "metrics": eliza_traj.get("metrics", {}),
        },
    }


def _extract_shared_prefix(trajectories: list[dict]) -> list[dict]:
    """Extract common message prefix from trajectories."""
    if not trajectories:
        return []

    all_messages = [t.get("messages", []) for t in trajectories]
    if not all_messages:
        return []

    first_messages = all_messages[0]
    shared = []

    for i, msg in enumerate(first_messages):
        all_match = all(
            len(msgs) > i
            and msgs[i].get("role") == msg.get("role")
            and msgs[i].get("content") == msg.get("content")
            for msgs in all_messages
        )
        if all_match:
            shared.append(msg)
        else:
            break

    return shared


async def export_trajectories_art_format(
    trajectories: list[dict],
    output_path: str | Path,
) -> str:
    """
    Export trajectories to ART-compatible JSONL format.
    
    Args:
        trajectories: List of trajectories to export
        output_path: Output file path
        
    Returns:
        Path to output file
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, "w") as f:
        for traj in trajectories:
            art_traj = _convert_to_art_format(traj)
            f.write(json.dumps(art_traj) + "\n")
    
    return str(output_path)


async def export_trajectories_jsonl(
    trajectories: list[dict],
    output_path: str | Path,
) -> str:
    """
    Export trajectories to JSONL format.
    
    Args:
        trajectories: List of trajectories to export
        output_path: Output file path
        
    Returns:
        Path to output file
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, "w") as f:
        for traj in trajectories:
            f.write(json.dumps(traj) + "\n")
    
    return str(output_path)
