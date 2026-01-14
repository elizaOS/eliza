from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from elizaos_plugin_trajectory_logger.art_format import group_trajectories, to_art_trajectory
from elizaos_plugin_trajectory_logger.types import Trajectory


@dataclass(frozen=True)
class ExportOptions:
    dataset_name: str
    trajectories: list[Trajectory]
    max_trajectories: int | None = None
    output_path: str | None = None
    output_dir: str | None = None


@dataclass(frozen=True)
class ExportResult:
    success: bool
    trajectories_exported: int
    dataset_url: str | None = None
    error: str | None = None


def export_for_openpipe_art(options: ExportOptions) -> ExportResult:
    out_path = _resolve_output_path(options, "trajectories.art.jsonl")
    trajs = (
        options.trajectories[: options.max_trajectories]
        if options.max_trajectories
        else options.trajectories
    )

    lines = (
        "\n".join(json.dumps(to_art_trajectory(t).model_dump(mode="json")) for t in trajs) + "\n"
    )
    _write_text(out_path, lines)

    return ExportResult(
        success=True,
        trajectories_exported=len(trajs),
        dataset_url=str(out_path),
    )


def export_grouped_for_grpo(options: ExportOptions) -> ExportResult:
    out_path = _resolve_output_path(options, "trajectories.grpo.groups.json")
    trajs = (
        options.trajectories[: options.max_trajectories]
        if options.max_trajectories
        else options.trajectories
    )

    groups = group_trajectories(trajs)
    _write_text(out_path, json.dumps([g.model_dump(mode="json") for g in groups], indent=2) + "\n")

    return ExportResult(
        success=True,
        trajectories_exported=len(trajs),
        dataset_url=str(out_path),
    )


def _resolve_output_path(options: ExportOptions, filename: str) -> Path:
    if options.output_path:
        return Path(options.output_path)
    if options.output_dir:
        return Path(options.output_dir) / filename
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in options.dataset_name)
    return Path.cwd() / f"{safe}.{filename}"


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
