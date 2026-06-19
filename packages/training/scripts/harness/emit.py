"""Canonical record writer for the harness.

One file per action under `data/synthesized/harness/<action>.jsonl`.
Append-only. Keyed by (action, scenario_idx) so resumes don't double-write.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
HARNESS_OUT = ROOT / "data" / "synthesized" / "harness"
FAILURES_PATH = HARNESS_OUT / "failures.jsonl"
MANIFEST_PATH = HARNESS_OUT / "manifest.json"


def out_path_for(action: str) -> Path:
    HARNESS_OUT.mkdir(parents=True, exist_ok=True)
    return HARNESS_OUT / f"{action}.jsonl"


def existing_keys(action: str) -> set[str]:
    """Return scenario_ids already emitted for this action."""
    p = out_path_for(action)
    if not p.exists():
        return set()
    keys: set[str] = set()
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            md = rec.get("metadata") or {}
            sid = md.get("harness_scenario_id")
            if sid:
                keys.add(sid)
    return keys


def append_record(action: str, record: dict[str, Any]) -> None:
    p = out_path_for(action)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
        f.write("\n")


def append_failure(payload: dict[str, Any]) -> None:
    HARNESS_OUT.mkdir(parents=True, exist_ok=True)
    with FAILURES_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False))
        f.write("\n")


def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {"actions": {}}
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"actions": {}}


def save_manifest(manifest: dict[str, Any]) -> None:
    HARNESS_OUT.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
