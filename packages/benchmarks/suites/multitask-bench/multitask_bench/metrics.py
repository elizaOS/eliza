"""Aggregate a lane's task runs into the MultitaskBench metric block.

The headline is *interference*: mean per-task score at N minus at N=1, over the
identical (scenario, seed) pairs both lanes ran. Everything else characterizes
how a shared agent degrades under load — completion rate, throughput, per-turn
and per-task latency spread, cost, fairness (Jain over per-wave turn counts),
and starvation (a task that timed out while a wave peer completed, or produced
zero turns). Orchestration quality is surfaced by folding each turn's planner
actions through ``extract_lifecycle_events`` so a lane reports *which* lifecycle
stages actually fired, not just a scalar.

A completed task is one whose ``terminated_reason`` is a normal end
("respond"/"satisfied"/"max_turns"), never a failure sentinel — so completion
rate and mean score never count a timed-out or errored task as a healthy zero.
"""

from __future__ import annotations

from collections import defaultdict
from statistics import mean

from orchestrator_lifecycle.events import extract_lifecycle_events

from .types import LaneResult, TaskRun

__all__ = [
    "COMPLETED_REASONS",
    "compute_lane_metrics",
    "is_completed",
    "is_starved",
    "jain_fairness",
    "mean_task_score",
    "percentiles",
]

# Terminal reasons that mean the task finished on its own terms. Anything
# outside this set — "timeout", "error", "cost_exceeded" — is a failure, and a
# failed task is never counted as a completion nor as a zero-scoring success.
COMPLETED_REASONS: frozenset[str] = frozenset({"respond", "satisfied", "max_turns"})


def is_completed(task: TaskRun) -> bool:
    """True when the task ended on a normal terminal reason."""
    return task.terminated_reason in COMPLETED_REASONS


def is_starved(task: TaskRun, wave_had_completion: bool) -> bool:
    """True when the task was starved of the shared agent's attention.

    Two shapes count as starvation: a wall-clock timeout while at least one
    peer in the same wave completed (the agent served others and left this one
    hanging), or a task that produced zero turns at all (it never got a slice).
    """
    if task.turns == 0:
        return True
    return task.terminated_reason == "timeout" and wave_had_completion


def mean_task_score(tasks: list[TaskRun]) -> float:
    """Mean per-task score over ``tasks`` (0.0 for an empty lane)."""
    if not tasks:
        return 0.0
    return mean(task.score for task in tasks)


