"""Trace recording for SWE-bench orchestrated runs."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class RunTraceRecorder:
    def __init__(self, *, instance_id: str, provider_id: str, output_dir: str) -> None:
        self.instance_id = instance_id
        self.provider_id = provider_id
        self.output_dir = Path(output_dir)
        self.events: list[dict[str, Any]] = []
        self.capability_evidence = {
            "required": [],
            "declared": [],
            "observed": [],
            "violations": [],
        }

    def set_capability_evidence(
        self,
        *,
        required: list[str],
        declared: list[str],
        observed: list[str],
        violations: list[str],
    ) -> None:
        self.capability_evidence = {
            "required": required,
            "declared": declared,
            "observed": observed,
            "violations": violations,
        }

    def add(self, actor: str, event: str, data: dict[str, Any]) -> None:
        self.events.append(
            {
                "ts": time.time(),
                "actor": actor,
                "event": event,
                "data": data,
            }
        )

    def payload(self) -> dict[str, Any]:
        return {
            "schema_version": "2.0",
            "instance_id": self.instance_id,
            "provider_id": self.provider_id,
            "capability_evidence": self.capability_evidence,
            "event_count": len(self.events),
            "events": self.events,
        }

    def save(self) -> str:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        path = self.output_dir / f"{self.instance_id}.{self.provider_id}.trace.json"
        path.write_text(json.dumps(self.payload(), indent=2), encoding="utf-8")
        return str(path)
