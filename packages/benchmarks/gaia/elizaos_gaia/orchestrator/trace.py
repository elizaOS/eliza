"""Trace recorder for orchestrated GAIA question runs."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path


TraceValue = (
    str
    | int
    | float
    | bool
    | None
    | list["TraceValue"]
    | dict[str, "TraceValue"]
)


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _normalize_trace_value(value: object) -> TraceValue:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return [_normalize_trace_value(v) for v in value]
    if isinstance(value, dict):
        normalized: dict[str, TraceValue] = {}
        for key, item in value.items():
            normalized[str(key)] = _normalize_trace_value(item)
        return normalized
    return str(value)


def _normalize_trace_data(data: dict[str, object]) -> dict[str, TraceValue]:
    normalized: dict[str, TraceValue] = {}
    for key, value in data.items():
        normalized[str(key)] = _normalize_trace_value(value)
    return normalized


@dataclass
class TraceEvent:
    at_ms: int
    actor: str
    event: str
    data: dict[str, TraceValue] = field(default_factory=dict)


class GAIATraceRecorder:
    def __init__(
        self,
        *,
        task_id: str,
        provider_id: str,
        mode: str,
        output_dir: str,
    ) -> None:
        self.task_id = task_id
        self.provider_id = provider_id
        self.mode = mode
        self.output_dir = output_dir
        self.started_at_ms = _now_ms()
        self.schema_version = "2.0"
        self.events: list[TraceEvent] = []
        self.capability_evidence: dict[str, TraceValue] = {}
        self._trace_file: str | None = None

    def add(self, actor: str, event: str, data: dict[str, object] | None = None) -> None:
        payload = _normalize_trace_data(data or {})
        self.events.append(
            TraceEvent(
                at_ms=_now_ms(),
                actor=actor,
                event=event,
                data=payload,
            )
        )

    def set_capabilities(
        self,
        *,
        required: list[str],
        declared: list[str],
        observed: list[str],
        violations: list[str],
    ) -> None:
        self.capability_evidence = {
            "required": list(required),
            "declared": list(declared),
            "observed": list(observed),
            "violations": list(violations),
        }

    def save(self) -> str:
        path = Path(self.output_dir)
        path.mkdir(parents=True, exist_ok=True)
        filename = (
            f"{_safe_name(self.task_id)}--{_safe_name(self.provider_id)}--"
            f"{_safe_name(self.mode)}--{self.started_at_ms}.trace.json"
        )
        trace_path = path / filename
        payload: dict[str, TraceValue] = {
            "schema_version": self.schema_version,
            "task_id": self.task_id,
            "provider_id": self.provider_id,
            "mode": self.mode,
            "started_at_ms": self.started_at_ms,
            "ended_at_ms": _now_ms(),
            "capability_evidence": self.capability_evidence,
            "events": [
                {
                    "at_ms": event.at_ms,
                    "actor": event.actor,
                    "event": event.event,
                    "data": event.data,
                }
                for event in self.events
            ],
            "event_count": len(self.events),
        }
        with open(trace_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        self._trace_file = str(trace_path)
        return self._trace_file

    @property
    def trace_file(self) -> str | None:
        return self._trace_file
