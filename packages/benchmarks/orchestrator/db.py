from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .types import ExistingRun


def _json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def connect_database(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def initialize_database(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS run_groups (
            run_group_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            finished_at TEXT,
            request_json TEXT NOT NULL,
            benchmarks_json TEXT NOT NULL,
            repo_meta_json TEXT NOT NULL,
            created_by TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS benchmark_runs (
            run_id TEXT PRIMARY KEY,
            run_group_id TEXT NOT NULL,
            benchmark_id TEXT NOT NULL,
            benchmark_directory TEXT NOT NULL,
            signature TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            agent TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            extra_config_json TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_seconds REAL,
            command_json TEXT NOT NULL,
            cwd TEXT NOT NULL,
            stdout_path TEXT NOT NULL,
            stderr_path TEXT NOT NULL,
            result_json_path TEXT,
            score REAL,
            unit TEXT,
            higher_is_better INTEGER,
            metrics_json TEXT NOT NULL,
            artifacts_json TEXT NOT NULL,
            error TEXT,
            high_score_label TEXT,
            high_score_value REAL,
            delta_to_high_score REAL,
            benchmark_version TEXT,
            benchmarks_commit TEXT,
            eliza_commit TEXT,
            eliza_version TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(run_group_id) REFERENCES run_groups(run_group_id)
        );

        CREATE INDEX IF NOT EXISTS idx_benchmark_runs_signature
            ON benchmark_runs(signature);
        CREATE INDEX IF NOT EXISTS idx_benchmark_runs_signature_status
            ON benchmark_runs(signature, status, ended_at);
        CREATE INDEX IF NOT EXISTS idx_benchmark_runs_group
            ON benchmark_runs(run_group_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_benchmark_runs_lookup
            ON benchmark_runs(benchmark_id, provider, model, agent, started_at);
        """
    )
    conn.commit()


def create_run_group(
    conn: sqlite3.Connection,
    *,
    run_group_id: str,
    created_at: str,
    request: dict[str, Any],
    benchmarks: list[str],
    repo_meta: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO run_groups (
            run_group_id,
            created_at,
            request_json,
            benchmarks_json,
            repo_meta_json,
            created_by
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            run_group_id,
            created_at,
            _json_dumps(request),
            _json_dumps(benchmarks),
            _json_dumps(repo_meta),
            "benchmarks.orchestrator",
        ),
    )
    conn.commit()


def finish_run_group(conn: sqlite3.Connection, *, run_group_id: str, finished_at: str) -> None:
    conn.execute(
        "UPDATE run_groups SET finished_at = ? WHERE run_group_id = ?",
        (finished_at, run_group_id),
    )
    conn.commit()


def get_latest_run_for_signature(conn: sqlite3.Connection, signature: str) -> ExistingRun | None:
    row = conn.execute(
        """
        SELECT run_id, signature, status, attempt
        FROM benchmark_runs
        WHERE signature = ?
        ORDER BY attempt DESC, started_at DESC
        LIMIT 1
        """,
        (signature,),
    ).fetchone()
    if row is None:
        return None
    return ExistingRun(
        run_id=str(row["run_id"]),
        signature=str(row["signature"]),
        status=str(row["status"]),
        attempt=int(row["attempt"]),
    )


def get_latest_succeeded_run_for_signature(conn: sqlite3.Connection, signature: str) -> ExistingRun | None:
    row = conn.execute(
        """
        SELECT run_id, signature, status, attempt
        FROM benchmark_runs
        WHERE signature = ? AND status = 'succeeded'
        ORDER BY attempt DESC, started_at DESC
        LIMIT 1
        """,
        (signature,),
    ).fetchone()
    if row is None:
        return None
    return ExistingRun(
        run_id=str(row["run_id"]),
        signature=str(row["signature"]),
        status=str(row["status"]),
        attempt=int(row["attempt"]),
    )


def next_attempt_for_signature(conn: sqlite3.Connection, signature: str) -> int:
    row = conn.execute(
        "SELECT MAX(attempt) AS max_attempt FROM benchmark_runs WHERE signature = ?",
        (signature,),
    ).fetchone()
    if row is None or row["max_attempt"] is None:
        return 1
    return int(row["max_attempt"]) + 1


def insert_run_start(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    run_group_id: str,
    benchmark_id: str,
    benchmark_directory: str,
    signature: str,
    attempt: int,
    agent: str,
    provider: str,
    model: str,
    extra_config: dict[str, Any],
    started_at: str,
    command: list[str],
    cwd: str,
    stdout_path: str,
    stderr_path: str,
    benchmark_version: str | None,
    benchmarks_commit: str | None,
    eliza_commit: str | None,
    eliza_version: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO benchmark_runs (
            run_id,
            run_group_id,
            benchmark_id,
            benchmark_directory,
            signature,
            status,
            attempt,
            agent,
            provider,
            model,
            extra_config_json,
            started_at,
            command_json,
            cwd,
            stdout_path,
            stderr_path,
            result_json_path,
            score,
            unit,
            higher_is_better,
            metrics_json,
            artifacts_json,
            error,
            high_score_label,
            high_score_value,
            delta_to_high_score,
            benchmark_version,
            benchmarks_commit,
            eliza_commit,
            eliza_version,
            created_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '{}', '[]', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            run_group_id,
            benchmark_id,
            benchmark_directory,
            signature,
            attempt,
            agent,
            provider,
            model,
            _json_dumps(extra_config),
            started_at,
            _json_dumps(command),
            cwd,
            stdout_path,
            stderr_path,
            benchmark_version,
            benchmarks_commit,
            eliza_commit,
            eliza_version,
            started_at,
        ),
    )
    conn.commit()


def update_run_result(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    status: str,
    ended_at: str,
    duration_seconds: float | None,
    score: float | None,
    unit: str | None,
    higher_is_better: bool | None,
    metrics: dict[str, Any],
    result_json_path: str | None,
    artifacts: list[str],
    error: str | None,
    high_score_label: str | None,
    high_score_value: float | None,
    delta_to_high_score: float | None,
) -> None:
    hib: int | None
    if higher_is_better is None:
        hib = None
    else:
        hib = 1 if higher_is_better else 0

    conn.execute(
        """
        UPDATE benchmark_runs
        SET
            status = ?,
            ended_at = ?,
            duration_seconds = ?,
            score = ?,
            unit = ?,
            higher_is_better = ?,
            metrics_json = ?,
            result_json_path = ?,
            artifacts_json = ?,
            error = ?,
            high_score_label = ?,
            high_score_value = ?,
            delta_to_high_score = ?
        WHERE run_id = ?
        """,
        (
            status,
            ended_at,
            duration_seconds,
            score,
            unit,
            hib,
            _json_dumps(metrics),
            result_json_path,
            _json_dumps(artifacts),
            error,
            high_score_label,
            high_score_value,
            delta_to_high_score,
            run_id,
        ),
    )
    conn.commit()


def list_runs(
    conn: sqlite3.Connection,
    *,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT
            run_id,
            run_group_id,
            benchmark_id,
            benchmark_directory,
            status,
            attempt,
            agent,
            provider,
            model,
            extra_config_json,
            started_at,
            ended_at,
            duration_seconds,
            command_json,
            cwd,
            stdout_path,
            stderr_path,
            result_json_path,
            score,
            unit,
            higher_is_better,
            metrics_json,
            artifacts_json,
            error,
            high_score_label,
            high_score_value,
            delta_to_high_score,
            benchmark_version,
            benchmarks_commit,
            eliza_commit,
            eliza_version
        FROM benchmark_runs
        ORDER BY started_at DESC, run_id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    out: list[dict[str, Any]] = []
    for row in rows:
        record = dict(row)
        for key in ("extra_config_json", "command_json", "metrics_json", "artifacts_json"):
            raw = record.get(key)
            if isinstance(raw, str):
                try:
                    record[key.removesuffix("_json") if key.endswith("_json") else key] = json.loads(raw)
                except json.JSONDecodeError:
                    record[key.removesuffix("_json") if key.endswith("_json") else key] = raw
            if key in record:
                del record[key]
        hib = record.get("higher_is_better")
        if hib is None:
            record["higher_is_better"] = None
        else:
            record["higher_is_better"] = bool(hib)
        out.append(record)
    return out


def list_run_groups(conn: sqlite3.Connection, *, limit: int = 2000) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT run_group_id, created_at, finished_at, request_json, benchmarks_json, repo_meta_json
        FROM run_groups
        ORDER BY created_at DESC, run_group_id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        record = dict(row)
        for key in ("request_json", "benchmarks_json", "repo_meta_json"):
            raw = record.get(key)
            if isinstance(raw, str):
                try:
                    record[key.removesuffix("_json")] = json.loads(raw)
                except json.JSONDecodeError:
                    record[key.removesuffix("_json")] = raw
            if key in record:
                del record[key]
        out.append(record)
    return out


def summarize_latest_scores(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        WITH latest AS (
            SELECT
                benchmark_id,
                MAX(started_at) AS max_started_at
            FROM benchmark_runs
            WHERE status = 'succeeded'
            GROUP BY benchmark_id
        )
        SELECT
            r.benchmark_id,
            r.run_id,
            r.run_group_id,
            r.started_at,
            r.score,
            r.unit,
            r.agent,
            r.provider,
            r.model,
            r.high_score_label,
            r.high_score_value,
            r.delta_to_high_score
        FROM benchmark_runs r
        JOIN latest l
          ON r.benchmark_id = l.benchmark_id
         AND r.started_at = l.max_started_at
        WHERE r.status = 'succeeded'
        ORDER BY r.benchmark_id ASC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def recover_stale_running_runs(
    conn: sqlite3.Connection,
    *,
    stale_before: str,
    ended_at: str,
) -> list[str]:
    rows = conn.execute(
        """
        SELECT run_id, run_group_id, started_at
        FROM benchmark_runs
        WHERE status = 'running'
          AND started_at < ?
        ORDER BY started_at ASC
        """,
        (stale_before,),
    ).fetchall()
    if not rows:
        return []

    recovered_ids: list[str] = []
    touched_groups: set[str] = set()
    metrics_json = _json_dumps({"reason": "orchestrator_interrupted"})

    ended_dt = datetime.fromisoformat(ended_at)
    if ended_dt.tzinfo is None:
        ended_dt = ended_dt.replace(tzinfo=UTC)

    for row in rows:
        run_id = str(row["run_id"])
        run_group_id = str(row["run_group_id"])
        started_raw = str(row["started_at"])

        duration_seconds: float | None = None
        try:
            started_dt = datetime.fromisoformat(started_raw)
            if started_dt.tzinfo is None:
                started_dt = started_dt.replace(tzinfo=UTC)
            duration_seconds = max(0.0, (ended_dt - started_dt).total_seconds())
        except ValueError:
            duration_seconds = None

        conn.execute(
            """
            UPDATE benchmark_runs
            SET
                status = 'failed',
                ended_at = ?,
                duration_seconds = ?,
                metrics_json = ?,
                error = ?,
                result_json_path = NULL
            WHERE run_id = ?
            """,
            (
                ended_at,
                duration_seconds,
                metrics_json,
                "Recovered stale running run from interrupted orchestrator process",
                run_id,
            ),
        )
        recovered_ids.append(run_id)
        touched_groups.add(run_group_id)

    for run_group_id in sorted(touched_groups):
        still_running = conn.execute(
            """
            SELECT 1
            FROM benchmark_runs
            WHERE run_group_id = ? AND status = 'running'
            LIMIT 1
            """,
            (run_group_id,),
        ).fetchone()
        if still_running is None:
            conn.execute(
                """
                UPDATE run_groups
                SET finished_at = COALESCE(finished_at, ?)
                WHERE run_group_id = ?
                """,
                (ended_at, run_group_id),
            )

    conn.commit()
    return recovered_ids
