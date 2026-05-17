"""Tests for legacy trace migration utilities."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_PYTHON_PKG = _ROOT / "packages" / "python"
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
sys.path.insert(0, str(_ROOT))
if _PYTHON_PKG.exists():
    sys.path.insert(0, str(_PYTHON_PKG))
if _ORCH_PKG.exists():
    sys.path.insert(0, str(_ORCH_PKG))

from benchmarks.swe_bench.orchestrator.trace_migration import (
    migrate_trace_directory,
    migrate_trace_payload,
)


def test_migrate_trace_payload_adds_schema_and_capability_defaults() -> None:
    legacy = {
        "instance_id": "repo__repo-1",
        "provider_id": "swe-agent",
        "events": [{"event": "instance_start"}],
    }
    migrated = migrate_trace_payload(legacy)
    assert migrated["schema_version"] == "2.0"
    assert migrated["capability_evidence"]["required"] == []
    assert migrated["event_count"] == 1


def test_migrate_trace_directory_dry_run(tmp_path: Path) -> None:
    trace_path = tmp_path / "sample.trace.json"
    with open(trace_path, "w", encoding="utf-8") as handle:
        json.dump({"instance_id": "x", "events": []}, handle)

    summary = migrate_trace_directory(tmp_path, write=False)
    assert summary == {"total": 1, "changed": 1}

    with open(trace_path, encoding="utf-8") as handle:
        payload = json.load(handle)
    assert "schema_version" not in payload
