"""``compare-vs-random`` CLI subcommand.

For each (benchmark, agent) pair, look up the latest successful run
for the real agent and the latest ``random_v1`` run, compute the lift
of the agent's score over the baseline using
``lib.random_baseline.lift_over_random``, print a table, and exit
non-zero when any pair falls below ``--min-lift``.

Stdlib only. The function is split out of ``cli.py`` to keep the
main CLI module focused on argument parsing and dispatch.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

_BENCHMARKS_ROOT = Path(__file__).resolve().parents[1]
if str(_BENCHMARKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_BENCHMARKS_ROOT))

from lib.random_baseline import (  # noqa: E402
    is_better_than_random,
    lift_over_random,
)

from .db import connect_database, initialize_database  # noqa: E402


def _latest_run_for(
    conn,
    *,
    benchmark_id: str,
    agent: str,
) -> dict[str, Any] | None:
    """Return the most recent ``succeeded`` run for ``(benchmark, agent)``.

    None when no such run exists. Latest is decided by ``started_at``
    descending — ties broken by ``run_id`` for determinism.
    """
    row = conn.execute(
        """
        SELECT run_id, benchmark_id, agent, score, unit, higher_is_better,
               started_at, status, model, provider
        FROM benchmark_runs
        WHERE benchmark_id = ? AND agent = ? AND status = 'succeeded'
        ORDER BY started_at DESC, run_id DESC
        LIMIT 1
        """,
        (benchmark_id, agent),
    ).fetchone()
    if row is None:
        return None
    record = dict(row)
    hib = record.get("higher_is_better")
    record["higher_is_better"] = None if hib is None else bool(hib)
    return record


def _format_value(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.4f}"


def _format_lift(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2f}x"


def _format_better(value: bool | None) -> str:
    if value is None:
        return "n/a"
    return "yes" if value else "no"


def _print_table(rows: list[dict[str, Any]]) -> None:
    headers = [
        "benchmark",
        "agent",
        "score",
        "random_score",
        "lift",
        "better>=min",
    ]
    body: list[list[str]] = []
    for row in rows:
        body.append(
            [
                str(row["benchmark_id"]),
                str(row["agent"]),
                _format_value(row.get("score")),
                _format_value(row.get("random_score")),
                _format_lift(row.get("lift")),
                _format_better(row.get("better")),
            ]
        )
    widths = [
        max(len(headers[i]), *(len(r[i]) for r in body)) if body else len(headers[i])
        for i in range(len(headers))
    ]
    print(" | ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print("-+-".join("-" * w for w in widths))
    for row in body:
        print(" | ".join(cell.ljust(w) for cell, w in zip(row, widths)))


def run_compare_vs_random(
    *,
    workspace_root: Path,
    agents: list[str],
    benchmarks: list[str],
    min_lift: float,
) -> int:
    """Compare agent scores against the random_v1 baseline.

    Returns 0 when every pair beats the threshold (or has a missing
    baseline that is therefore not enforceable). Returns 1 when at
    least one pair has a real lift below the threshold.
    """
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)

    rows: list[dict[str, Any]] = []
    any_failed = False

    for benchmark_id in benchmarks:
        random_run = _latest_run_for(conn, benchmark_id=benchmark_id, agent="random_v1")
        random_score = random_run.get("score") if random_run else None

        for agent in agents:
            run = _latest_run_for(conn, benchmark_id=benchmark_id, agent=agent)
            score = run.get("score") if run else None
            higher_is_better = (
                bool(run.get("higher_is_better"))
                if run and run.get("higher_is_better") is not None
                else True
            )

            lift = lift_over_random(
                score,
                random_score,
                higher_is_better=higher_is_better,
            )
            better = is_better_than_random(
                score,
                random_score,
                higher_is_better=higher_is_better,
                min_lift=min_lift,
            )
            # Only enforce the threshold when both inputs are real
            # numbers — a missing baseline or agent run cannot be
            # called a failure here.
            enforce = score is not None and random_score is not None
            if enforce and not better:
                any_failed = True

            rows.append(
                {
                    "benchmark_id": benchmark_id,
                    "agent": agent,
                    "score": score,
                    "random_score": random_score,
                    "lift": lift,
                    "better": better if enforce else None,
                    "run_id": run.get("run_id") if run else None,
                    "random_run_id": random_run.get("run_id") if random_run else None,
                }
            )

    conn.close()
    _print_table(rows)

    if any_failed:
        print("")
        print(f"FAIL: one or more (benchmark, agent) pairs below {min_lift}x lift over random_v1")
        return 1
    return 0


def add_compare_vs_random_parser(sub: argparse._SubParsersAction) -> None:
    """Attach the ``compare-vs-random`` parser to a subparsers object."""
    p = sub.add_parser(
        "compare-vs-random",
        help="Compare latest agent runs to the latest random_v1 baseline",
    )
    p.add_argument(
        "--agents",
        required=True,
        help="Comma-separated agents to check (e.g. eliza,openclaw,hermes)",
    )
    p.add_argument(
        "--benchmarks",
        required=True,
        help="Comma-separated benchmark IDs",
    )
    p.add_argument(
        "--min-lift",
        type=float,
        default=1.5,
        help="Minimum lift over random required to pass (default: 1.5)",
    )
    p.set_defaults(func=_cmd_compare_vs_random)


def _cmd_compare_vs_random(args: argparse.Namespace) -> int:
    workspace_root = Path(__file__).resolve().parents[2]
    agents = [item.strip() for item in str(args.agents).split(",") if item.strip()]
    benchmarks = [item.strip() for item in str(args.benchmarks).split(",") if item.strip()]
    if not agents:
        raise SystemExit("--agents must be a non-empty comma-separated list")
    if not benchmarks:
        raise SystemExit("--benchmarks must be a non-empty comma-separated list")
    return run_compare_vs_random(
        workspace_root=workspace_root,
        agents=agents,
        benchmarks=benchmarks,
        min_lift=float(args.min_lift),
    )


__all__ = [
    "run_compare_vs_random",
    "add_compare_vs_random_parser",
]
