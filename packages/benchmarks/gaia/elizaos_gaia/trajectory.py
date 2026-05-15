"""Trajectory artifact emission for GAIA runs."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict
from pathlib import Path

from elizaos_gaia.types import GAIABenchmarkResults, GAIAResult


def _jsonable(value: object) -> object:
    if hasattr(value, "__dataclass_fields__"):
        return _jsonable(asdict(value))
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "value"):
        return value.value
    return value


def canonical_trajectory_record(
    result: GAIAResult,
    *,
    metadata: Mapping[str, object],
    run_kind: str,
) -> dict[str, object]:
    """Build a stable, harness-neutral trajectory record for one task."""
    steps = [_jsonable(step) for step in result.steps_taken]
    return {
        "schema": "elizaos.gaia.trajectory.v1",
        "run_kind": run_kind,
        "task_id": result.task_id,
        "level": result.level.value,
        "harness": metadata.get("benchmark_harness", metadata.get("harness", "eliza")),
        "harness_backend": metadata.get("harness_backend"),
        "provider": metadata.get("provider"),
        "model": metadata.get("model"),
        "model_identifier": metadata.get("model_identifier"),
        "question": result.question,
        "final_answer": result.expected_answer,
        "predicted_answer": result.predicted_answer,
        "is_correct": result.is_correct,
        "latency_ms": result.latency_ms,
        "token_usage": result.token_usage,
        "error": result.error,
        "tools_used": [_jsonable(tool) for tool in result.tools_used],
        "steps": steps,
    }


def native_trajectory_record(
    result: GAIAResult,
    *,
    metadata: Mapping[str, object],
    run_kind: str,
) -> dict[str, object]:
    """Build a native adapter-shaped trajectory record for one task."""
    return {
        "schema": "elizaos.gaia.native_trajectory.v1",
        "run_kind": run_kind,
        "task_id": result.task_id,
        "harness": metadata.get("benchmark_harness", metadata.get("harness", "eliza")),
        "harness_backend": metadata.get("harness_backend"),
        "adapter_steps": [_jsonable(step) for step in result.steps_taken],
        "raw_result": _jsonable(result),
    }


def write_trajectory_artifacts(
    results: GAIABenchmarkResults,
    output_dir: Path,
    *,
    timestamp: str,
    run_kind: str = "gaia",
    latest: bool = True,
) -> dict[str, str]:
    """Write canonical JSONL and native JSON trajectory artifacts."""
    output_dir.mkdir(parents=True, exist_ok=True)
    canonical_path = output_dir / f"{run_kind}-trajectories_{timestamp}.jsonl"
    native_path = output_dir / f"{run_kind}-native-trajectories_{timestamp}.json"

    metadata = results.metadata
    with canonical_path.open("w", encoding="utf-8") as fh:
        for result in results.results:
            record = canonical_trajectory_record(result, metadata=metadata, run_kind=run_kind)
            fh.write(json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n")

    native_payload = {
        "schema": "elizaos.gaia.native_trajectories.v1",
        "run_kind": run_kind,
        "metadata": _jsonable(metadata),
        "trajectories": [
            native_trajectory_record(result, metadata=metadata, run_kind=run_kind)
            for result in results.results
        ],
    }
    native_path.write_text(json.dumps(native_payload, indent=2, ensure_ascii=True), encoding="utf-8")

    paths = {
        "canonical": str(canonical_path),
        "native": str(native_path),
    }
    if latest:
        latest_canonical = output_dir / f"{run_kind}-trajectories-latest.jsonl"
        latest_native = output_dir / f"{run_kind}-native-trajectories-latest.json"
        latest_canonical.write_text(canonical_path.read_text(encoding="utf-8"), encoding="utf-8")
        latest_native.write_text(native_path.read_text(encoding="utf-8"), encoding="utf-8")
        paths["canonical_latest"] = str(latest_canonical)
        paths["native_latest"] = str(latest_native)
    return paths
