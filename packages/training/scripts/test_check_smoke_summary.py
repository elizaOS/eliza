from __future__ import annotations

import json
import os
import time
from pathlib import Path

from check_smoke_summary import candidate_paths, validate_smoke_summary


def _write_summary(root: Path, registry_key: str, payload: dict) -> Path:
    path = candidate_paths(registry_key, root)[0]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))
    return path


def _passing_payload(**overrides):
    payload = {
        "schemaVersion": 2,
        "status": "pass",
        "applicable_passed_pct": 100.0,
        "applicable_steps": ["deps", "sft", "bench-sft"],
        "passed_steps": ["deps", "sft", "bench-sft"],
        "failed_steps": [],
        "skipped_incompatible_steps": ["fused-tq", "bench-fused-tq"],
        "skipped_tooling_steps": ["qjl", "bench-qjl"],
    }
    payload.update(overrides)
    return payload


def test_validate_smoke_summary_accepts_architecture_aware_pass(tmp_path: Path):
    _write_summary(tmp_path, "gemma4-e2b", _passing_payload())

    ok, detail = validate_smoke_summary(
        "gemma4-e2b",
        max_age_hours=24,
        min_applicable_pct=80,
        root=tmp_path,
    )

    assert ok is True
    assert detail["status"] == "pass"
    assert detail["skipped_incompatible_steps"] == ["fused-tq", "bench-fused-tq"]


def test_validate_smoke_summary_rejects_missing_file(tmp_path: Path):
    ok, detail = validate_smoke_summary(
        "gemma4-e2b",
        max_age_hours=24,
        min_applicable_pct=80,
        root=tmp_path,
    )

    assert ok is False
    assert detail["status"] == "fail"
    assert "no smoke_summary.json" in detail["reason"]


def test_validate_smoke_summary_rejects_legacy_schema(tmp_path: Path):
    _write_summary(tmp_path, "gemma4-e2b", {"schemaVersion": 1})

    ok, detail = validate_smoke_summary(
        "gemma4-e2b",
        max_age_hours=24,
        min_applicable_pct=80,
        root=tmp_path,
    )

    assert ok is False
    assert "schemaVersion=1" in detail["reason"]


def test_validate_smoke_summary_rejects_stale_summary(tmp_path: Path):
    path = _write_summary(tmp_path, "gemma4-e2b", _passing_payload())
    old = time.time() - 49 * 3600
    os.utime(path, (old, old))

    ok, detail = validate_smoke_summary(
        "gemma4-e2b",
        max_age_hours=24,
        min_applicable_pct=80,
        root=tmp_path,
    )

    assert ok is False
    assert "old > 24" in detail["reason"]


def test_validate_smoke_summary_rejects_failed_status(tmp_path: Path):
    _write_summary(
        tmp_path,
        "gemma4-e2b",
        _passing_payload(status="fail", failed_steps=["bench-sft"]),
    )

    ok, detail = validate_smoke_summary(
        "gemma4-e2b",
        max_age_hours=24,
        min_applicable_pct=80,
        root=tmp_path,
    )

    assert ok is False
    assert "failed_steps=['bench-sft']" in detail["reason"]


def test_validate_smoke_summary_rejects_low_applicable_pct(tmp_path: Path):
    _write_summary(tmp_path, "gemma4-e2b", _passing_payload(applicable_passed_pct=75.0))

    ok, detail = validate_smoke_summary(
        "gemma4-e2b",
        max_age_hours=24,
        min_applicable_pct=80,
        root=tmp_path,
    )

    assert ok is False
    assert "75.0 < 80" in detail["reason"]
