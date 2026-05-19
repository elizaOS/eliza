#!/usr/bin/env python3
"""Import Hyperscape planner trajectories from the JSONL export.

Reads the JSONL output produced by the TypeScript export script
(``hyperscape/packages/server/scripts/export-planner-trajectories.ts``)
and normalises each trajectory into the unified SQLite schema.

The export format (``hyperscape-planner-export-v1``) stores steps as a JSON
blob (``steps``).  This script breaks each step apart, maps camelCase field
names to snake_case, and inserts normalised rows into ``trajectory_steps``,
``llm_calls``, and ``provider_accesses``.

Usage::

    python -m eliza_robot.trajectory_db.import_hyperscape \\
        --input end_to_end_outputs/planner/hyperscape_planner_trajectories.jsonl \\
        --db trajectories.db
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from uuid import uuid4

from eliza_robot.trajectory_db.db import TrajectoryDB, _camel_to_snake, _normalize_keys


def _new_id() -> str:
    return uuid4().hex


def _normalise_step(raw: dict, index: int) -> dict:
    """Convert a single step from the export format to the insert format."""
    s = _normalize_keys(raw, _camel_to_snake)

    step_id = s.get("step_id") or _new_id()
    step_number = s.get("step_number", index)

    # The export may have nested action dict or flat action fields
    action_raw = s.get("action") or {}
    if isinstance(action_raw, dict):
        action_raw = _normalize_keys(action_raw, _camel_to_snake)

    llm_calls_raw = s.get("llm_calls", [])
    provider_accesses_raw = s.get("provider_accesses", [])

    normalised: dict = {
        "step_id": step_id,
        "step_number": step_number,
        "timestamp": s.get("timestamp"),
        "observation": s.get("observation") or s.get("environment_state") or {},
        "environment_state": s.get("environment_state") or {},
        "action_type": action_raw.get("action_type", ""),
        "action_name": action_raw.get("action_name", ""),
        "action_params_json": action_raw.get("parameters") or {},
        "action_success": action_raw.get("success", True),
        "action_result_json": action_raw.get("result"),
        "reward": s.get("reward", 0.0),
        "done": s.get("done", False),
        "reasoning": action_raw.get("reasoning") or s.get("reasoning"),
        "metadata": s.get("metadata"),
    }

    # Preserve nested records for the caller to insert separately
    normalised["_llm_calls"] = llm_calls_raw
    normalised["_provider_accesses"] = provider_accesses_raw

    return normalised


def import_jsonl(db: TrajectoryDB, jsonl_path: str, *, verbose: bool = True) -> int:
    """Read a JSONL file and insert all trajectories.

    Returns the count of trajectories imported.
    """
    path = Path(jsonl_path)
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {jsonl_path}")

    lines = path.read_text(encoding="utf-8").strip().splitlines()
    count = 0

    for line_no, line in enumerate(lines, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            if verbose:
                print(f"[import] Skipping line {line_no}: {exc}")
            continue

        r = _normalize_keys(record, _camel_to_snake)

        # Extract steps blob before inserting the trajectory row.
        # Pop BOTH variants to prevent insert_trajectory from re-inserting.
        steps_raw = r.pop("steps", None)
        steps_json_raw = r.pop("steps_json", None)
        steps_raw = steps_raw or steps_json_raw or []
        if isinstance(steps_raw, str):
            try:
                steps_raw = json.loads(steps_raw)
            except (json.JSONDecodeError, TypeError):
                steps_raw = []

        # Metadata enrichment: store trace linkage from the export
        metadata = r.get("metadata") or {}
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except (json.JSONDecodeError, TypeError):
                metadata = {}
        trace_id = r.pop("trace_id", None) or r.pop("_trace_id", None)
        planner_step_id = r.pop("planner_step_id", None) or r.pop("_planner_step_id", None)
        if trace_id:
            metadata["trace_id"] = trace_id
        if planner_step_id:
            metadata["planner_step_id"] = planner_step_id
        r["metadata"] = metadata

        # Remove internal keys
        r.pop("_schema_version", None)
        r.pop("schema_version", None)
        r.pop("_steps", None)

        # Insert trajectory
        trajectory_id = db.insert_trajectory(r)

        # Insert normalised steps
        for idx, step_raw in enumerate(steps_raw):
            if not isinstance(step_raw, dict):
                continue
            step = _normalise_step(step_raw, idx)

            llm_calls = step.pop("_llm_calls", [])
            provider_accesses = step.pop("_provider_accesses", [])

            step_id = db.insert_step(trajectory_id, step)

            # Insert LLM calls
            for ci, lc_raw in enumerate(llm_calls or []):
                if not isinstance(lc_raw, dict):
                    continue
                lc = _normalize_keys(lc_raw, _camel_to_snake)
                lc.setdefault("call_index", ci)
                db.insert_llm_call(step_id, trajectory_id, lc)

            # Insert provider accesses
            for pa_raw in (provider_accesses or []):
                if not isinstance(pa_raw, dict):
                    continue
                db.insert_provider_access(step_id, trajectory_id, pa_raw)

        count += 1
        if verbose and count % 50 == 0:
            print(f"[import] ... {count} trajectories imported")

    if verbose:
        print(f"[import] Done: {count} trajectories from {jsonl_path}")
    return count


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Import Hyperscape planner trajectories into the unified SQLite DB"
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Path to the JSONL file exported by export-planner-trajectories.ts",
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("ELIZA_ROBOT_TRAJ_DB", "trajectories.db"),
        help=(
            "Path to the SQLite database file "
            "(default: $ELIZA_ROBOT_TRAJ_DB or trajectories.db)"
        ),
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress progress messages",
    )
    args = parser.parse_args(argv)

    db = TrajectoryDB(args.db)
    db.initialize()

    try:
        count = import_jsonl(db, args.input, verbose=not args.quiet)
    finally:
        db.close()

    if not args.quiet:
        print(f"Total imported: {count}")


if __name__ == "__main__":
    main()
