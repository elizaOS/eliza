"""
SQLite storage for benchmark results.

Schema per implementation plan:
- runs: Run configuration and metadata
- trials: Per-trial results
- tasks: Per-task results  
- scores: Aggregate scores
"""

import json
import sqlite3
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from gauntlet.harness.metrics_collector import RunMetrics, TaskMetrics
from gauntlet.scoring.engine import OverallScore


class SQLiteStorage:
    """
    SQLite-based storage for benchmark results.
    
    Provides persistence for:
    - Run configurations and seeds
    - Per-task metrics
    - Computed scores
    """

    SCHEMA = """
    -- Run configuration
    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        benchmark_version TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        started_at REAL NOT NULL,
        completed_at REAL,
        seed INTEGER NOT NULL,
        config_json TEXT NOT NULL
    );

    -- Per-trial results  
    CREATE TABLE IF NOT EXISTS trials (
        trial_id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(run_id),
        scenario_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        score REAL,
        metrics_json TEXT NOT NULL
    );

    -- Per-task results
    CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(run_id),
        trial_id TEXT,
        level INTEGER,
        scenario_id TEXT,
        task_type TEXT NOT NULL,
        agent_action TEXT NOT NULL,
        outcome_classification TEXT NOT NULL,
        transaction_signature TEXT,
        duration_ms INTEGER,
        metrics_json TEXT NOT NULL
    );

    -- Aggregate scores
    CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT REFERENCES runs(run_id),
        level INTEGER,
        score_type TEXT NOT NULL,
        value REAL NOT NULL,
        passed INTEGER NOT NULL
    );
    
    -- Create indices
    CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
    CREATE INDEX IF NOT EXISTS idx_scores_run ON scores(run_id);
    """

    def __init__(self, db_path: Path):
        """
        Initialize storage with database path.
        
        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    def initialize(self) -> None:
        """Initialize database with schema."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.executescript(self.SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        """Close database connection."""
        if self._conn:
            self._conn.close()
            self._conn = None

    def save_run(self, run_metrics: RunMetrics, config: dict) -> None:
        """
        Save a complete run to the database.
        
        Args:
            run_metrics: Collected run metrics
            config: Run configuration dict
        """
        if not self._conn:
            raise RuntimeError("Database not initialized")

        cursor = self._conn.cursor()

        # Insert run
        cursor.execute(
            """
            INSERT INTO runs (run_id, benchmark_version, agent_id, started_at, completed_at, seed, config_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_metrics.run_id,
                run_metrics.benchmark_version,
                run_metrics.agent_id,
                run_metrics.started_at,
                run_metrics.completed_at,
                run_metrics.seed,
                json.dumps(config),
            ),
        )

        # Insert tasks
        for task in run_metrics.task_metrics:
            tx_sig = None
            if task.transaction_metrics:
                tx_sig = task.transaction_metrics.transaction_signature

            cursor.execute(
                """
                INSERT INTO tasks (task_id, run_id, level, scenario_id, task_type, agent_action, 
                                   outcome_classification, transaction_signature, duration_ms, metrics_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task.task_id,
                    run_metrics.run_id,
                    task.level,
                    task.scenario_id,
                    task.task_type.value,
                    task.agent_action,
                    task.outcome_classification.value,
                    tx_sig,
                    task.duration_ms,
                    json.dumps(self._task_to_dict(task)),
                ),
            )

        self._conn.commit()

    def save_scores(self, run_id: str, overall_score: OverallScore) -> None:
        """
        Save computed scores to the database.
        
        Args:
            run_id: Run identifier
            overall_score: Computed overall score
        """
        if not self._conn:
            raise RuntimeError("Database not initialized")

        cursor = self._conn.cursor()

        # Save overall metrics
        for metric, value in [
            ("overall", overall_score.overall_score),
            ("task_completion", overall_score.avg_task_completion),
            ("safety", overall_score.avg_safety),
            ("efficiency", overall_score.avg_efficiency),
            ("capital", overall_score.avg_capital),
        ]:
            cursor.execute(
                """
                INSERT INTO scores (run_id, level, score_type, value, passed)
                VALUES (?, NULL, ?, ?, ?)
                """,
                (run_id, metric, value, int(overall_score.passed)),
            )

        # Save per-level scores
        for level, level_score in overall_score.level_scores.items():
            cursor.execute(
                """
                INSERT INTO scores (run_id, level, score_type, value, passed)
                VALUES (?, ?, 'level_score', ?, ?)
                """,
                (run_id, level, level_score.raw_score, int(level_score.passed)),
            )

        self._conn.commit()

    def get_run(self, run_id: str) -> Optional[dict]:
        """Retrieve a run by ID."""
        if not self._conn:
            raise RuntimeError("Database not initialized")

        cursor = self._conn.cursor()
        cursor.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,))
        row = cursor.fetchone()

        if row:
            return {
                "run_id": row[0],
                "benchmark_version": row[1],
                "agent_id": row[2],
                "started_at": row[3],
                "completed_at": row[4],
                "seed": row[5],
                "config": json.loads(row[6]),
            }
        return None

    def get_scores(self, run_id: str) -> list[dict]:
        """Retrieve all scores for a run."""
        if not self._conn:
            raise RuntimeError("Database not initialized")

        cursor = self._conn.cursor()
        cursor.execute("SELECT * FROM scores WHERE run_id = ?", (run_id,))

        return [
            {
                "level": row[2],
                "score_type": row[3],
                "value": row[4],
                "passed": bool(row[5]),
            }
            for row in cursor.fetchall()
        ]

    def _task_to_dict(self, task: TaskMetrics) -> dict:
        """Convert TaskMetrics to serializable dict."""
        d = {
            "task_id": task.task_id,
            "task_type": task.task_type.value,
            "agent_action": task.agent_action,
            "outcome_classification": task.outcome_classification.value,
            "explanation_provided": task.explanation_provided,
            "explanation_correct": task.explanation_correct,
            "duration_ms": task.duration_ms,
            "balance_before": task.balance_before,
            "balance_after": task.balance_after,
        }
        if task.transaction_metrics:
            d["transaction"] = {
                "signature": task.transaction_metrics.transaction_signature,
                "success": task.transaction_metrics.success,
                "cu_requested": task.transaction_metrics.compute_units_requested,
                "cu_consumed": task.transaction_metrics.compute_units_consumed,
                "fee_lamports": task.transaction_metrics.total_fee_lamports,
                "retry_count": task.transaction_metrics.retry_count,
            }
        return d
