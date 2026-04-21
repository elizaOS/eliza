"""
Export utilities for ART trajectories.

Provides export to:
- JSONL (for OpenPipe ART)
- HuggingFace datasets
- GRPO grouped format
- RULER scoring format

All exports are compatible with the plugin-trajectory-logger format
for seamless integration with ElizaOS training pipelines.
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
    """
    Convert ElizaOS trajectory to ART format.
    
    This preserves all the rich data captured by the trajectory logger:
    - LLM calls with full context
    - Provider accesses
    - Action executions with results
    - Environment state
    """
    messages = []
    environment_context = {
        "initialBalance": 0,
        "finalBalance": 0,
        "initialPnL": 0,
        "finalPnL": 0,
        "actionsTaken": [],
        "errors": [],
        "providerAccesses": [],
        "llmCalls": [],
    }

    # Extract messages and context from steps
    for step in eliza_traj.get("steps", []):
        # Track environment state
        env_state = step.get("environmentState", {})
        if step.get("stepNumber", 0) == 0:
            environment_context["initialBalance"] = env_state.get("agentBalance", 0)
            environment_context["initialPnL"] = env_state.get("agentPnL", 0)
        environment_context["finalBalance"] = env_state.get("agentBalance", 0)
        environment_context["finalPnL"] = env_state.get("agentPnL", 0)

        # Track provider accesses
        for provider_access in step.get("providerAccesses", []):
            environment_context["providerAccesses"].append({
                "provider": provider_access.get("providerName"),
                "purpose": provider_access.get("purpose"),
            })

        # Process LLM calls
        for llm_call in step.get("llmCalls", []):
            # Track LLM call metadata
            environment_context["llmCalls"].append({
                "model": llm_call.get("model"),
                "purpose": llm_call.get("purpose"),
                "latencyMs": llm_call.get("latencyMs"),
                "promptTokens": llm_call.get("promptTokens"),
                "completionTokens": llm_call.get("completionTokens"),
            })

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

            # Assistant response with reasoning if available
            if llm_call.get("response"):
                content = llm_call["response"]
                if llm_call.get("reasoning"):
                    content = f"<reasoning>{llm_call['reasoning']}</reasoning>\n{content}"
                messages.append({
                    "role": "assistant",
                    "content": content,
                })

        # Track action
        action = step.get("action", {})
        action_name = action.get("actionName", "unknown")
        if action_name != "pending":
            environment_context["actionsTaken"].append(action_name)
            if not action.get("success", True):
                environment_context["errors"].append(action.get("error", "unknown error"))

    # Build game knowledge from metadata
    metadata = eliza_traj.get("metadata", {})
    game_knowledge = {}
    if metadata.get("trueProbabilities"):
        game_knowledge["trueProbabilities"] = metadata["trueProbabilities"]
    if metadata.get("futureOutcomes"):
        game_knowledge["actualOutcomes"] = metadata["futureOutcomes"]
    if metadata.get("hiddenVariables"):
        game_knowledge["hiddenVariables"] = metadata["hiddenVariables"]

    return {
        "messages": messages,
        "reward": eliza_traj.get("totalReward", 0.0),
        "metadata": {
            "trajectoryId": eliza_traj.get("trajectoryId"),
            "agentId": eliza_traj.get("agentId"),
            "scenarioId": eliza_traj.get("scenarioId"),
            "groupIndex": eliza_traj.get("groupIndex"),
            "environmentContext": environment_context,
            "gameKnowledge": game_knowledge if game_knowledge else None,
            "metrics": eliza_traj.get("metrics", {}),
            "rewardComponents": eliza_traj.get("rewardComponents", {}),
        },
        "metrics": {
            "episodeLength": eliza_traj.get("metrics", {}).get("episodeLength", 0),
            "durationMs": eliza_traj.get("durationMs", 0),
            "totalReward": eliza_traj.get("totalReward", 0.0),
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


async def export_for_ruler_scoring(
    trajectories: list[dict],
    output_path: str | Path,
) -> str:
    """
    Export trajectories in format optimized for RULER scoring.
    
    RULER (Rank Using LLM Evaluator Rewards) expects trajectories
    grouped by scenario with reward signals for comparison.
    
    Args:
        trajectories: List of trajectories to export
        output_path: Output file path
        
    Returns:
        Path to output file
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Group by scenario
    groups: dict[str, list[dict]] = {}
    for traj in trajectories:
        scenario_id = traj.get("scenarioId", "default")
        if scenario_id not in groups:
            groups[scenario_id] = []
        groups[scenario_id].append(traj)

    # Format for RULER
    ruler_data = []
    for scenario_id, trajs in groups.items():
        art_trajs = [_convert_to_art_format(t) for t in trajs]
        shared_prefix = _extract_shared_prefix(art_trajs)
        
        # Sort by reward for ranking reference
        sorted_trajs = sorted(art_trajs, key=lambda t: t.get("reward", 0), reverse=True)
        
        ruler_data.append({
            "scenarioId": scenario_id,
            "sharedPrefix": shared_prefix,
            "trajectories": sorted_trajs,
            "rewards": [t.get("reward", 0) for t in sorted_trajs],
            "rankings": list(range(len(sorted_trajs))),
        })

    with open(output_path, "w") as f:
        for group in ruler_data:
            f.write(json.dumps(group) + "\n")

    return str(output_path)


