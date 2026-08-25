"""Persist training benchmark results and expose their recent history.

The training package owns this SQLite store because its evaluation, comparison,
matrix, and adaptive-synthesis tools are its producers and consumers.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

SCHEMA_VERSION = 1
_ENV_DB_PATH = "ELIZA_BENCHMARK_RESULTS_DB"


def default_db_path() -> Path:
    """Resolve the benchmark database path, honoring the public override."""
    override = os.environ.get(_ENV_DB_PATH, "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".eliza" / "benchmarks" / "results.db"


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS benchmark_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id        TEXT    NOT NULL,
    benchmark       TEXT    NOT NULL,
    score           REAL    NOT NULL,
    ts              INTEGER NOT NULL,
    dataset_version TEXT    NOT NULL,
    code_commit     TEXT    NOT NULL,
    raw_json        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_benchmark_ts
    ON benchmark_runs (model_id, benchmark, ts DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_benchmark_ts
    ON benchmark_runs (benchmark, ts DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model_ts
    ON benchmark_runs (model_id, ts DESC);
"""


@dataclass(frozen=True)
class BenchmarkRun:
    """A single persisted benchmark result."""

    id: int
    model_id: str
    benchmark: str
    score: float
    ts: int
    dataset_version: str
    code_commit: str
    raw_json: str

    def raw(self) -> Mapping[str, object]:
        """Parse the canonical JSON payload."""
        parsed = json.loads(self.raw_json)
        if not isinstance(parsed, dict):
            raise ValueError(
                "benchmark_runs.raw_json must decode to an object, "
                f"got {type(parsed).__name__}"
            )
        return parsed


@dataclass(frozen=True)
class ComparisonResult:
    """Latest pairwise score delta for two models on one benchmark."""

    benchmark: str
    model_a: str
    model_b: str
    a_run: BenchmarkRun | None
    b_run: BenchmarkRun | None
    delta: float | None = field(default=None)

    @classmethod
    def from_runs(
        cls,
        *,
        benchmark: str,
        model_a: str,
        model_b: str,
        a_run: BenchmarkRun | None,
        b_run: BenchmarkRun | None,
    ) -> "ComparisonResult":
        delta = a_run.score - b_run.score if a_run and b_run else None
        return cls(benchmark, model_a, model_b, a_run, b_run, delta)


class ResultsStore:
    """Append-only benchmark result store backed by SQLite."""

    def __init__(self, db_path: str | os.PathLike[str] | None = None) -> None:
        self._db_path = (
            Path(db_path).expanduser().resolve()
            if db_path is not None
            else default_db_path()
        )
        self._conn: sqlite3.Connection | None = None

    @property
    def db_path(self) -> Path:
        return self._db_path

    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        conn.executescript(_SCHEMA_SQL)
        conn.commit()
        self._conn = conn
        return conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "ResultsStore":
        self._connect()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def record_run(
        self,
        *,
        model_id: str,
        benchmark: str,
        score: float,
        dataset_version: str,
        code_commit: str,
        raw_json: Mapping[str, object] | str,
        ts: int | None = None,
    ) -> int:
        """Insert a benchmark run and return its row id."""
        if not model_id:
            raise ValueError("model_id is required")
        if not benchmark:
            raise ValueError("benchmark is required")
        if not dataset_version:
            raise ValueError("dataset_version is required")
        if not code_commit:
            raise ValueError("code_commit is required")
        if isinstance(raw_json, str):
            json.loads(raw_json)
            raw_text = raw_json
        else:
            raw_text = json.dumps(raw_json, sort_keys=True, separators=(",", ":"))
        recorded_ts = ts if ts is not None else int(time.time() * 1000)
        cursor = self._connect().execute(
            """
            INSERT INTO benchmark_runs (
                model_id, benchmark, score, ts,
                dataset_version, code_commit, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                model_id,
                benchmark,
                float(score),
                recorded_ts,
                dataset_version,
                code_commit,
                raw_text,
            ),
        )
        self._connect().commit()
        if cursor.lastrowid is None:
            raise RuntimeError("INSERT did not return a lastrowid")
        return int(cursor.lastrowid)

    def get_history(
        self, *, model_id: str, benchmark: str, limit: int = 100
    ) -> list[BenchmarkRun]:
        """Return matching runs newest first."""
        if limit <= 0:
            raise ValueError("limit must be a positive integer")
        rows = self._connect().execute(
            """
            SELECT id, model_id, benchmark, score, ts,
                   dataset_version, code_commit, raw_json
              FROM benchmark_runs
             WHERE model_id = ? AND benchmark = ?
             ORDER BY ts DESC, id DESC
             LIMIT ?
            """,
            (model_id, benchmark, int(limit)),
        ).fetchall()
        return [_row_to_run(row) for row in rows]

    def get_latest_for_model(self, *, model_id: str) -> dict[str, BenchmarkRun]:
        """Return the latest run for each benchmark recorded for a model."""
        rows = self._connect().execute(
            """
            SELECT b.id, b.model_id, b.benchmark, b.score, b.ts,
                   b.dataset_version, b.code_commit, b.raw_json
              FROM benchmark_runs AS b
             WHERE b.model_id = ?
               AND b.ts = (
                   SELECT MAX(ts) FROM benchmark_runs
                    WHERE model_id = b.model_id AND benchmark = b.benchmark
               )
            """,
            (model_id,),
        ).fetchall()
        latest: dict[str, BenchmarkRun] = {}
        for row in rows:
            run = _row_to_run(row)
            existing = latest.get(run.benchmark)
            if existing is None or run.id > existing.id:
                latest[run.benchmark] = run
        return latest

    def compare(
        self, *, model_a: str, model_b: str, benchmark: str
    ) -> ComparisonResult:
        """Compare the latest scores for two models."""
        a_history = self.get_history(model_id=model_a, benchmark=benchmark, limit=1)
        b_history = self.get_history(model_id=model_b, benchmark=benchmark, limit=1)
        return ComparisonResult.from_runs(
            benchmark=benchmark,
            model_a=model_a,
            model_b=model_b,
            a_run=a_history[0] if a_history else None,
            b_run=b_history[0] if b_history else None,
        )


def _row_to_run(row: sqlite3.Row) -> BenchmarkRun:
    return BenchmarkRun(
        id=int(row["id"]),
        model_id=str(row["model_id"]),
        benchmark=str(row["benchmark"]),
        score=float(row["score"]),
        ts=int(row["ts"]),
        dataset_version=str(row["dataset_version"]),
        code_commit=str(row["code_commit"]),
        raw_json=str(row["raw_json"]),
    )
