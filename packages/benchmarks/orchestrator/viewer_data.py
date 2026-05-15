from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from .db import list_run_groups, list_runs, summarize_latest_scores
from .random_baseline_runner import CALIBRATION_HARNESSES


def _iso_now() -> str:
    return datetime.now(UTC).isoformat()


def _stable_generated_at(
    runs: list[dict[str, Any]],
    groups: list[dict[str, Any]],
) -> str:
    timestamps = [
        str(value)
        for row in runs
        for value in (row.get("ended_at"), row.get("started_at"))
        if value
    ]
    timestamps.extend(
        str(value)
        for row in groups
        for value in (row.get("finished_at"), row.get("created_at"))
        if value
    )
    return max(timestamps) if timestamps else _iso_now()


def _latest_nonterminal_safe(entries: list[dict[str, Any]]) -> dict[str, Any]:
    terminal = [
        entry
        for entry in entries
        if entry.get("status") not in {"queued", "running", "skipped"}
    ]
    candidates = terminal or entries
    return sorted(candidates, key=lambda x: str(x.get("started_at", "")), reverse=True)[0]


def _filter_run_groups(
    groups: list[dict[str, Any]],
    benchmark_ids: set[str] | None,
) -> list[dict[str, Any]]:
    if benchmark_ids is None:
        return groups

    filtered: list[dict[str, Any]] = []
    for group in groups:
        benchmarks = group.get("benchmarks")
        if not isinstance(benchmarks, list):
            continue
        kept = [
            benchmark_id
            for benchmark_id in benchmarks
            if str(benchmark_id) in benchmark_ids
        ]
        if not kept:
            continue
        row = dict(group)
        row["benchmarks"] = kept
        filtered.append(row)
    return filtered


def build_viewer_dataset(
    conn,
    *,
    benchmark_ids: set[str] | None = None,
) -> dict[str, Any]:
    runs = list_runs(conn, limit=10000)
    if benchmark_ids is not None:
        runs = [
            row
            for row in runs
            if str(row.get("benchmark_id") or "") in benchmark_ids
        ]
    groups = _filter_run_groups(list_run_groups(conn, limit=3000), benchmark_ids)
    latest_scores = [
        row
        for row in summarize_latest_scores(conn)
        if benchmark_ids is None or str(row.get("benchmark_id") or "") in benchmark_ids
    ]

    by_benchmark: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_agent: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in runs:
        benchmark_id = str(row.get("benchmark_id", ""))
        model_key = f"{row.get('provider', '')}:{row.get('model', '')}"
        agent = str(row.get("agent", ""))
        by_benchmark[benchmark_id].append(row)
        by_model[model_key].append(row)
        by_agent[agent].append(row)

    benchmark_summary: list[dict[str, Any]] = []
    for benchmark_id, entries in by_benchmark.items():
        succeeded = [e for e in entries if e.get("status") == "succeeded" and isinstance(e.get("score"), (int, float))]
        best_score = max((float(e["score"]) for e in succeeded), default=None)
        latest = _latest_nonterminal_safe(entries)
        benchmark_summary.append(
            {
                "benchmark_id": benchmark_id,
                "runs": len(entries),
                "succeeded_runs": len(succeeded),
                "best_score": best_score,
                "latest_run_id": latest.get("run_id"),
                "latest_started_at": latest.get("started_at"),
                "latest_model": latest.get("model"),
                "latest_provider": latest.get("provider"),
            }
        )

    model_summary: list[dict[str, Any]] = []
    for model_key, entries in by_model.items():
        scores = [float(e["score"]) for e in entries if e.get("status") == "succeeded" and isinstance(e.get("score"), (int, float))]
        model_summary.append(
            {
                "model_key": model_key,
                "runs": len(entries),
                "succeeded_runs": len(scores),
                "average_score": (sum(scores) / len(scores)) if scores else None,
                "best_score": max(scores) if scores else None,
            }
        )

    agent_summary: list[dict[str, Any]] = []
    for agent, entries in by_agent.items():
        scores = [float(e["score"]) for e in entries if e.get("status") == "succeeded" and isinstance(e.get("score"), (int, float))]
        agent_summary.append(
            {
                "agent": agent,
                "runs": len(entries),
                "succeeded_runs": len(scores),
                "average_score": (sum(scores) / len(scores)) if scores else None,
                "best_score": max(scores) if scores else None,
            }
        )

    benchmark_summary.sort(key=lambda x: x["benchmark_id"])
    model_summary.sort(key=lambda x: x["model_key"])
    agent_summary.sort(key=lambda x: x["agent"])
    calibration_summary = _build_calibration_summary(runs)

    return {
        "generated_at": _stable_generated_at(runs, groups),
        "runs": runs,
        "run_groups": groups,
        "latest_scores": latest_scores,
        "benchmark_summary": benchmark_summary,
        "model_summary": model_summary,
        "agent_summary": agent_summary,
        "calibration_summary": calibration_summary,
    }


def _build_calibration_summary(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_cell: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in runs:
        benchmark_id = str(row.get("benchmark_id") or "")
        agent = str(row.get("agent") or "")
        if not benchmark_id or agent not in CALIBRATION_HARNESSES:
            continue
        key = (benchmark_id, agent)
        by_cell[key].append(row)
    latest = {
        key: _latest_nonterminal_safe(entries)
        for key, entries in by_cell.items()
        if entries
    }

    rows: list[dict[str, Any]] = []
    for benchmark_id in sorted({key[0] for key in latest}):
        scores = {
            agent: latest.get((benchmark_id, agent), {}).get("score")
            for agent in CALIBRATION_HARNESSES
        }
        statuses = {
            agent: latest.get((benchmark_id, agent), {}).get("status")
            for agent in CALIBRATION_HARNESSES
        }
        rows.append(
            {
                "benchmark_id": benchmark_id,
                "scores": scores,
                "statuses": statuses,
                "complete": all(statuses.get(agent) == "succeeded" for agent in CALIBRATION_HARNESSES),
            }
        )
    return rows
