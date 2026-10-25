"""Trajectory compatibility and export helpers for AgentBench.

The Python Eliza runtime path has been removed from benchmarks. Real Eliza
runs go through the TypeScript benchmark bridge, which may also own
runtime-side trajectory logging. For smoke tests and offline runs, this module
exports adapter step records from ``agentbench-detailed.json`` into compact
JSONL formats.
"""

from __future__ import annotations

import json
from pathlib import Path

TrajectoryFormat = str

def is_trajectory_logging_available() -> bool:
    return False


def get_trajectory_logger_plugin():
    return None


def get_trajectory_logger_service(runtime: object):
    """
    Returns the trajectory logger service if registered; otherwise None.
    """
    get_service = getattr(runtime, "get_service", None)
    if not callable(get_service):
        return None
    return get_service("trajectory_logger")


def export_trajectories_from_results(
    output_dir: str | Path,
    trajectory_format: TrajectoryFormat = "art",
) -> Path:
    """Export benchmark step records as JSONL trajectories.

    ``art`` emits one record per task with a ``messages`` transcript and
    outcome metadata. ``grpo`` emits group-ready prompt/completion/reward
    records. Both are intentionally small but concrete enough for benchmark
    smoke validation.
    """
    out_dir = Path(output_dir)
    detailed_path = out_dir / "agentbench-detailed.json"
    if not detailed_path.is_file():
        raise FileNotFoundError(f"Detailed AgentBench results not found: {detailed_path}")

    with detailed_path.open("r", encoding="utf-8") as f:
        detailed = json.load(f)
    if not isinstance(detailed, list):
        raise ValueError(f"Detailed AgentBench results must be a list: {detailed_path}")

    if trajectory_format not in {"art", "grpo"}:
        raise ValueError(f"trajectory_format must be 'art' or 'grpo', got {trajectory_format!r}")

    export_path = out_dir / f"agentbench-trajectories-{trajectory_format}.jsonl"
    with export_path.open("w", encoding="utf-8") as f:
        for item in detailed:
            if not isinstance(item, dict):
                continue
            steps = item.get("step_records", [])
            actions = item.get("actions", [])
            if trajectory_format == "art":
                record = {
                    "id": item.get("task_id", ""),
                    "environment": item.get("environment", ""),
                    "success": bool(item.get("success", False)),
                    "reward": _metric_value(item, "reward"),
                    "messages": _messages_from_steps(steps),
                    "metadata": {
                        "steps_taken": item.get("steps_taken", 0),
                        "duration_ms": item.get("duration_ms", 0),
                        "error": item.get("error"),
                    },
                }
            else:
                record = {
                    "group_id": item.get("task_id", ""),
                    "prompt": f"AgentBench task {item.get('task_id', '')} in {item.get('environment', '')}",
                    "completion": "\n".join(str(a) for a in actions if a is not None),
                    "reward": _metric_value(item, "reward"),
                    "success": bool(item.get("success", False)),
                    "metadata": {
                        "environment": item.get("environment", ""),
                        "steps_taken": item.get("steps_taken", 0),
                    },
                }
            f.write(json.dumps(record, sort_keys=True) + "\n")

    return export_path


def _metric_value(item: dict, key: str) -> float:
    metrics = item.get("metrics", {})
    if isinstance(metrics, dict):
        value = metrics.get(key, 0.0)
        if isinstance(value, (int, float)):
            return float(value)
    return 0.0


def _messages_from_steps(steps: object) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if not isinstance(steps, list):
        return messages
    for step in steps:
        if not isinstance(step, dict):
            continue
        action = step.get("action", "")
        observation = step.get("observation", "")
        messages.append({"role": "assistant", "content": str(action)})
        messages.append({"role": "environment", "content": str(observation)})
    return messages
