from __future__ import annotations

import json
import hashlib
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from .adapters import discover_adapters
from .db import (
    connect_database,
    initialize_database,
    list_runs,
    repair_nonpublishable_success_statuses,
    repair_nonzero_returncode_statuses,
)
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
    for row in list_runs(conn, limit=None):
        benchmark_id = str(row.get("benchmark_id") or "")
        agent = str(row.get("agent") or "")
        if row.get("status") in {"queued", "running", "skipped"}:
            continue
        if not benchmark_id or not agent:
            continue
        key = (benchmark_id, agent)
        if key not in latest:
            latest[key] = row
    return latest


def _snapshot_rows(snapshot_dir: Path) -> dict[tuple[str, str], dict[str, Any]]:
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    if not snapshot_dir.exists():
        return rows
    for path in sorted(snapshot_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        benchmark_id = str(payload.get("benchmark_id") or "")
        agent = str(payload.get("agent") or "").strip().lower()
        if not benchmark_id or not agent:
            continue
        row = dict(payload)
        row.setdefault("result_json_path", payload.get("result_json_path"))
        rows.setdefault((benchmark_id, agent), row)
    return rows


def _published_latest_by_benchmark_agent(workspace_root: Path) -> dict[tuple[str, str], dict[str, Any]]:
    results_root = workspace_root / "benchmarks" / "benchmark_results"
    published: dict[tuple[str, str], dict[str, Any]] = {}
    published.update(_snapshot_rows(results_root / "latest"))
    published.update(_snapshot_rows(results_root / "baselines"))
    return published


def _quarantine_by_benchmark_agent(workspace_root: Path) -> dict[tuple[str, str], dict[str, Any]]:
    return _snapshot_rows(workspace_root / "benchmarks" / "benchmark_results" / "quarantine")


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


def _discover_agent_compatibility(workspace_root: Path) -> dict[str, tuple[str, ...]]:
    if not (workspace_root / "benchmarks").exists():
        return {}
    try:
        discovery = discover_adapters(workspace_root)
    except Exception:
        return {}
    return {
        benchmark_id: tuple(adapter.agent_compatibility)
        for benchmark_id, adapter in discovery.adapters.items()
    }


def _real_pattern_for_scores(
    *,
    scores: list[float],
    tolerance: float,
) -> str:
    if not scores:
        return "no_required_real_harnesses"
    if len(scores) == 1:
        if _is_close(scores[0], 1.0, tolerance):
            return "single_real_one"
        if _is_close(scores[0], 0.0, tolerance):
            return "single_real_zero"
        return "single_real_score"
    if all(_is_close(score, scores[0], tolerance) for score in scores):
        if _is_close(scores[0], 1.0, tolerance):
            return "all_real_one"
        if _is_close(scores[0], 0.0, tolerance):
            return "all_real_zero"
        return "all_real_equal"
    return "real_differ"


def build_calibration_report(
    *,
    workspace_root: Path,
    tolerance: float = 1e-6,
    benchmark_ids: set[str] | None = None,
    agent_compatibility: dict[str, tuple[str, ...]] | None = None,
    repair: bool = False,
) -> dict[str, Any]:
    db_path = workspace_root / "benchmarks" / "benchmark_results" / "orchestrator.sqlite"
    conn = connect_database(db_path)
    initialize_database(conn)
    if repair:
        repair_nonzero_returncode_statuses(conn)
        repair_nonpublishable_success_statuses(conn)
    db_latest = _latest_by_benchmark_agent(conn)
    conn.close()
    published_latest = _published_latest_by_benchmark_agent(workspace_root)
    quarantine_latest = _quarantine_by_benchmark_agent(workspace_root)

    # The idempotent latest snapshots are the published source of truth. A
    # local SQLite database can be partial after a focused rerun; do not let
    # that hide older successful snapshots or calibration baselines, and do not
    # let a newer quarantined/failed attempt shadow a known-good latest row.
    # Quarantine rows only fill gaps so failed attempts remain visible when
    # there is no publishable source of truth.
    latest = dict(db_latest)
    for key, row in published_latest.items():
        latest[key] = row
    for key, row in quarantine_latest.items():
        latest.setdefault(key, row)

    compatibility = (
        dict(agent_compatibility)
        if agent_compatibility is not None
        else _discover_agent_compatibility(workspace_root)
    )
    benchmarks = sorted(
        benchmark_ids
        or set(compatibility)
        or {benchmark_id for benchmark_id, _agent in latest}
    )
    rows: list[dict[str, Any]] = []
    counts: dict[str, int] = defaultdict(int)
    matrix_summary: dict[str, int] = defaultdict(int)
    matrix_summary["benchmarks"] = len(benchmarks)

    for benchmark_id in benchmarks:
        supported_harnesses = tuple(compatibility.get(benchmark_id, REAL_HARNESSES))
        supported_real_harnesses = [
            agent for agent in REAL_HARNESSES if agent in supported_harnesses
        ]
        unsupported_real_harnesses = [
            agent for agent in REAL_HARNESSES if agent not in supported_harnesses
        ]
        calibration: dict[str, dict[str, Any]] = {}
        calibration_status = "valid"
        missing_calibration: list[str] = []
        direct_score = False
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
            calibration_depth = str(metrics.get("calibration_depth") or "")
            if calibration_depth == "direct_score":
                direct_score = True
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
            if direct_score:
                calibration_status = "valid_direct_score"
            else:
                calibration_status = "valid"
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
                calibration_status = (
                    "half_right"
                    if _is_close(flat_scores[0], 0.5, tolerance)
                    else "flat"
                )
            else:
                calibration_status = "mismatch"
        counts[calibration_status] += 1

        real_runs = {
            agent: latest.get((benchmark_id, agent))
            for agent in REAL_HARNESSES
        }
        real_scores = [
            float(run["score"])
            for agent, run in real_runs.items()
            if agent in supported_real_harnesses
            and run
            and run.get("status") == "succeeded"
            and isinstance(run.get("score"), (int, float))
        ]
        real_statuses = {
            agent: (
                "unsupported"
                if agent in unsupported_real_harnesses
                else run.get("status")
                if run
                else "missing"
            )
            for agent, run in real_runs.items()
        }
        real_score_map = {
            agent: (float(run["score"]) if run and isinstance(run.get("score"), (int, float)) else None)
            for agent, run in real_runs.items()
        }
        real_cells: dict[str, dict[str, Any]] = {}
        missing_required_real: list[str] = []
        failed_required_real: list[str] = []
        succeeded_required_real: list[str] = []
        for agent in REAL_HARNESSES:
            run = real_runs.get(agent)
            required = agent in supported_real_harnesses
            if not required:
                state = "unsupported"
            elif run is None:
                state = "missing"
                missing_required_real.append(agent)
            elif run.get("status") == "succeeded" and isinstance(run.get("score"), (int, float)):
                state = "succeeded"
                succeeded_required_real.append(agent)
            else:
                state = str(run.get("status") or "missing")
                failed_required_real.append(agent)
            real_cells[agent] = {
                "required": required,
                "state": state,
                "status": real_statuses[agent],
                "score": real_score_map[agent],
                "run_id": run.get("run_id") if run else None,
            }
        real_comparison_signatures = {
            agent: _comparison_signature_for_run(run)
            for agent, run in real_runs.items()
            if run and agent in supported_real_harnesses and run.get("status") == "succeeded"
        }
        mixed_real_config = (
            len(real_comparison_signatures) == len(supported_real_harnesses)
            and len(supported_real_harnesses) > 1
            and len(set(real_comparison_signatures.values())) > 1
        )
        real_pattern = "incomplete"
        if len(real_scores) == len(supported_real_harnesses):
            real_pattern = _real_pattern_for_scores(scores=real_scores, tolerance=tolerance)
            if mixed_real_config:
                real_pattern = f"{real_pattern}_mixed_config"
        counts[real_pattern] += 1
        matrix_summary["required_real_cells"] += len(supported_real_harnesses)
        matrix_summary["unsupported_real_cells"] += len(unsupported_real_harnesses)
        matrix_summary["succeeded_required_real_cells"] += len(succeeded_required_real)
        matrix_summary["missing_required_real_cells"] += len(missing_required_real)
        matrix_summary["failed_required_real_cells"] += len(failed_required_real)
        if missing_required_real or failed_required_real:
            matrix_summary["incomplete_benchmarks"] += 1
        else:
            matrix_summary["complete_benchmarks"] += 1

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
                "real_cells": real_cells,
                "real_required_harnesses": supported_real_harnesses,
                "real_unsupported_harnesses": unsupported_real_harnesses,
                "missing_required_real_harnesses": missing_required_real,
                "failed_required_real_harnesses": failed_required_real,
                "real_comparison_signatures": real_comparison_signatures,
                "calibration": calibration,
                "non_leaderboard_db_labels": extra_db_agents,
            }
        )

    return {
        "calibration_spec_version": CALIBRATION_SPEC_VERSION,
        "tolerance": tolerance,
        "summary": dict(sorted(counts.items())),
        "matrix_summary": dict(sorted(matrix_summary.items())),
        "rows": rows,
    }


