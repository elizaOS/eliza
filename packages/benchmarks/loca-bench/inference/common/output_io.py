"""Shared output file helpers for inference runners."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence


def build_task_workspace(
    base_task_dir: str | Path,
    config_name: Optional[str],
    config_id: int,
    run_id: int,
) -> Path:
    """Build a task workspace path under the common tasks directory."""
    base = Path(base_task_dir)
    if config_name:
        return base / config_name / f"state{run_id}"
    return base / f"config_{config_id}" / f"run_{run_id}"


def write_json_file(path: str | Path, data: Any, indent: int = 2) -> Path:
    """Write JSON to disk, creating parent directories as needed."""
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w") as f:
        json.dump(data, f, indent=indent)
    return file_path


def write_eval_file(
    task_workspace: str | Path,
    status: str,
    accuracy: float,
    steps: int,
    feedback: str,
) -> Path:
    """Write standardized eval.json under a task workspace."""
    eval_path = Path(task_workspace) / "eval.json"
    eval_data = {
        "status": status,
        "accuracy": accuracy,
        "steps": steps,
        "feedback": feedback,
    }
    return write_json_file(eval_path, eval_data, indent=2)


def write_trajectory_file(
    path: str | Path,
    envelope: Mapping[str, Any],
    legacy_payload: Optional[Mapping[str, Any]] = None,
    indent: int = 2,
) -> Path:
    """Write trajectory.json with a shared envelope and legacy-compatible fields."""
    output: Dict[str, Any] = dict(legacy_payload or {})
    output.update(dict(envelope))
    return write_json_file(path, output, indent=indent)


def write_results_file(
    path: str | Path,
    metadata: Mapping[str, Any],
    summary: Mapping[str, Any],
    per_config: Mapping[str, Any],
    extra: Optional[Mapping[str, Any]] = None,
    indent: int = 2,
) -> Path:
    """Write standardized results.json."""
    payload: Dict[str, Any] = {
        "metadata": dict(metadata),
        "summary": dict(summary),
        "per_config": dict(per_config),
    }
    if extra:
        payload.update(dict(extra))
    return write_json_file(path, payload, indent=indent)


def write_summary_file(
    path: str | Path,
    summary_payload: Mapping[str, Any],
    indent: int = 4,
) -> Path:
    """Write a full summary JSON payload."""
    return write_json_file(path, dict(summary_payload), indent=indent)


def write_all_trajectories_file(
    base_task_dir: str | Path,
    output_dir: str | Path,
    results: Sequence[Mapping[str, Any]],
    group_id_to_name: Optional[Mapping[int, str]] = None,
) -> Path:
    """Aggregate all per-task trajectories into all_trajectories.json."""
    task_root = Path(base_task_dir)
    aggregated: Dict[str, Dict[str, Any]] = {}
    group_map = group_id_to_name or {}

    for result in results:
        config_id = result.get("config_id", 0)
        run_id = result.get("run_id", 0)
        task_name = result.get("config_name") or group_map.get(config_id, f"config_{config_id}")
        state_key = f"state{run_id}"

        if task_name:
            traj_file = task_root / task_name / state_key / "trajectory.json"
        else:
            traj_file = task_root / f"config_{config_id}" / f"run_{run_id}" / "trajectory.json"

        if not traj_file.exists():
            continue

        try:
            with open(traj_file) as f:
                traj_data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        aggregated.setdefault(task_name, {})[state_key] = traj_data

    output_path = Path(output_dir) / "all_trajectories.json"
    return write_json_file(output_path, aggregated, indent=2)
