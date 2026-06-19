from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping


def compact_text(value: str, *, limit: int = 1200) -> str:
    """Keep trajectory payloads inspectable without storing huge prompts twice."""
    if len(value) <= limit:
        return value
    head = max(0, limit - 80)
    return f"{value[:head]}\n... [truncated {len(value) - head} chars]"


def make_trajectory_event(
    *,
    run_id: str,
    step: int,
    phase: str,
    template: str,
    reward: int,
    total_reward: int,
    success: bool,
    harness: str,
    prompt: str | None = None,
    response: str | None = None,
    error: str | None = None,
    info: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "run_id": run_id,
        "step": step,
        "timestamp": datetime.now().isoformat(),
        "phase": phase,
        "template": template,
        "reward": reward,
        "total_reward": total_reward,
        "success": success,
        "harness": harness,
    }
    if prompt:
        event["prompt"] = compact_text(prompt)
        event["prompt_chars"] = len(prompt)
    if response:
        event["response"] = compact_text(response)
        event["response_chars"] = len(response)
    if error:
        event["error"] = compact_text(error, limit=600)
    if info:
        unique = info.get("unique_instructions")
        if isinstance(unique, Mapping):
            event["unique_instructions"] = {
                str(program): list(discs) if isinstance(discs, list) else discs
                for program, discs in unique.items()
            }
    return event


def append_trajectory_event(path: Path, event: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(dict(event), ensure_ascii=True, sort_keys=True) + "\n")


def read_trajectory_events(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
