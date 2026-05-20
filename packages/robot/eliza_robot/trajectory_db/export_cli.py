"""CLI for exporting trajectory data in multiple formats.

Wraps :class:`~eliza_robot.trajectory_db.db.TrajectoryDB` export methods and
the fine-tuning formatter from :mod:`eliza_robot.datasets.format_for_finetuning`
into a single command-line tool.

Usage::

    # Export RLDS episodes
    python -m eliza_robot.trajectory_db.export_cli --format rlds --output data/rlds/

    # Export ART/OpenPipe format
    python -m eliza_robot.trajectory_db.export_cli --format art --output data/art.jsonl

    # Export OpenAI fine-tuning JSONL
    python -m eliza_robot.trajectory_db.export_cli --format openai --output data/finetune.jsonl

    # Export Alpaca-style LoRA JSONL
    python -m eliza_robot.trajectory_db.export_cli --format lora --output data/lora.jsonl

    # Show database statistics
    python -m eliza_robot.trajectory_db.export_cli --stats

    # Filter by reward and source
    python -m eliza_robot.trajectory_db.export_cli --format openai --output data/good.jsonl \\
        --min-reward 0.5 --source hyperscape --max-trajectories 100
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


def _print_stats(db_path: str) -> None:
    """Print database statistics to stdout."""
    from eliza_robot.trajectory_db.db import TrajectoryDB

    db = TrajectoryDB(db_path)
    db.initialize()
    try:
        stats = db.get_stats()
    finally:
        db.close()

    print("=" * 60)
    print(f"Trajectory Database: {db_path}")
    print("=" * 60)
    print()

    print("Table Counts:")
    for key in sorted(stats):
        if key.endswith("_count") and key != "training_trajectories":
            table = key.replace("_count", "")
            print(f"  {table:25s} {stats[key]:>8d}")
    print()

    print("Status Breakdown:")
    for status, count in sorted((stats.get("status_counts") or {}).items()):
        print(f"  {status:25s} {count:>8d}")
    print()

    print("Source Breakdown:")
    for source, count in sorted((stats.get("source_counts") or {}).items()):
        print(f"  {source:25s} {count:>8d}")
    print()

    print("Reward Statistics:")
    print(f"  Min:      {stats.get('reward_min', 'N/A')}")
    print(f"  Max:      {stats.get('reward_max', 'N/A')}")
    avg = stats.get("reward_avg")
    print(f"  Average:  {avg:.4f}" if avg is not None else "  Average:  N/A")
    print()

    print(f"Training Trajectories: {stats.get('training_trajectories', 0)}")


def _run_export(
    db_path: str,
    output_path: str,
    format: str,
    min_reward: float | None,
    max_trajectories: int | None,
    source: str | None,
) -> int:
    """Run the export and return the count of records written."""
    from eliza_robot.datasets.format_for_finetuning import export_dataset

    return export_dataset(
        db_path=db_path,
        output_path=output_path,
        format=format,
        min_reward=min_reward,
        max_trajectories=max_trajectories,
        source=source,
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Export trajectory data in various formats",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s --stats\n"
            "  %(prog)s --format openai --output data/finetune.jsonl\n"
            "  %(prog)s --format rlds --output data/rlds/ --min-reward 0.5\n"
            "  %(prog)s --format lora --output data/lora.jsonl --source hyperscape\n"
        ),
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("ELIZA_ROBOT_TRAJ_DB", "trajectories.db"),
        help=(
            "Path to the SQLite trajectory database "
            "(default: $ELIZA_ROBOT_TRAJ_DB or trajectories.db)"
        ),
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Print database statistics and exit",
    )
    parser.add_argument(
        "--format",
        choices=["openai", "lora", "art", "rlds"],
        default=None,
        help="Export format",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output file path (JSONL) or directory (RLDS)",
    )
    parser.add_argument(
        "--min-reward",
        type=float,
        default=None,
        help="Minimum total_reward filter",
    )
    parser.add_argument(
        "--max-trajectories",
        type=int,
        default=None,
        help="Maximum number of trajectories to export",
    )
    parser.add_argument(
        "--source",
        default=None,
        help="Filter by trajectory source (e.g. hyperscape, real_robot, mujoco)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    if args.stats:
        _print_stats(args.db)
        return

    if args.format is None:
        parser.error("--format is required unless --stats is specified")
    if args.output is None:
        parser.error("--output is required unless --stats is specified")

    count = _run_export(
        db_path=args.db,
        output_path=args.output,
        format=args.format,
        min_reward=args.min_reward,
        max_trajectories=args.max_trajectories,
        source=args.source,
    )
    print(f"Exported {count} records to {args.output}")


if __name__ == "__main__":
    main()
