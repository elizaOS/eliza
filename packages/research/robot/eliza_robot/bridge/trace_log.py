"""Structured JSONL trace logging for bridge sessions."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from eliza_robot.bridge.types import JsonDict, JsonValue


@dataclass
class TraceLogger:
    """Thread-safe append-only JSONL logger."""

    path: Path

    def __post_init__(self) -> None:
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, record: JsonDict) -> None:
        encoded = json.dumps(record, ensure_ascii=True)
        with self._lock:
            with self.path.open("a", encoding="utf-8") as file:
                file.write(encoded + "\n")


def safe_to_record(value: JsonValue) -> JsonValue:
    """Ensure value is valid for structured JSON logs."""
    if isinstance(value, dict):
        output: dict[str, JsonValue] = {}
        for key, item in value.items():
            if isinstance(key, str):
                output[key] = safe_to_record(item)
        return output
    if isinstance(value, list):
        return [safe_to_record(item) for item in value]
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return str(value)

