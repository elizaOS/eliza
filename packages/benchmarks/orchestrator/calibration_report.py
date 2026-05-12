from __future__ import annotations

import json
import hashlib
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from .db import connect_database, initialize_database, list_runs
from .random_baseline_runner import (
    CALIBRATION_HARNESSES,
    CALIBRATION_SPEC_VERSION,
    SYNTHETIC_HARNESSES,
)

REAL_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")
NON_LEADERBOARD_AGENTS: set[str] = {
    "smoke",
    "mock",
    "dummy",
    "final-smoke",
    "smoke-default",
    "full-sweep",
}


def _latest_by_benchmark_agent(conn) -> dict[tuple[str, str], dict[str, Any]]:
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for row in list_runs(conn, limit=100000):
        benchmark_id = str(row.get("benchmark_id") or "")
        agent = str(row.get("agent") or "")
        if row.get("status") == "skipped":
            continue
        if not benchmark_id or not agent:
            continue
        key = (benchmark_id, agent)
        if key not in latest:
            latest[key] = row
    return latest


def _is_close(a: float | None, b: float | None, tolerance: float) -> bool:
    if a is None or b is None:
        return False
    return math.isclose(float(a), float(b), rel_tol=tolerance, abs_tol=tolerance)


def _expected_for(agent: str) -> float:
    if agent == "perfect_v1":
        return 1.0
    if agent == "wrong_v1":
        return 0.0
    if agent == "half_v1":
        return 0.5
    raise ValueError(f"not a calibration agent: {agent}")


def _comparison_signature_for_run(run: dict[str, Any]) -> str:
    """Match runner comparison signatures without importing runner internals."""

    extra_config = dict(run.get("extra_config") or {})
    comparable_agents = set(REAL_HARNESSES) | set(SYNTHETIC_HARNESSES)
    injected_agent = str(extra_config.get("agent") or "").strip().lower()
    injected_harness = str(extra_config.get("harness") or "").strip().lower()
    if injected_agent in comparable_agents:
        extra_config.pop("agent", None)
    if injected_harness in comparable_agents:
        extra_config.pop("harness", None)
    agent = str(run.get("agent") or "").strip().lower()
    if agent in CALIBRATION_HARNESSES:
        extra_config["calibration_spec_version"] = CALIBRATION_SPEC_VERSION
    payload = {
        "benchmark_id": run.get("benchmark_id"),
        "benchmark_directory": run.get("benchmark_directory") or run.get("benchmark_id"),
        "provider": run.get("provider") or "",
        "model": run.get("model") or "",
        "extra_config": extra_config,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).hexdigest()


