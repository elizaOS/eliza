#!/usr/bin/env python3
"""Tests for scripts/check_multi_pdk_closure.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check_multi_pdk_closure.py"
CLOSURE = ROOT / "docs/evidence/process/multi-pdk-closure.yaml"

spec = importlib.util.spec_from_file_location("check_multi_pdk_closure", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {SCRIPT}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def load_closure() -> dict[str, object]:
    data = yaml.safe_load(CLOSURE.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise AssertionError("closure file must be a mapping")
    return data


def lanes(doc: dict[str, object], key: str) -> list[dict[str, object]]:
    section = doc.get(key)
    if not isinstance(section, list):
        return []
    return [item for item in section if isinstance(item, dict)]


def test_live_closure_passes() -> None:
    assert checker.main() == 0


def test_schema_marker_present() -> None:
    assert load_closure().get("schema") == checker.CLOSURE_SCHEMA


def test_all_required_lanes_present() -> None:
    doc = load_closure()
    open_ids = {lane.get("id") for lane in lanes(doc, "open_pdk_lanes")}
    advanced_ids = {lane.get("id") for lane in lanes(doc, "advanced_lanes_blocked")}
    assert set(checker.OPEN_LANES) <= open_ids
    assert set(checker.ADVANCED_LANES) <= advanced_ids


def test_every_referenced_run_artifact_exists() -> None:
    doc = load_closure()
    for section in ("open_pdk_lanes", "predictive_lanes"):
        for lane in lanes(doc, section):
            artifact = lane.get("last_run_artifact")
            if isinstance(artifact, str):
                assert (ROOT / artifact).exists(), f"{lane.get('id')}: stale artifact {artifact}"


def test_advanced_lanes_have_no_run_artifacts() -> None:
    doc = load_closure()
    for lane in lanes(doc, "advanced_lanes_blocked"):
        assert lane.get("last_run_artifact") in (None, ""), (
            f"{lane.get('id')}: advanced lane must not carry a run artifact"
        )
        assert lane.get("status") == checker.STATUS_BLOCKED


def test_open_lane_manifests_match_portability_index() -> None:
    rows = checker.index_by_pdk()
    doc = load_closure()
    for lane in lanes(doc, "open_pdk_lanes"):
        pdk = checker.OPEN_LANES.get(lane.get("id", ""))
        assert pdk is not None
        row = rows[pdk]
        for field in ("config", "library_manifest", "corner_manifest"):
            assert lane.get(field) == row.get(field), (
                f"{lane.get('id')}: {field} drift vs portability index"
            )


def test_check_run_artifact_flags_missing_path() -> None:
    errors: list[str] = []
    checker.check_run_artifact(
        {"id": "sky130A", "last_run_artifact": "pd/openlane/runs/DOES_NOT_EXIST/metrics.json"},
        errors,
    )
    assert any("missing on disk" in e for e in errors)


if __name__ == "__main__":
    import sys

    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failed += 1
                print(f"FAIL {name}: {exc}")
    sys.exit(1 if failed else 0)
