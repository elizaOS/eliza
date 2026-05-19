"""Export trajectory data for LLM fine-tuning.

Reads from :class:`~eliza_robot.trajectory_db.db.TrajectoryDB` and exports in
formats suitable for supervised fine-tuning of language models.

Formats
-------
- **openai** -- OpenAI fine-tuning JSONL (chat messages format)
- **lora** -- Alpaca-style instruction/input/output JSONL
- **art** -- ART/OpenPipe format (delegates to ``TrajectoryDB.export_art``)
- **rlds** -- RLDS format (delegates to ``TrajectoryDB.export_rlds``)

Usage::

    python -m eliza_robot.datasets.format_for_finetuning \\
        --db trajectories.db \\
        --format openai \\
        --output data/finetune/openai.jsonl \\
        --min-reward 0.5
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# System prompt used across formats
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "You are a robot controller. Given a scene description and a user "
    "instruction, choose the best action for the robot to take. Respond "
    "with a JSON object containing the action type, action name, and any "
    "parameters."
)

_LORA_INSTRUCTION = (
    "You are controlling a humanoid robot. Read the scene description and "
    "user command below, then output the appropriate action as JSON."
)


# ---------------------------------------------------------------------------
# Scene description builder
# ---------------------------------------------------------------------------

def _build_scene_description(step: dict[str, Any]) -> str:
    """Build a textual scene description from a trajectory step.

    Extracts data from the observation / environment_state JSON blobs
    stored in each step.
    """
    obs = step.get("observation_json") or step.get("environment_state_json") or {}
    if isinstance(obs, str):
        try:
            obs = json.loads(obs)
        except (json.JSONDecodeError, TypeError):
            obs = {}
    if not isinstance(obs, dict):
        obs = {}

    parts: list[str] = []

    # Entity descriptions
    entities = obs.get("entities", [])
    if isinstance(entities, list) and entities:
        parts.append(f"Nearby entities ({len(entities)}):")
        for idx, ent in enumerate(entities[:8], start=1):
            if not isinstance(ent, dict):
                continue
            label = ent.get("label", "unknown")
            etype = ent.get("entity_type", "object")
            dist = ent.get("distance_to_agent", 0.0)
            bearing = ent.get("bearing_to_agent", 0.0)
            conf = ent.get("confidence", 0.0)
            parts.append(
                f"  {idx}. [{label}] {etype} -- "
                f"{dist:.1f}m, bearing {bearing:.2f} rad, conf {conf:.2f}"
            )

    # Agent state
    if obs.get("is_walking") is not None:
        posture = "walking" if obs["is_walking"] else "standing"
        parts.append(f"Robot is {posture}.")
    if obs.get("battery_mv"):
        parts.append(f"Battery: {obs['battery_mv']}mV.")
    if obs.get("imu_roll") is not None:
        parts.append(
            f"IMU: roll={obs.get('imu_roll', 0.0):.3f}, "
            f"pitch={obs.get('imu_pitch', 0.0):.3f}."
        )

    # Task / language instruction
    task = obs.get("task_description", "")
    instruction = obs.get("language_instruction", "")
    if task:
        parts.append(f"Task: {task}")
    if instruction:
        parts.append(f"Instruction: {instruction}")

    return "\n".join(parts) if parts else "No scene data available."


def _build_action_json(step: dict[str, Any]) -> str:
    """Build the action JSON string from a trajectory step."""
    action: dict[str, Any] = {
        "action_type": step.get("action_type", ""),
        "action_name": step.get("action_name", ""),
    }
    params = step.get("action_params_json")
    if isinstance(params, str):
        try:
            params = json.loads(params)
        except (json.JSONDecodeError, TypeError):
            params = {}
    if isinstance(params, dict) and params:
        action["parameters"] = params

    reasoning = step.get("reasoning")
    if reasoning:
        action["reasoning"] = reasoning

    return json.dumps(action, separators=(",", ":"))


# ---------------------------------------------------------------------------
# Format: OpenAI chat messages
# ---------------------------------------------------------------------------

def format_trajectory_openai(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert a trajectory to OpenAI fine-tuning messages format.

    Each step becomes a conversation turn:
    - system: controller description
    - user: EmbodiedContext description + user instruction
    - assistant: chosen action (CanonicalIntent + parameters)

    Returns a list of training examples (one per step).
    """
    trajectory_id = trajectory.get("trajectory_id", "")
    steps = trajectory.get("steps", [])
    examples: list[dict[str, Any]] = []

    for step in steps:
        if not isinstance(step, dict):
            continue

        scene = _build_scene_description(step)
        action_json = _build_action_json(step)

        # Build user message from scene + any task text
        user_parts: list[str] = [scene]
        reasoning = step.get("reasoning")
        if reasoning:
            user_parts.append(f"\nUser request: {reasoning}")

        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": "\n".join(user_parts)},
            {"role": "assistant", "content": action_json},
        ]

        example: dict[str, Any] = {
            "messages": messages,
            "trajectory_id": trajectory_id,
            "step_number": step.get("step_number", 0),
        }

        reward = step.get("reward")
        if reward is not None:
            example["reward"] = reward

        examples.append(example)

    return examples


