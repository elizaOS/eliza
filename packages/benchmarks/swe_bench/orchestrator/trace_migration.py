"""Utilities to upgrade legacy orchestrator trace files to schema 2.0."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def migrate_trace_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Upgrade a single trace payload in-memory."""
    if "schema_version" in payload and "capability_evidence" in payload:
        return payload

    migrated = dict(payload)
    migrated.setdefault("schema_version", "2.0")
    migrated.setdefault(
        "capability_evidence",
        {
            "required": [],
            "declared": [],
            "observed": [],
            "violations": [],
        },
    )
    migrated.setdefault("event_count", len(migrated.get("events", [])))
    return migrated


def migrate_trace_file(path: Path, *, write: bool) -> bool:
    """Migrate one trace file. Returns True when changes are needed."""
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    migrated = migrate_trace_payload(payload)
    changed = migrated != payload
    if changed and write:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(migrated, handle, indent=2)
    return changed


def migrate_trace_directory(directory: Path, *, write: bool) -> dict[str, int]:
    """Migrate every `*.trace.json` file in a directory."""
    totals = {"total": 0, "changed": 0}
    for path in sorted(directory.glob("*.trace.json")):
        totals["total"] += 1
        if migrate_trace_file(path, write=write):
            totals["changed"] += 1
    return totals
