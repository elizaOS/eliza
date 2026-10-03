"""
Benchmark trending results store (gap M2).

Scaffold for the Eliza-1 pipeline benchmark trending DB. Stores
``(model_id, benchmark, score, ts, dataset_version, code_commit, raw_json)``
tuples in a small SQLite database so the trending dashboard and the
promotion gate can query per-model history and pairwise comparisons
without re-running every benchmark.

Storage layout
==============

Default path: ``~/.eliza/benchmarks/results.db``. Override via the
``ELIZA_BENCHMARK_RESULTS_DB`` env var or by passing ``db_path`` to
:class:`ResultsStore`.

The database has a single table::

    CREATE TABLE benchmark_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id        TEXT    NOT NULL,
        benchmark       TEXT    NOT NULL,
        score           REAL    NOT NULL,
        ts              INTEGER NOT NULL,        -- unix millis, UTC
        dataset_version TEXT    NOT NULL,
        code_commit     TEXT    NOT NULL,
        raw_json        TEXT    NOT NULL          -- canonical JSON
    );

with composite indexes on ``(model_id, benchmark, ts DESC)`` and
``(benchmark, ts DESC)`` to make the most common queries cheap.

Wave 0 scope
============

This module is intentionally empty of writers in production code paths.
Callers in W1-B* (benchmark adapters, promotion gate) will be the only
producers. The schema is locked in here so those callers can be built
in parallel.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping


# ---------------------------------------------------------------------------
# Schema + path resolution
# ---------------------------------------------------------------------------

SCHEMA_VERSION = 1
_ENV_DB_PATH = "ELIZA_BENCHMARK_RESULTS_DB"


def default_db_path() -> Path:
    """Resolve the default SQLite path for benchmark results.

    Order of precedence:

    1. ``ELIZA_BENCHMARK_RESULTS_DB`` env var (absolute or ``~``-expanded).
    2. ``~/.eliza/benchmarks/results.db``.
    """

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


# ---------------------------------------------------------------------------
# Data classes (read-side DTOs)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BenchmarkRun:
    """A single benchmark result row.

    ``raw_json`` is the canonical JSON-serialized payload as it landed in the
    DB. Use :meth:`raw` to get the parsed mapping.
    """

    id: int
    model_id: str
    benchmark: str
    score: float
    ts: int
    dataset_version: str
    code_commit: str
    raw_json: str

    def raw(self) -> Mapping[str, object]:
        """Parse ``raw_json`` into a mapping. Pure read; never mutates state."""

        parsed = json.loads(self.raw_json)
        if not isinstance(parsed, dict):
            raise ValueError(
                f"benchmark_runs.raw_json must decode to an object, got {type(parsed).__name__}"
            )
        return parsed


@dataclass(frozen=True)
class ComparisonResult:
    """Pairwise score delta for two models on a single benchmark.

    Fields are explicit — no nullable ``score`` to indicate "no data". When a
    side has no recorded run, the corresponding ``*_run`` field is ``None``
    and ``delta`` is also ``None``; the caller decides how to render that.
    """

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
        delta = (
            a_run.score - b_run.score
            if a_run is not None and b_run is not None
            else None
        )
        return cls(
            benchmark=benchmark,
            model_a=model_a,
            model_b=model_b,
            a_run=a_run,
            b_run=b_run,
            delta=delta,
        )


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class ResultsStore:
    """Append-only benchmark results store backed by SQLite.

    Instances own a single :class:`sqlite3.Connection`. The connection is
    created lazily and closed by :meth:`close` or via the context-manager
    protocol.

    Concurrency: SQLite's default journal mode is acceptable for the
    benchmark-trending workload (low write QPS, many reads). Callers that
    need higher throughput can set WAL mode out-of-band.
    """

    def __init__(self, db_path: str | os.PathLike[str] | None = None) -> None:
        self._db_path = (
            Path(db_path).expanduser().resolve()
            if db_path is not None
            else default_db_path()
        )
        self._conn: sqlite3.Connection | None = None

    @property
    def db_path(self) -> Path:
        """Absolute path to the underlying SQLite database file."""

        return self._db_path

    # -- connection / schema ------------------------------------------------

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

    # -- writer -------------------------------------------------------------

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
        """Insert a benchmark run. Returns the new row id.

        ``raw_json`` may be either a mapping (it will be serialized
        deterministically with sorted keys) or an already-serialized string
        (it must parse as JSON; otherwise :class:`ValueError` is raised).

        ``ts`` is unix milliseconds UTC. If omitted, the current wall clock
        is used.
        """

        if not model_id:
            raise ValueError("model_id is required")
        if not benchmark:
            raise ValueError("benchmark is required")
        if not dataset_version:
            raise ValueError("dataset_version is required")
        if not code_commit:
            raise ValueError("code_commit is required")
        if isinstance(raw_json, str):
            json.loads(raw_json)  # validate; reject malformed input at boundary
            raw_text = raw_json
        else:
            raw_text = json.dumps(raw_json, sort_keys=True, separators=(",", ":"))

        recorded_ts = ts if ts is not None else int(time.time() * 1000)

        conn = self._connect()
        cursor = conn.execute(
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
        conn.commit()
        row_id = cursor.lastrowid
        if row_id is None:
            raise RuntimeError("INSERT did not return a lastrowid")
        return int(row_id)

    # -- readers ------------------------------------------------------------

    def get_history(
        self,
        *,
        model_id: str,
        benchmark: str,
        limit: int = 100,
    ) -> list[BenchmarkRun]:
        """Return runs for ``(model_id, benchmark)``, newest first."""

        if limit <= 0:
            raise ValueError("limit must be a positive integer")
        conn = self._connect()
        rows = conn.execute(
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
        return [_row_to_run(r) for r in rows]

    def get_latest_for_model(
        self,
        *,
        model_id: str,
    ) -> dict[str, BenchmarkRun]:
        """Return the latest run per benchmark for ``model_id``.

        Returns an empty dict if the model has no recorded runs.
        """

        conn = self._connect()
        rows = conn.execute(
            """
            SELECT b.id, b.model_id, b.benchmark, b.score, b.ts,
                   b.dataset_version, b.code_commit, b.raw_json
              FROM benchmark_runs AS b
             WHERE b.model_id = ?
               AND b.ts = (
                   SELECT MAX(ts)
                     FROM benchmark_runs
                    WHERE model_id = b.model_id
                      AND benchmark = b.benchmark
               )
            """,
            (model_id,),
        ).fetchall()
        latest: dict[str, BenchmarkRun] = {}
        for r in rows:
            run = _row_to_run(r)
            # Multiple rows may share the same `ts`; pick highest id (most recent insert).
            existing = latest.get(run.benchmark)
            if existing is None or run.id > existing.id:
                latest[run.benchmark] = run
        return latest

    def compare(
        self,
        *,
        model_a: str,
        model_b: str,
        benchmark: str,
    ) -> ComparisonResult:
        """Compare the latest score of ``model_a`` vs ``model_b`` on ``benchmark``.

        ``delta = a.score - b.score`` when both sides have a run; otherwise
        ``None``.
        """

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
