"""Trajectory helpers for the Solana benchmark."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _compact_text(value: str, *, limit: int = 1200) -> str:
    if len(value) <= limit:
        return value
    head = limit // 2
    tail = limit - head - 32
    return f"{value[:head]}\n...[truncated]...\n{value[-tail:]}"


def make_trajectory_event(
    *,
    run_id: str,
    step: int,
    phase: str,
    template: str,
    reward: float,
    total_reward: float,
    success: bool,
    harness: str,
    prompt: str = "",
    response: str = "",
    info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a JSON-serializable Solana trajectory event."""

    event: dict[str, Any] = {
        "schema": "solana_trajectory_v1",
        "run_id": run_id,
        "timestamp": datetime.now(UTC).isoformat(),
        "step": step,
        "phase": phase,
        "template": template,
        "reward": reward,
        "total_reward": total_reward,
        "success": success,
        "harness": harness,
        "prompt": _compact_text(prompt),
        "prompt_chars": len(prompt),
        "response": _compact_text(response),
        "response_chars": len(response),
    }
    if info:
        event["info"] = info
        unique = info.get("unique_instructions")
        if isinstance(unique, dict):
            event["unique_instructions"] = unique
    return event


def append_trajectory_event(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=True, sort_keys=True))
        handle.write("\n")


def read_trajectory_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parsed = json.loads(line)
        if isinstance(parsed, dict):
            events.append(parsed)
    return events