# ---------------------------------------------------------------------------
# Format: Alpaca-style (instruction/input/output)
# ---------------------------------------------------------------------------

def format_trajectory_lora(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert to Alpaca-style instruction/input/output format.

    Returns a list of training examples (one per step).
    """
    trajectory_id = trajectory.get("trajectory_id", "")
    steps = trajectory.get("steps", [])
    examples: list[dict[str, Any]] = []

    for step in steps:
        if not isinstance(step, dict):
            continue

        scene = _build_scene_description(step)
        action_json = _build_action_json(step)

        example: dict[str, Any] = {
            "instruction": _LORA_INSTRUCTION,
            "input": scene,
            "output": action_json,
            "trajectory_id": trajectory_id,
            "step_number": step.get("step_number", 0),
        }

        reward = step.get("reward")
        if reward is not None:
            example["reward"] = reward

        examples.append(example)

    return examples


# ---------------------------------------------------------------------------
# Export dispatcher
# ---------------------------------------------------------------------------

def export_dataset(
    db_path: str,
    output_path: str,
    format: str = "openai",
    min_reward: float | None = None,
    max_trajectories: int | None = None,
    source: str | None = None,
) -> int:
    """Export filtered trajectories to fine-tuning format.

    Parameters
    ----------
    db_path:
        Path to the SQLite trajectory database.
    output_path:
        Destination file (JSONL) or directory (RLDS).
    format:
        One of ``"openai"``, ``"lora"``, ``"art"``, ``"rlds"``.
    min_reward:
        Minimum total_reward filter.
    max_trajectories:
        Cap the number of trajectories exported.
    source:
        Filter by trajectory source (e.g. ``"hyperscape"``, ``"real_robot"``).

    Returns
    -------
    int
        Number of training examples written (for openai/lora) or
        trajectories exported (for art/rlds).
    """
    from eliza_robot.trajectory_db.db import TrajectoryDB

    db = TrajectoryDB(db_path)
    db.initialize()

    try:
        # Fetch trajectories with filtering
        trajectories = db.list_trajectories(
            min_reward=min_reward,
            source=source,
            limit=max_trajectories or 100000,
        )

        if not trajectories:
            logger.warning("No trajectories matched the filter criteria")
            return 0

        trajectory_ids = [t["trajectory_id"] for t in trajectories]

        # Delegate to the appropriate format handler
        if format == "rlds":
            out_dir = db.export_rlds(trajectory_ids, output_path)
            logger.info("Exported %d trajectories to RLDS at %s", len(trajectory_ids), out_dir)
            return len(trajectory_ids)

        if format == "art":
            art_records = db.export_art(trajectory_ids)
            out_path = Path(output_path)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with out_path.open("w", encoding="utf-8") as f:
                for record in art_records:
                    f.write(json.dumps(record, separators=(",", ":")) + "\n")
            logger.info("Exported %d ART records to %s", len(art_records), output_path)
            return len(art_records)

        # For openai/lora, load full trajectories and convert step by step
        formatter = format_trajectory_openai if format == "openai" else format_trajectory_lora

        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        total_examples = 0
        with out_path.open("w", encoding="utf-8") as f:
            for tid in trajectory_ids:
                full_traj = db.get_trajectory(tid)
                if full_traj is None:
                    continue
                examples = formatter(full_traj)
                for example in examples:
                    f.write(json.dumps(example, separators=(",", ":")) + "\n")
                    total_examples += 1

        logger.info(
            "Exported %d examples from %d trajectories (%s format) to %s",
            total_examples,
            len(trajectory_ids),
            format,
            output_path,
        )
        return total_examples

    finally:
        db.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Export trajectory data for LLM fine-tuning"
    )
    parser.add_argument(
        "--db",
        default="trajectories.db",
        help="Path to the SQLite trajectory database (default: trajectories.db)",
    )
    parser.add_argument(
        "--format",
        choices=["openai", "lora", "art", "rlds"],
        default="openai",
        help="Export format (default: openai)",
    )
    parser.add_argument(
        "--output", "-o",
        required=True,
        help="Output file path (JSONL) or directory (RLDS)",
    )
    parser.add_argument(
        "--min-reward",
        type=float,
        default=None,
        help="Minimum total_reward to include",
    )
    parser.add_argument(
        "--max-trajectories",
        type=int,
        default=None,
        help="Maximum number of trajectories to export",
    )
    parser.add_argument(
        "--source",
        default=None,
        help="Filter by trajectory source (e.g. hyperscape, real_robot)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    count = export_dataset(
        db_path=args.db,
        output_path=args.output,
        format=args.format,
        min_reward=args.min_reward,
        max_trajectories=args.max_trajectories,
        source=args.source,
    )
    print(f"Exported {count} records to {args.output}")


if __name__ == "__main__":
    main()