def build_calibration_report(
    *,
    workspace_root: Path,
    tolerance: float = 1e-6,
    benchmark_ids: set[str] | None = None,
) -> dict[str, Any]:
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)
    latest = _latest_by_benchmark_agent(conn)
    conn.close()

    benchmarks = sorted(benchmark_ids or {benchmark_id for benchmark_id, _agent in latest})
    rows: list[dict[str, Any]] = []
    counts: dict[str, int] = defaultdict(int)

    for benchmark_id in benchmarks:
        calibration: dict[str, dict[str, Any]] = {}
        calibration_status = "valid"
        missing_calibration: list[str] = []
        scorer_only = False
        flat_scores: list[float] = []
        for agent in CALIBRATION_HARNESSES:
            run = latest.get((benchmark_id, agent))
            expected = _expected_for(agent)
            if run is None or run.get("status") != "succeeded":
                missing_calibration.append(agent)
                calibration[agent] = {
                    "status": run.get("status") if run else "missing",
                    "score": run.get("score") if run else None,
                    "expected": expected,
                    "ok": False,
                    "run_id": run.get("run_id") if run else None,
                }
                continue
            score = run.get("score")
            score_f = float(score) if isinstance(score, (int, float)) else None
            metrics = dict(run.get("metrics") or {})
            if str(metrics.get("calibration_depth") or "").startswith("scorer_payload"):
                scorer_only = True
            flat_scores.append(score_f if score_f is not None else float("nan"))
            ok = _is_close(score_f, expected, tolerance)
            calibration[agent] = {
                "status": run.get("status"),
                "score": score_f,
                "expected": expected,
                "ok": ok,
                "run_id": run.get("run_id"),
                "calibration_depth": metrics.get("calibration_depth"),
            }
        if missing_calibration:
            calibration_status = "missing"
        elif all(
            calibration.get(agent, {}).get("ok") is True
            for agent in CALIBRATION_HARNESSES
        ):
            calibration_status = "valid_scorer_only" if scorer_only else "valid"
        else:
            wrong_score = calibration.get("wrong_v1", {}).get("score")
            perfect_score = calibration.get("perfect_v1", {}).get("score")
            if _is_close(wrong_score, 1.0, tolerance):
                calibration_status = "all_right"
            elif _is_close(perfect_score, 0.0, tolerance):
                calibration_status = "all_wrong"
            elif len(flat_scores) == 3 and all(
                math.isfinite(v) and _is_close(v, flat_scores[0], tolerance)
                for v in flat_scores
            ):
                calibration_status = "flat"
            else:
                calibration_status = "mismatch"
        counts[calibration_status] += 1

        real_runs = {
            agent: latest.get((benchmark_id, agent))
            for agent in REAL_HARNESSES
        }
        real_scores = [
            float(run["score"])
            for run in real_runs.values()
            if run
            and run.get("status") == "succeeded"
            and isinstance(run.get("score"), (int, float))
        ]
        real_statuses = {
            agent: (run.get("status") if run else "missing")
            for agent, run in real_runs.items()
        }
        real_score_map = {
            agent: (float(run["score"]) if run and isinstance(run.get("score"), (int, float)) else None)
            for agent, run in real_runs.items()
        }
        real_comparison_signatures = {
            agent: _comparison_signature_for_run(run)
            for agent, run in real_runs.items()
            if run and run.get("status") == "succeeded"
        }
        mixed_real_config = (
            len(real_comparison_signatures) == len(REAL_HARNESSES)
            and len(set(real_comparison_signatures.values())) > 1
        )
        real_pattern = "incomplete"
        if len(real_scores) == len(REAL_HARNESSES):
            if all(_is_close(score, real_scores[0], tolerance) for score in real_scores):
                if _is_close(real_scores[0], 1.0, tolerance):
                    real_pattern = "all_real_one"
                elif _is_close(real_scores[0], 0.0, tolerance):
                    real_pattern = "all_real_zero"
                else:
                    real_pattern = "all_real_equal"
            else:
                real_pattern = "real_differ"
            if mixed_real_config:
                real_pattern = f"{real_pattern}_mixed_config"
        counts[real_pattern] += 1

        extra_db_agents = sorted(
            agent
            for (bid, agent), _run in latest.items()
            if bid == benchmark_id and agent in NON_LEADERBOARD_AGENTS
        )
        if extra_db_agents:
            counts["non_leaderboard_db_labels"] += 1

        rows.append(
            {
                "benchmark_id": benchmark_id,
                "calibration_status": calibration_status,
                "real_pattern": real_pattern,
                "real_scores": real_score_map,
                "real_statuses": real_statuses,
                "real_comparison_signatures": real_comparison_signatures,
                "calibration": calibration,
                "non_leaderboard_db_labels": extra_db_agents,
            }
        )

    return {
        "calibration_spec_version": CALIBRATION_SPEC_VERSION,
        "tolerance": tolerance,
        "summary": dict(sorted(counts.items())),
        "rows": rows,
    }


def print_calibration_report(report: dict[str, Any]) -> None:
    print(f"Calibration spec: {report.get('calibration_spec_version')}")
    print(f"Tolerance: {report.get('tolerance')}")
    print("")
    print("Summary:")
    for key, value in sorted(dict(report.get("summary") or {}).items()):
        print(f"- {key}: {value}")
    print("")
    print("Suspicious benchmarks:")
    rows = list(report.get("rows") or [])
    interesting = [
        row
        for row in rows
        if row.get("calibration_status") not in {"valid"}
        or row.get("real_pattern") in {"all_real_zero", "all_real_one", "all_real_equal"}
        or str(row.get("real_pattern") or "").endswith("_mixed_config")
        or row.get("non_leaderboard_db_labels")
    ]
    if not interesting:
        print("- none")
        return
    for row in interesting:
        print(
            f"- {row.get('benchmark_id')}: "
            f"calibration={row.get('calibration_status')} "
            f"real={row.get('real_pattern')} "
            f"scores={json.dumps(row.get('real_scores'), sort_keys=True)}"
        )
        extras = row.get("non_leaderboard_db_labels") or []
        if extras:
            print(f"  non-leaderboard DB labels: {', '.join(extras)}")
        signatures = row.get("real_comparison_signatures") or {}
        if str(row.get("real_pattern") or "").endswith("_mixed_config") and signatures:
            short = {agent: str(value)[:12] for agent, value in signatures.items()}
            print(f"  mixed comparison signatures: {json.dumps(short, sort_keys=True)}")


__all__ = ["build_calibration_report", "print_calibration_report"]