async def export_grouped_trajectories_for_grpo(
    trajectories: list[dict],
    output_path: str | Path,
    rollouts_per_group: int = 8,
) -> str:
    """
    Export trajectories grouped for GRPO training.
    
    GRPO requires trajectories to be grouped by scenario with
    multiple rollouts per group for relative reward computation.
    
    Args:
        trajectories: List of trajectories to export
        output_path: Output file path
        rollouts_per_group: Number of rollouts per training group
        
    Returns:
        Path to output file
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Group by scenario
    groups: dict[str, list[dict]] = {}
    for traj in trajectories:
        scenario_id = traj.get("scenarioId", "default")
        if scenario_id not in groups:
            groups[scenario_id] = []
        groups[scenario_id].append(traj)

    # Filter to groups with enough rollouts
    valid_groups = {
        k: v for k, v in groups.items()
        if len(v) >= 2  # Need at least 2 for comparison
    }

    # Format for GRPO
    grpo_groups = []
    for scenario_id, trajs in valid_groups.items():
        art_trajs = [_convert_to_art_format(t) for t in trajs[:rollouts_per_group]]
        shared_prefix = _extract_shared_prefix(art_trajs)
        
        # Compute relative rewards within group
        rewards = [t.get("reward", 0) for t in art_trajs]
        mean_reward = sum(rewards) / len(rewards) if rewards else 0
        normalized_rewards = [(r - mean_reward) for r in rewards]
        
        grpo_groups.append({
            "groupId": f"grpo-{len(grpo_groups)}",
            "scenarioId": scenario_id,
            "sharedPrefix": shared_prefix,
            "trajectories": art_trajs,
            "rewards": rewards,
            "normalizedRewards": normalized_rewards,
            "meanReward": mean_reward,
            "createdAt": int(datetime.now().timestamp() * 1000),
        })

    with open(output_path, "w") as f:
        for group in grpo_groups:
            f.write(json.dumps(group) + "\n")

    return str(output_path)


async def export_for_huggingface(
    trajectories: list[dict],
    output_dir: str | Path,
    dataset_name: str = "elizaos-trajectories",
    train_ratio: float = 0.8,
    validation_ratio: float = 0.1,
) -> dict[str, str]:
    """
    Export trajectories in HuggingFace datasets format.
    
    Creates train/validation/test splits ready for upload to HuggingFace Hub.
    
    Args:
        trajectories: List of trajectories to export
        output_dir: Output directory
        dataset_name: Name for the dataset
        train_ratio: Ratio of data for training
        validation_ratio: Ratio of data for validation
        
    Returns:
        Dict mapping split names to file paths
    """
    output_dir = Path(output_dir) / dataset_name
    output_dir.mkdir(parents=True, exist_ok=True)

    # Convert all trajectories
    art_trajectories = [_convert_to_art_format(t) for t in trajectories]

    # Split data
    n = len(art_trajectories)
    train_end = int(n * train_ratio)
    val_end = train_end + int(n * validation_ratio)

    splits = {
        "train": art_trajectories[:train_end],
        "validation": art_trajectories[train_end:val_end],
        "test": art_trajectories[val_end:],
    }

    # Write splits
    output_files = {}
    for split_name, split_data in splits.items():
        if not split_data:
            continue
        
        output_file = output_dir / f"{split_name}.jsonl"
        with open(output_file, "w") as f:
            for traj in split_data:
                f.write(json.dumps(traj) + "\n")
        output_files[split_name] = str(output_file)

    # Write dataset card
    dataset_card = f"""---
dataset_info:
  name: {dataset_name}
  description: ElizaOS agent trajectories for RL training
  size_categories:
    - {_size_category(n)}
  license: mit
  task_categories:
    - reinforcement-learning
    - text-generation
---

# {dataset_name}

ElizaOS agent trajectories exported for RL training.

## Dataset Statistics

- Total trajectories: {n}
- Train: {len(splits['train'])}
- Validation: {len(splits['validation'])}
- Test: {len(splits['test'])}

## Format

Each record contains:
- `messages`: Chat messages (system, user, assistant)
- `reward`: Total reward for the trajectory
- `metadata`: Rich metadata including environment context
- `metrics`: Episode metrics
"""
    
    with open(output_dir / "README.md", "w") as f:
        f.write(dataset_card)
    
    output_files["readme"] = str(output_dir / "README.md")
    
    return output_files


def _size_category(n: int) -> str:
    """Get HuggingFace size category."""
    if n < 1000:
        return "n<1K"
    elif n < 10000:
        return "1K<n<10K"
    elif n < 100000:
        return "10K<n<100K"
    elif n < 1000000:
        return "100K<n<1M"
    else:
        return "n>1M"