def print_calibration_report(report: dict[str, Any]) -> None:
    print(f"Calibration spec: {report.get('calibration_spec_version')}")
    print(f"Tolerance: {report.get('tolerance')}")
    print("")
    matrix = dict(report.get("matrix_summary") or {})
    if matrix:
        print("Real Matrix:")
        for key, value in sorted(matrix.items()):
            print(f"- {key}: {value}")
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
        or row.get("missing_required_real_harnesses")
        or row.get("failed_required_real_harnesses")
        or row.get("real_pattern")
        in {"all_real_zero", "all_real_one", "all_real_equal", "single_real_zero"}
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
        missing = row.get("missing_required_real_harnesses") or []
        failed = row.get("failed_required_real_harnesses") or []
        unsupported = row.get("real_unsupported_harnesses") or []
        if missing:
            print(f"  missing required real harnesses: {', '.join(missing)}")
        if failed:
            print(f"  failed required real harnesses: {', '.join(failed)}")
        if unsupported:
            print(f"  unsupported real harnesses: {', '.join(unsupported)}")
        extras = row.get("non_leaderboard_db_labels") or []
        if extras:
            print(f"  non-leaderboard DB labels: {', '.join(extras)}")
        signatures = row.get("real_comparison_signatures") or {}
        if str(row.get("real_pattern") or "").endswith("_mixed_config") and signatures:
            short = {agent: str(value)[:12] for agent, value in signatures.items()}
            print(f"  mixed comparison signatures: {json.dumps(short, sort_keys=True)}")


__all__ = ["build_calibration_report", "print_calibration_report"]
