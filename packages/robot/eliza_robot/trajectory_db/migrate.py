"""Migration script for the unified trajectory database.

Creates or upgrades the SQLite schema.  Safe to run multiple times -- all DDL
uses ``CREATE ... IF NOT EXISTS``.

Usage::

    python -m eliza_robot.trajectory_db.migrate [--db path/to/trajectories.db]

When called with ``--import-jsonl <file>``, it will additionally import
trajectories from an existing JSONL export.
"""

from __future__ import annotations

import argparse
import os

from eliza_robot.trajectory_db.db import TrajectoryDB


def run_migration(db_path: str, *, verbose: bool = True) -> TrajectoryDB:
    """Create / upgrade the schema and return an open :class:`TrajectoryDB`."""
    db = TrajectoryDB(db_path)
    db.initialize()
    if verbose:
        print(f"[migrate] Schema ready at {db_path}")
        stats = db.get_stats()
        print(f"[migrate] Current row counts:")
        for key in sorted(stats):
            if key.endswith("_count"):
                print(f"  {key}: {stats[key]}")
    return db


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Migrate / create trajectory DB")
    parser.add_argument(
        "--db",
        default=os.environ.get("ELIZA_ROBOT_TRAJ_DB", "trajectories.db"),
        help=(
            "Path to the SQLite database file "
            "(default: $ELIZA_ROBOT_TRAJ_DB or trajectories.db)"
        ),
    )
    parser.add_argument(
        "--import-jsonl",
        default=None,
        help="Optionally import trajectories from a JSONL file after migration",
    )
    args = parser.parse_args(argv)

    db = run_migration(args.db)

    if args.import_jsonl:
        print(f"[migrate] Importing from {args.import_jsonl} ...")
        count = db.import_from_json(args.import_jsonl)
        print(f"[migrate] Imported {count} trajectories")

    db.close()


if __name__ == "__main__":
    main()
