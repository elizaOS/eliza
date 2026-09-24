"""Evaluate normalized Eliza replay artifacts for orchestrator benchmarking."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ReplayStats:
    success: bool | None
    event_count: int
    llm_event_count: int
    tool_event_count: int
    decision_event_count: int
    duration_ms: float | None


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _to_ms(ts: str | None) -> float | None:
    if not ts or not isinstance(ts, str):
        return None
    try:
        # Handles ISO timestamps ending with Z.
        normalized = ts.replace("Z", "+00:00")
        from datetime import datetime

        return datetime.fromisoformat(normalized).timestamp() * 1000.0
    except (ValueError, TypeError, AttributeError):
        return None


def analyze_artifact(path: Path) -> ReplayStats | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None

    root = _as_dict(data)
    events_raw = root.get("events")
    if not isinstance(events_raw, list):
        return None

    events = [_as_dict(item) for item in events_raw]
    success = None
    outcome = _as_dict(root.get("outcome"))
    if isinstance(outcome.get("success"), bool):
        success = bool(outcome["success"])

    event_count = len(events)
    llm_event_count = 0
    tool_event_count = 0
    decision_event_count = 0
    first_ts_ms: float | None = None
    last_ts_ms: float | None = None

    for event in events:
        kind = str(event.get("kind", "")).strip().lower()
        if kind == "llm" or isinstance(event.get("llm"), dict):
            llm_event_count += 1
        if kind == "tool" or isinstance(event.get("tool_call"), dict):
            tool_event_count += 1
        if kind == "decision" or isinstance(event.get("decision_type"), str):
            decision_event_count += 1

        ts_ms = _to_ms(event.get("ts") if isinstance(event.get("ts"), str) else None)
        if ts_ms is None:
            continue
        if first_ts_ms is None or ts_ms < first_ts_ms:
            first_ts_ms = ts_ms
        if last_ts_ms is None or ts_ms > last_ts_ms:
            last_ts_ms = ts_ms

    duration_ms = (
        max(0.0, last_ts_ms - first_ts_ms)
        if first_ts_ms is not None and last_ts_ms is not None
        else None
    )

    return ReplayStats(
        success=success,
        event_count=event_count,
        llm_event_count=llm_event_count,
        tool_event_count=tool_event_count,
        decision_event_count=decision_event_count,
        duration_ms=duration_ms,
    )


def _collect_inputs(input_path: Path, pattern: str) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    if input_path.is_dir():
        return sorted([p for p in input_path.rglob(pattern) if p.is_file()])
    return []


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Score normalized Eliza replay artifacts.",
    )
    parser.add_argument(
        "--input",
        type=str,
        required=True,
        help="Path to one replay artifact file or directory of replay artifacts.",
    )
    parser.add_argument(
        "--glob",
        type=str,
        default="*.replay.json",
        help="Glob used when --input points to a directory.",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Output JSON path.",
    )
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not input_path.exists():
        print(f"error: input path does not exist: {input_path}", flush=True)
        return 1

    candidates = _collect_inputs(input_path, args.glob)
    if not candidates:
        print(f"error: no replay artifacts matched in: {input_path}", flush=True)
        return 1

    stats: list[ReplayStats] = []
    evaluated_files: list[str] = []
    for candidate in candidates:
        item = analyze_artifact(candidate)
        if item is None:
            continue
        stats.append(item)
        evaluated_files.append(str(candidate))

    run_count = len(stats)
    success_known = [item.success for item in stats if item.success is not None]
    success_count = sum(1 for value in success_known if value)
    success_rate = (
        float(success_count) / float(len(success_known)) if success_known else None
    )

    avg_event_count = (
        sum(item.event_count for item in stats) / run_count if run_count > 0 else 0.0
    )
    avg_llm_events = (
        sum(item.llm_event_count for item in stats) / run_count if run_count > 0 else 0.0
    )
    avg_tool_events = (
        sum(item.tool_event_count for item in stats) / run_count if run_count > 0 else 0.0
    )
    avg_decision_events = (
        sum(item.decision_event_count for item in stats) / run_count
        if run_count > 0
        else 0.0
    )

    durations = [item.duration_ms for item in stats if item.duration_ms is not None]
    avg_duration_ms = sum(durations) / len(durations) if durations else None

    result = {
        "benchmark": "eliza_replay",
        "score": success_rate,
        "unit": "ratio",
        "higher_is_better": True,
        "metrics": {
            "runs_total": run_count,
            "runs_with_outcome": len(success_known),
            "runs_successful": success_count,
            "success_rate": success_rate,
            "avg_event_count": avg_event_count,
            "avg_llm_event_count": avg_llm_events,
            "avg_tool_event_count": avg_tool_events,
            "avg_decision_event_count": avg_decision_events,
            "avg_duration_ms": avg_duration_ms,
        },
        "evaluated_files": evaluated_files,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
