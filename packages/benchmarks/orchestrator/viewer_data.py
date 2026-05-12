from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from .db import list_run_groups, list_runs, summarize_latest_scores


def _iso_now() -> str:
    return datetime.now(UTC).isoformat()


def build_viewer_dataset(conn) -> dict[str, Any]:
    runs = list_runs(conn, limit=10000)
    groups = list_run_groups(conn, limit=3000)
    latest_scores = summarize_latest_scores(conn)

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
        latest = sorted(entries, key=lambda x: str(x.get("started_at", "")), reverse=True)[0]
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

    return {
        "generated_at": _iso_now(),
        "runs": runs,
        "run_groups": groups,
        "latest_scores": latest_scores,
        "benchmark_summary": benchmark_summary,
        "model_summary": model_summary,
        "agent_summary": agent_summary,
    }
