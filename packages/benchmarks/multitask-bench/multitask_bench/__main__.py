"""MultitaskBench CLI: run the N=1/5/10 lanes for one harness and write a report.

    python -m multitask_bench --harness eliza|hermes|openclaw|perfect|wrong \
        --lanes 1,5,10 --output-dir <dir> --model gemma-4-31b

Each lane drives the frozen 10-scenario sample through one shared agent at the
lane's concurrency N; the report carries every lane's metrics plus the
interference deltas (mean task score @N minus @1). ``perfect``/``wrong`` are the
hermetic no-key oracles used for smoke and CI; live harnesses need provider
keys and (for eliza) the server usage-buffer fix — see ``harness.py``.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from .harness import build_agent_factory, build_world_factory
from .report import build_report, write_report
from .sample import MULTITASK_SAMPLE, MULTITASK_SCENARIO_IDS
from .scheduler import run_lane
from .types import LaneResult

_DEFAULT_TIMEOUT_S = 300.0


def _parse_lanes(raw: str) -> list[int]:
    """Parse ``"1,5,10"`` into ``[1, 5, 10]``, raising on malformed input.

    The N=1 lane must be present: it is the interference baseline, and its
    absence would make every delta undefined. We fail here rather than let the
    report builder raise deep in aggregation.
    """
    try:
        lanes = [int(part.strip()) for part in raw.split(",") if part.strip()]
    except ValueError as exc:
        raise SystemExit(f"--lanes must be comma-separated ints, got {raw!r}") from exc
    if not lanes:
        raise SystemExit("--lanes must name at least one N")
    if any(n < 1 for n in lanes):
        raise SystemExit(f"--lanes values must be >= 1, got {lanes}")
    if 1 not in lanes:
        raise SystemExit(
            "--lanes must include 1 (the N=1 interference baseline)"
        )
    return lanes


async def _run(
    *,
    harness: str,
    lanes: list[int],
    model: str,
    timeout_s: float,
) -> list[LaneResult]:
    agent_factory = build_agent_factory(harness, model=model)
    world_factory = build_world_factory()
    results: list[LaneResult] = []
    for n in sorted(lanes):
        results.append(
            await run_lane(
                n=n,
                scenarios=MULTITASK_SAMPLE,
                agent_factory=agent_factory,
                world_factory=world_factory,
                timeout_s=timeout_s,
            )
        )
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="MultitaskBench — one agent handling N interleaved LifeOps tasks",
    )
    parser.add_argument(
        "--harness",
        choices=["eliza", "hermes", "openclaw", "perfect", "wrong"],
        required=True,
        help="Which harness drives the shared agent",
    )
    parser.add_argument(
        "--lanes",
        default="1,5,10",
        help="Comma-separated concurrency levels; must include 1 (default: 1,5,10)",
    )
    parser.add_argument(
        "--output-dir",
        default=os.environ.get("MULTITASK_BENCH_OUTPUT_DIR", "results"),
        help="Directory to write multitask_<timestamp>.json into",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("MULTITASK_BENCH_MODEL", "gemma-4-31b"),
        help="Model name for the live harnesses (default: gemma-4-31b)",
    )
    parser.add_argument(
        "--per-task-timeout-s",
        type=float,
        default=float(os.environ.get("MULTITASK_BENCH_TIMEOUT_S", _DEFAULT_TIMEOUT_S)),
        help="Per-task wall-clock timeout in seconds (default: 300)",
    )
    args = parser.parse_args(argv)

    lanes = _parse_lanes(args.lanes)
    lane_results = asyncio.run(
        _run(
            harness=args.harness,
            lanes=lanes,
            model=args.model,
            timeout_s=args.per_task_timeout_s,
        )
    )

    report = build_report(
        harness=args.harness,
        model=args.model,
        lanes=lane_results,
        scenario_ids=MULTITASK_SCENARIO_IDS,
    )
    path = write_report(report, Path(args.output_dir))

    interference = report["interference"]
    print(f"[multitask] harness={args.harness} isolation={report['isolation']}")
    for lane in report["lanes"]:  # type: ignore[union-attr]
        print(
            f"[multitask] N={lane['n']:<3} "
            f"completed={lane['tasks_completed']}/{lane['tasks_total']} "
            f"mean_score={lane['mean_task_score']:.3f} "
            f"starved={lane['starved_tasks']} "
            f"jain={lane['fairness_turns_jain']:.3f}"
        )
    for key, delta in interference.items():  # type: ignore[union-attr]
        print(f"[multitask] interference {key}={delta:+.3f}")
    print(f"[multitask] wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
