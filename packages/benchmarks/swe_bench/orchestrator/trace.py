"""
Trace capture for orchestrated SWE-bench runs.

Stores a complete per-run event stream so users can audit what the
orchestrator and providers actually did (no hidden steps).
"""

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


def _now_ms() -> int:
    return int(time.time() * 1000)


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value)


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
        for k, v in value.items():
            normalized[str(k)] = _normalize_trace_value(v)
        return normalized
    return str(value)


def normalize_trace_data(data: dict[str, object]) -> dict[str, TraceValue]:
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


class RunTraceRecorder:
    """Collects and persists a full execution trace for one provider run."""

    def __init__(
        self,
        *,
        instance_id: str,
        provider_id: str,
        output_dir: str,
    ) -> None:
        self.instance_id = instance_id
        self.provider_id = provider_id
        self.output_dir = output_dir
        self.started_at_ms = _now_ms()
        self.schema_version = "2.0"
        self.events: list[TraceEvent] = []
        self.capability_evidence: dict[str, TraceValue] = {}
        self._trace_file: str | None = None

    def add(self, actor: str, event: str, data: dict[str, object] | None = None) -> None:
        payload = normalize_trace_data(data or {})
        self.events.append(
            TraceEvent(
                at_ms=_now_ms(),
                actor=actor,
                event=event,
                data=payload,
            )
        )

    async def add_async(
        self, actor: str, event: str, data: dict[str, object] | None = None
    ) -> None:
        self.add(actor=actor, event=event, data=data)

    def set_capability_evidence(
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
        traces_dir = Path(self.output_dir)
        traces_dir.mkdir(parents=True, exist_ok=True)

        filename = (
            f"{_safe_name(self.instance_id)}--{_safe_name(self.provider_id)}"
            f"--{self.started_at_ms}.trace.json"
        )
        path = traces_dir / filename

        payload: dict[str, TraceValue] = {
            "schema_version": self.schema_version,
            "instance_id": self.instance_id,
            "provider_id": self.provider_id,
            "started_at_ms": self.started_at_ms,
            "event_count": len(self.events),
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
        }

        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

        self._trace_file = str(path)
        return self._trace_file

    @property
    def trace_file(self) -> str | None:
        return self._trace_file
