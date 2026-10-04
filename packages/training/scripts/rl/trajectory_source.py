"""Read complete legacy Feed trajectories without an external data-bridge package."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any


def local_trajectories(source: str) -> Iterator[dict[str, Any]]:
    path = Path(source)
    if not path.exists():
        raise FileNotFoundError(path)
    files = (
        [path]
        if path.is_file()
        else sorted(
            p
            for p in path.rglob("*")
            if p.suffix in {".json", ".jsonl"} and p.is_file()
        )
    )
    if not files:
        raise ValueError(f"No trajectory JSON or JSONL files in {path}")
    for file in files:
        with file.open(encoding="utf-8") as stream:
            if file.suffix == ".jsonl":
                for line_number, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise ValueError(
                            f"{file}:{line_number}: invalid trajectory JSON"
                        ) from exc
                    yield _trajectory(row, f"{file}:{line_number}")
            else:
                payload = json.load(stream)
                rows = payload if isinstance(payload, list) else [payload]
                for row in rows:
                    yield _trajectory(row, str(file))


def _trajectory(row: Any, location: str) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise ValueError(f"{location}: expected a trajectory object")
    if not (row.get("windowId") or row.get("window_id")):
        raise ValueError(f"{location}: missing trajectory window ID")
    if "steps" not in row and "stepsJson" not in row:
        raise ValueError(f"{location}: missing complete trajectory steps")
    return row


def has_minimum_usable_action_steps(
    steps: list[Any], *, min_actions: int
) -> tuple[bool, int]:
    count = sum(
        1
        for step in steps
        if isinstance(step, dict)
        and isinstance(step.get("action"), dict)
        and (step["action"].get("actionType") or step["action"].get("action_type"))
    )
    return count >= min_actions, count


import logging
import random

logger = logging.getLogger(__name__)


def group_trajectories(trajectories, *, min_actions: int):

    groups: dict[str, list[dict]] = {}
    selected_trajectories = 0

    for trajectory_data in trajectories:
        window_id = trajectory_data.get("windowId") or trajectory_data.get("window_id")
        if not window_id:
            raise ValueError("Trajectory is missing its window ID")
        steps = trajectory_data.get("steps", trajectory_data.get("stepsJson", []))
        if isinstance(steps, str):
            try:
                steps = json.loads(steps or "[]")
            except json.JSONDecodeError as exc:
                raise ValueError("Malformed exported trajectory steps") from exc
        if not isinstance(steps, list) or any(
            not isinstance(step, dict) for step in steps
        ):
            raise ValueError("Exported trajectory steps must be a list of objects")

        has_enough_steps, valid_step_count = has_minimum_usable_action_steps(
            steps,
            min_actions=min_actions,
        )
        if not has_enough_steps:
            logger.debug(
                "Skipping local-export trajectory %s: only %s usable action-bearing steps",
                trajectory_data.get("trajectoryId")
                or trajectory_data.get("trajectory_id")
                or "unknown",
                valid_step_count,
            )
            continue

        metadata = (
            trajectory_data.get("metadata") or trajectory_data.get("metadataJson") or {}
        )
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata) if metadata else {}
            except json.JSONDecodeError as exc:
                raise ValueError("Malformed exported trajectory metadata") from exc
        if not isinstance(metadata, dict):
            raise ValueError("Exported trajectory metadata must be an object")

        scenario_id = trajectory_data.get("scenarioId") or trajectory_data.get(
            "scenario_id"
        )
        group_key = f"{window_id}_{scenario_id or 'default'}"
        final_pnl = float(
            trajectory_data.get("finalPnL") or trajectory_data.get("final_pnl") or 0.0
        )
        raw_final_balance = trajectory_data.get(
            "finalBalance", trajectory_data.get("final_balance")
        )
        final_balance: float | None = None
        starting_balance: float | None = None
        if raw_final_balance is not None:
            try:
                final_balance = float(raw_final_balance)
                starting_balance = final_balance - final_pnl
            except (TypeError, ValueError):
                final_balance = None
                starting_balance = None

        agent_id = (
            trajectory_data.get("agentId")
            or trajectory_data.get("agent_id")
            or trajectory_data.get("userId")
            or f"{window_id}:{selected_trajectories}"
        )
        agent_name = (
            metadata.get("username") or metadata.get("displayName") or str(agent_id)[:8]
        )
        archetype = (
            trajectory_data.get("archetype") or metadata.get("archetype") or "default"
        )

        groups.setdefault(group_key, []).append(
            {
                **trajectory_data,
                "trajectory_id": trajectory_data.get("trajectoryId")
                or trajectory_data.get("trajectory_id")
                or trajectory_data.get("id")
                or f"{window_id}:{selected_trajectories}",
                "agent_id": agent_id,
                "agent_name": agent_name,
                "window_id": window_id,
                "scenario_id": scenario_id,
                "archetype": archetype,
                "metadata": metadata,
                "steps": steps,
                "final_pnl": final_pnl,
                "final_balance": final_balance,
                "starting_balance": starting_balance,
                "episode_length": int(
                    trajectory_data.get("episodeLength")
                    or trajectory_data.get("episode_length")
                    or len(steps)
                ),
                "total_reward": float(
                    trajectory_data.get("totalReward")
                    or trajectory_data.get("total_reward")
                    or 0.0
                ),
            }
        )
        selected_trajectories += 1
    trajectory_cache = [
        {"group_key": key, "trajectories": trajectories}
        for key, trajectories in groups.items()
        if len(trajectories) >= 1
    ]

    random.shuffle(trajectory_cache)
    logger.info(
        "Loaded %s local-export trajectories across %s comparable groups",
        selected_trajectories,
        len(trajectory_cache),
    )
    return trajectory_cache
