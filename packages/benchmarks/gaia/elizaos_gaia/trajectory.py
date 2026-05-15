"""GAIA trajectory artifact writer."""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return _to_jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_jsonable(v) for v in value]
    if hasattr(value, "value"):
        return value.value
    if isinstance(value, Path):
        return str(value)
    return value


def write_trajectory_artifacts(
    results: object,
    output_dir: Path,
    *,
    timestamp: str,
    run_kind: str,
    latest: bool = True,
) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    canonical = output_dir / f"{run_kind}-trajectories-{timestamp}.jsonl"
    native = output_dir / f"{run_kind}-native-trajectories-{timestamp}.jsonl"

    rows = getattr(results, "results", [])
    with open(canonical, "w", encoding="utf-8") as handle:
        for result in rows:
            handle.write(json.dumps(_to_jsonable(result), default=str) + "\n")
    with open(native, "w", encoding="utf-8") as handle:
        for result in rows:
            handle.write(json.dumps(_to_jsonable(result), default=str) + "\n")

    paths = {"canonical": str(canonical), "native": str(native)}
    if latest:
        canonical_latest = output_dir / f"{run_kind}-trajectories-latest.jsonl"
        native_latest = output_dir / f"{run_kind}-native-trajectories-latest.jsonl"
        canonical_latest.write_text(canonical.read_text(encoding="utf-8"), encoding="utf-8")
        native_latest.write_text(native.read_text(encoding="utf-8"), encoding="utf-8")
        paths["canonical_latest"] = str(canonical_latest)
        paths["native_latest"] = str(native_latest)
    return paths
