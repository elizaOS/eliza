"""GAIA trajectory artifact export helpers."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from elizaos_gaia.types import GAIABenchmarkResults, GAIAResult, StepRecord


def write_trajectory_artifacts(
    results: GAIABenchmarkResults,
    output_dir: str | Path,
    *,
    timestamp: str,
    run_kind: str = "gaia",
    latest: bool = False,
) -> dict[str, str]:
    """Write canonical JSONL and native JSON trajectory artifacts."""
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    canonical_path = out_dir / f"{run_kind}-trajectories-{timestamp}.jsonl"
    native_path = out_dir / f"{run_kind}-native-trajectories-{timestamp}.json"

    canonical_records = [
        _canonical_record(result, turn_index=index)
        for result in results.results
        for index in range(max(1, len(result.steps_taken)))
    ]
    native_records = [_native_record(result) for result in results.results]

    with canonical_path.open("w", encoding="utf-8") as handle:
        for record in canonical_records:
            handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

    native_path.write_text(
        json.dumps(native_records, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )

    payload = {
        "canonical": str(canonical_path),
        "native": str(native_path),
    }
    if latest:
        canonical_latest = out_dir / f"{run_kind}-trajectories-latest.jsonl"
        native_latest = out_dir / f"{run_kind}-native-trajectories-latest.json"
        canonical_latest.write_text(canonical_path.read_text(encoding="utf-8"), encoding="utf-8")
        native_latest.write_text(native_path.read_text(encoding="utf-8"), encoding="utf-8")
        payload["canonical_latest"] = str(canonical_latest)
        payload["native_latest"] = str(native_latest)

    return payload


def _canonical_record(result: GAIAResult, *, turn_index: int) -> dict[str, Any]:
    step = result.steps_taken[turn_index] if turn_index < len(result.steps_taken) else None
    return {
        "benchmark": "gaia",
        "task_id": result.task_id,
        "turn_index": turn_index,
        "role": "assistant",
        "content": result.predicted_answer,
        "expected": result.expected_answer,
        "is_correct": result.is_correct,
        "error": result.error,
        "latency_ms": result.latency_ms,
        "token_usage": result.token_usage,
        "step": _jsonable_step(step) if step is not None else None,
    }


def _native_record(result: GAIAResult) -> dict[str, Any]:
    return {
        "task_id": result.task_id,
        "level": result.level.value,
        "question": result.question,
        "predicted_answer": result.predicted_answer,
        "expected_answer": result.expected_answer,
        "is_correct": result.is_correct,
        "latency_ms": result.latency_ms,
        "token_usage": result.token_usage,
        "error": result.error,
        "steps": [_jsonable_step(step) for step in result.steps_taken],
        "tools_used": [tool.value for tool in result.tools_used],
    }


def _jsonable_step(step: StepRecord) -> dict[str, Any]:
    data = asdict(step)
    tool = data.get("tool_used")
    if hasattr(tool, "value"):
        data["tool_used"] = tool.value
    return data
