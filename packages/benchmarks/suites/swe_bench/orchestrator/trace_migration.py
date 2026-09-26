"""Legacy trace migration utilities."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def migrate_trace_payload(payload: dict[str, Any]) -> dict[str, Any]:
    migrated = dict(payload)
    migrated.setdefault("schema_version", "2.0")
    migrated.setdefault(
        "capability_evidence",
        {"required": [], "declared": [], "observed": [], "violations": []},
    )
    events = migrated.get("events")
    migrated["event_count"] = len(events) if isinstance(events, list) else 0
    return migrated


def migrate_trace_directory(directory: str | Path, *, write: bool = False) -> dict[str, int]:
    total = 0
    changed = 0
    for path in Path(directory).glob("*.trace.json"):
        total += 1
        payload = json.loads(path.read_text(encoding="utf-8"))
        migrated = migrate_trace_payload(payload)
        if migrated != payload:
            changed += 1
            if write:
                path.write_text(json.dumps(migrated, indent=2), encoding="utf-8")
    return {"total": total, "changed": changed}