def percentiles(values: list[float]) -> dict[str, float]:
    """p50/p95/max over ``values`` via nearest-rank (no interpolation).

    Nearest-rank keeps every reported percentile an actually-observed sample,
    which is the honest thing for the small N (10 tasks) MultitaskBench runs.
    Returns zeros for an empty input — there is no data to summarize, and the
    caller renders the lane's ``tasks_completed`` alongside so an all-zero
    latency block is never mistaken for "instant".
    """
    if not values:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0}
    ordered = sorted(values)
    count = len(ordered)

    def nearest_rank(pct: float) -> float:
        # rank = ceil(pct * count), 1-indexed, clamped into range.
        rank = max(1, min(count, -(-int(pct * count * 100) // 100)))
        return ordered[rank - 1]

    return {
        "p50": nearest_rank(0.50),
        "p95": nearest_rank(0.95),
        "max": ordered[-1],
    }


def jain_fairness(turn_counts: list[int]) -> float:
    """Jain's fairness index (x·1)² / (n·x·x) over per-task turn counts.

    1.0 means every task got the same number of turns; 1/n means one task
    monopolized the agent. Returns 1.0 for a single task (trivially fair) and
    0.0 when every task got zero turns (no allocation to be fair about).
    """
    if not turn_counts:
        return 0.0
    total = sum(turn_counts)
    if total == 0:
        return 0.0
    sum_sq = sum(x * x for x in turn_counts)
    n = len(turn_counts)
    return (total * total) / (n * sum_sq)


def _fairness_over_waves(tasks: list[TaskRun]) -> float:
    """Mean per-wave Jain index over per-task turn counts.

    Fairness is a within-wave property (N tasks contending for one agent at
    once), so we compute Jain per wave and average. The N=1 lane has one task
    per wave → every wave is trivially fair → 1.0.
    """
    by_wave: dict[int, list[int]] = defaultdict(list)
    for task in tasks:
        by_wave[task.wave_index].append(task.turns)
    if not by_wave:
        return 0.0
    return mean(jain_fairness(counts) for counts in by_wave.values())


def _lane_lifecycle_events(tasks: list[TaskRun]) -> dict[str, int]:
    """Count lifecycle events fired across every turn of every task in the lane.

    Each turn's planner actions + params are normalized through
    ``extract_lifecycle_events`` (de-duped within a turn); the lane tally sums
    those across all turns so the report shows which orchestration stages the
    agent actually exercised under load.
    """
    counts: dict[str, int] = defaultdict(int)
    for task in tasks:
        if task.result is None:
            continue
        for turn in task.result.turns:
            actions = [action.name for action in turn.agent_actions]
            params: dict[str, object] = {}
            for action in turn.agent_actions:
                params.update(action.kwargs)
            for event in extract_lifecycle_events(actions, params):
                counts[event] += 1
    return dict(sorted(counts.items()))


def compute_lane_metrics(lane: LaneResult) -> dict[str, object]:
    """Reduce a ``LaneResult`` to the metric dict ``report.py`` serializes."""
    tasks = lane.tasks
    total = len(tasks)
    completed = [task for task in tasks if is_completed(task)]

    waves_with_completion = {
        task.wave_index for task in tasks if is_completed(task)
    }
    starved = [
        task
        for task in tasks
        if is_starved(task, task.wave_index in waves_with_completion)
    ]

    prompt_tokens = 0
    completion_tokens = 0
    cost_total = 0.0
    turn_latencies_ms: list[float] = []
    for task in tasks:
        if task.result is None:
            continue
        cost_total += task.result.total_cost_usd
        for turn in task.result.turns:
            prompt_tokens += int(turn.input_tokens or 0)
            completion_tokens += int(turn.output_tokens or 0)
            if turn.latency_ms is not None:
                turn_latencies_ms.append(float(turn.latency_ms))

    task_walls_s = [task.task_wall_s for task in tasks]
    throughput = (
        len(completed) / (lane.wall_clock_s / 60.0)
        if lane.wall_clock_s > 0
        else 0.0
    )
    per_completed_cost = (
        cost_total / len(completed) if completed else 0.0
    )

    return {
        "n": lane.n,
        "arrival": "batch",
        "waves": lane.waves,
        "tasks_total": total,
        "tasks_completed": len(completed),
        "completion_rate": (len(completed) / total) if total else 0.0,
        "mean_task_score": mean_task_score(tasks),
        "throughput_tasks_per_min": throughput,
        "wall_clock_s": lane.wall_clock_s,
        "turn_latency_ms": percentiles(turn_latencies_ms),
        "task_wall_s": percentiles(task_walls_s),
        "cost_usd": {
            "total": cost_total,
            "per_completed_task": per_completed_cost,
        },
        "tokens": {
            "prompt": prompt_tokens,
            "completion": completion_tokens,
        },
        "starved_tasks": len(starved),
        "starvation_rate": (len(starved) / total) if total else 0.0,
        "fairness_turns_jain": _fairness_over_waves(tasks),
        "lifecycle_events": _lane_lifecycle_events(tasks),
        "per_task": [
            {
                "scenario_id": task.scenario_id,
                "seed": task.seed,
                "wave_index": task.wave_index,
                "terminated_reason": task.terminated_reason,
                "completed": is_completed(task),
                "score": task.score,
                "turns": task.turns,
                "task_wall_s": task.task_wall_s,
            }
            for task in tasks
        ],
    }


def compute_interference(
    lanes_metrics: list[dict[str, object]],
) -> dict[str, float]:
    """Interference delta per non-baseline lane: mean_score@N - mean_score@1.

    Computed over the identical (scenario, seed) sample every lane runs, so the
    subtraction is well-defined. A delta of 0.0 means the shared agent scored
    each task exactly as well under load as alone (no interference); a negative
    delta quantifies degradation. Raises if the N=1 baseline is absent — the
    metric is undefined without it, and a silent skip would hide that.
    """
    baseline = next(
        (m for m in lanes_metrics if m["n"] == 1),
        None,
    )
    if baseline is None:
        raise ValueError(
            "interference requires the N=1 baseline lane; none present"
        )
    baseline_by_key = _score_by_key(baseline)

    deltas: dict[str, float] = {}
    for lane in lanes_metrics:
        n = lane["n"]
        if n == 1:
            continue
        lane_by_key = _score_by_key(lane)
        shared_keys = sorted(baseline_by_key.keys() & lane_by_key.keys())
        if not shared_keys:
            raise ValueError(
                f"lane N={n} shares no (scenario, seed) pairs with the "
                "N=1 baseline; interference is undefined"
            )
        delta = mean(
            lane_by_key[key] - baseline_by_key[key] for key in shared_keys
        )
        deltas[f"n{n}_minus_n1"] = delta
    return deltas


def _score_by_key(lane_metrics: dict[str, object]) -> dict[tuple[str, int], float]:
    """Map (scenario_id, seed) -> score for a lane's per-task block."""
    per_task = lane_metrics["per_task"]
    assert isinstance(per_task, list)
    out: dict[tuple[str, int], float] = {}
    for entry in per_task:
        key = (str(entry["scenario_id"]), int(entry["seed"]))
        out[key] = float(entry["score"])
    return out
