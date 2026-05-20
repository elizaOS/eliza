"""Unified trajectory database backed by SQLite.

This module provides a single class, :class:`TrajectoryDB`, that handles all
read/write operations against a local SQLite file.  The column names are kept
in sync with the production PostgreSQL schema used by the TypeScript side so
that exported JSONL files and SQL queries remain portable.

Environment variables
---------------------
``ELIZA_ROBOT_TRAJ_DB``
    Default path to the SQLite trajectory database.  Used when
    :class:`TrajectoryDB` is instantiated without an explicit ``db_path``.
    Falls back to ``"trajectories.db"`` in the current working directory.
    The repository ``.gitignore`` excludes ``trajectories.db``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from eliza_robot.trajectory_db.schema import ALL_TABLE_DDL, INDEX_DDL

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_JSON_SUFFIX_COLS = frozenset({
    "observation_json",
    "action_params_json",
    "action_result_json",
    "environment_state_json",
    "metadata_json",
    "metrics_json",
    "messages_json",
    "query_json",
    "response_json",
    "reward_components_json",
    "entities_json",
    "camera_views_json",
    "agent_pose_json",
    "joint_positions_json",
    "joint_velocities_json",
    "joint_targets_json",
    "gyro_json",
    "entity_slots_json",
    "action_applied_json",
})


def _new_id() -> str:
    return uuid4().hex


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ts() -> float:
    return time.time()


def _json_or_none(value: object) -> str | None:
    if value is None:
        return None
    return json.dumps(value)


def _parse_json(value: str | None, fallback: object = None) -> object:
    if value is None:
        return fallback
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return fallback


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case."""
    import re
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def _normalize_keys(d: dict, converter) -> dict:
    """Recursively convert all keys of a dict using *converter*."""
    out: dict = {}
    for k, v in d.items():
        new_key = converter(k)
        if isinstance(v, dict):
            out[new_key] = _normalize_keys(v, converter)
        elif isinstance(v, list):
            out[new_key] = [
                _normalize_keys(item, converter) if isinstance(item, dict) else item
                for item in v
            ]
        else:
            out[new_key] = v
    return out


def _row_to_dict(cursor: sqlite3.Cursor, row: tuple) -> dict:
    """Convert a sqlite3 row to a dict, auto-parsing JSON columns."""
    cols = [desc[0] for desc in cursor.description]
    d: dict = {}
    for col, val in zip(cols, row):
        if col in _JSON_SUFFIX_COLS and isinstance(val, str):
            d[col] = _parse_json(val)
        else:
            d[col] = val
    return d


# ---------------------------------------------------------------------------
# Database class
# ---------------------------------------------------------------------------

class TrajectoryDB:
    """Unified trajectory database backed by SQLite."""

    def __init__(self, db_path: str | os.PathLike[str] | None = None) -> None:
        if db_path is None:
            db_path = Path(os.environ.get("ELIZA_ROBOT_TRAJ_DB", "trajectories.db"))
        self._db_path = str(db_path)
        self._conn: sqlite3.Connection | None = None

    # -- lifecycle ----------------------------------------------------------

    @property
    def path(self) -> str:
        return self._db_path

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            parent = os.path.dirname(os.path.abspath(self._db_path))
            os.makedirs(parent, exist_ok=True)
            self._conn = sqlite3.connect(self._db_path)
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA foreign_keys=ON;")
        return self._conn

    def initialize(self) -> None:
        """Create tables and indexes if they don't exist."""
        conn = self._get_conn()
        for ddl in ALL_TABLE_DDL:
            conn.execute(ddl)
        for idx in INDEX_DDL:
            conn.execute(idx)
        conn.commit()

    def close(self) -> None:
        """Close the database connection."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # -- write: trajectories ------------------------------------------------

    def insert_trajectory(self, trajectory: dict) -> str:
        """Insert a trajectory record and optionally its steps.

        *trajectory* can use either camelCase or snake_case keys.
        If a ``steps`` list is present, each step (and its LLM calls /
        provider accesses) will be normalised into the detail tables.

        Returns trajectory_id.
        """
        t = _normalize_keys(trajectory, _camel_to_snake)

        # Extract steps before inserting the trajectory row
        steps_raw = t.pop("steps", None) or t.pop("steps_json", None)

        trajectory_id = t.get("trajectory_id") or _new_id()
        row_id = t.get("id") or _new_id()
        now = _now_iso()

        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO trajectories (
                id, trajectory_id, agent_id, source, archetype, window_id,
                scenario_id, batch_id, episode_id, status,
                start_time, end_time, duration_ms,
                total_reward, reward_components_json,
                ai_judge_reward, ai_judge_reasoning,
                final_status, final_pnl, final_balance,
                episode_length, metrics_json, metadata_json,
                is_training_data, is_evaluation, used_in_training,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?
            )
            """,
            (
                row_id,
                trajectory_id,
                t.get("agent_id", ""),
                t.get("source"),
                t.get("archetype"),
                t.get("window_id"),
                t.get("scenario_id"),
                t.get("batch_id"),
                t.get("episode_id"),
                t.get("status", "active"),
                t.get("start_time"),
                t.get("end_time"),
                t.get("duration_ms"),
                t.get("total_reward", 0.0),
                _json_or_none(t.get("reward_components") or t.get("reward_components_json")),
                t.get("ai_judge_reward"),
                t.get("ai_judge_reasoning"),
                t.get("final_status"),
                t.get("final_pnl"),
                t.get("final_balance"),
                t.get("episode_length", 0),
                _json_or_none(t.get("metrics") or t.get("metrics_json")),
                _json_or_none(t.get("metadata") or t.get("metadata_json")),
                1 if t.get("is_training_data") else 0,
                1 if t.get("is_evaluation") else 0,
                1 if t.get("used_in_training") else 0,
                t.get("created_at") or now,
                t.get("updated_at") or now,
            ),
        )
        conn.commit()

        # Normalise steps if provided
        if steps_raw is not None:
            if isinstance(steps_raw, str):
                try:
                    steps_raw = json.loads(steps_raw)
                except (json.JSONDecodeError, TypeError):
                    steps_raw = []
            if isinstance(steps_raw, list):
                for idx, step_raw in enumerate(steps_raw):
                    if not isinstance(step_raw, dict):
                        continue
                    step = _normalize_keys(step_raw, _camel_to_snake)
                    step.setdefault("step_number", idx)
                    step_id = self.insert_step(trajectory_id, step)
                    # LLM calls
                    for ci, lc in enumerate(step.pop("llm_calls", None) or []):
                        if not isinstance(lc, dict):
                            continue
                        lc = _normalize_keys(lc, _camel_to_snake)
                        lc.setdefault("call_index", ci)
                        self.insert_llm_call(step_id, trajectory_id, lc)
                    # Provider accesses
                    for pa in step.pop("provider_accesses", None) or []:
                        if not isinstance(pa, dict):
                            continue
                        self.insert_provider_access(step_id, trajectory_id, pa)

        return trajectory_id

    # -- write: steps -------------------------------------------------------

    def insert_step(self, trajectory_id: str, step: dict) -> str:
        """Insert a normalised step.  Returns step_id."""
        s = _normalize_keys(step, _camel_to_snake)

        step_id = s.get("step_id") or _new_id()

        # Action may be nested dict or flat fields
        action = s.get("action") or {}
        if isinstance(action, dict):
            action = _normalize_keys(action, _camel_to_snake)

        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO trajectory_steps (
                id, trajectory_id, step_number, timestamp,
                observation_json, action_type, action_name, action_params_json,
                action_success, action_result_json,
                reward, done, environment_state_json, reasoning, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                step_id,
                trajectory_id,
                s.get("step_number", 0),
                s.get("timestamp"),
                _json_or_none(s.get("observation") or s.get("observation_json")),
                action.get("action_type") or s.get("action_type"),
                action.get("action_name") or s.get("action_name"),
                _json_or_none(action.get("parameters") or action.get("action_params_json") or s.get("action_params_json")),
                1 if (action.get("success") if action.get("success") is not None else s.get("action_success", True)) else 0,
                _json_or_none(action.get("result") or action.get("action_result_json") or s.get("action_result_json")),
                s.get("reward", 0.0),
                1 if s.get("done") else 0,
                _json_or_none(s.get("environment_state") or s.get("environment_state_json")),
                action.get("reasoning") or s.get("reasoning"),
                _json_or_none(s.get("metadata") or s.get("metadata_json")),
            ),
        )
        conn.commit()
        return step_id

    # -- write: llm calls ---------------------------------------------------

    def insert_llm_call(self, step_id: str, trajectory_id: str, call: dict) -> str:
        """Insert an LLM call record.  Returns call id."""
        c = _normalize_keys(call, _camel_to_snake)
        call_id = c.get("call_id") or c.get("id") or _new_id()

        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO llm_calls (
                id, step_id, trajectory_id, call_index, timestamp,
                model, system_prompt, user_prompt, messages_json,
                response, reasoning,
                temperature, max_tokens, prompt_tokens, completion_tokens,
                latency_ms, purpose
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                call_id,
                step_id,
                trajectory_id,
                c.get("call_index", 0),
                c.get("timestamp"),
                c.get("model"),
                c.get("system_prompt"),
                c.get("user_prompt"),
                _json_or_none(c.get("messages") or c.get("messages_json")),
                c.get("response"),
                c.get("reasoning"),
                c.get("temperature"),
                c.get("max_tokens"),
                c.get("prompt_tokens"),
                c.get("completion_tokens"),
                c.get("latency_ms"),
                c.get("purpose", "other"),
            ),
        )
        conn.commit()
        return call_id

    # -- write: provider accesses -------------------------------------------

    def insert_provider_access(self, step_id: str, trajectory_id: str, access: dict) -> str:
        """Insert a provider access record.  Returns access id."""
        a = _normalize_keys(access, _camel_to_snake)
        access_id = a.get("provider_id") or a.get("id") or _new_id()

        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO provider_accesses (
                id, step_id, trajectory_id, provider_name,
                query_json, response_json, purpose, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                access_id,
                step_id,
                trajectory_id,
                a.get("provider_name"),
                _json_or_none(a.get("query") or a.get("query_json")),
                _json_or_none(a.get("data") or a.get("response") or a.get("response_json")),
                a.get("purpose"),
                a.get("timestamp"),
            ),
        )
        conn.commit()
        return access_id

    # -- write: control frames ----------------------------------------------

    def insert_control_frame(self, trajectory_id: str, frame: dict) -> None:
        """Insert a high-frequency control frame."""
        f = _normalize_keys(frame, _camel_to_snake)

        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO control_frames (
                trajectory_id, planner_step_id, timestamp,
                joint_positions_json, joint_velocities_json, joint_targets_json,
                imu_roll, imu_pitch, gyro_json,
                entity_slots_json, action_applied_json, reward
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                trajectory_id,
                f.get("planner_step_id"),
                f.get("timestamp", _now_ts()),
                _json_or_none(f.get("joint_positions") or f.get("joint_positions_json")),
                _json_or_none(f.get("joint_velocities") or f.get("joint_velocities_json")),
                _json_or_none(f.get("joint_targets") or f.get("joint_targets_json")),
                f.get("imu_roll", 0.0),
                f.get("imu_pitch", 0.0),
                _json_or_none(f.get("gyro") or f.get("gyro_json")),
                _json_or_none(f.get("entity_slots") or f.get("entity_slots_json")),
                _json_or_none(f.get("action_applied") or f.get("action_applied_json")),
                f.get("reward", 0.0),
            ),
        )
        conn.commit()

    # -- write: embodied contexts -------------------------------------------

    def insert_embodied_context(self, trajectory_id: str, context: dict) -> str:
        """Insert an embodied context snapshot.  Returns context id."""
        c = _normalize_keys(context, _camel_to_snake)
        ctx_id = c.get("id") or _new_id()

        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO embodied_contexts (
                id, trajectory_id, step_id, timestamp,
                entities_json, camera_views_json, agent_pose_json,
                task_description, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ctx_id,
                trajectory_id,
                c.get("step_id"),
                c.get("timestamp"),
                _json_or_none(c.get("entities") or c.get("entities_json")),
                _json_or_none(c.get("camera_views") or c.get("camera_views_json")),
                _json_or_none(c.get("agent_pose") or c.get("agent_pose_json")),
                c.get("task_description"),
                c.get("source"),
            ),
        )
        conn.commit()
        return ctx_id

    # -- write: completion --------------------------------------------------

    def complete_trajectory(self, trajectory_id: str, status: str, metrics: dict) -> None:
        """Mark a trajectory as completed with final metrics."""
        now = _now_iso()
        conn = self._get_conn()
        conn.execute(
            """
            UPDATE trajectories SET
                status = ?,
                end_time = ?,
                final_status = ?,
                total_reward = COALESCE(?, total_reward),
                ai_judge_reward = COALESCE(?, ai_judge_reward),
                ai_judge_reasoning = COALESCE(?, ai_judge_reasoning),
                final_pnl = COALESCE(?, final_pnl),
                final_balance = COALESCE(?, final_balance),
                episode_length = COALESCE(?, episode_length),
                metrics_json = ?,
                updated_at = ?
            WHERE trajectory_id = ?
            """,
            (
                status,
                _now_ts(),
                status,
                metrics.get("total_reward"),
                metrics.get("ai_judge_reward"),
                metrics.get("ai_judge_reasoning"),
                metrics.get("final_pnl"),
                metrics.get("final_balance"),
                metrics.get("episode_length"),
                _json_or_none(metrics),
                now,
                trajectory_id,
            ),
        )
        conn.commit()

    # -- bulk import --------------------------------------------------------

    def import_from_json(self, json_path: str) -> int:
        """Import trajectories from a JSON or JSONL file.

        Each line (or top-level array element) is treated as a trajectory dict
        with an optional ``steps`` (or ``stepsJson``) field that will be
        normalized into the steps table.

        Returns the count of trajectories imported.
        """
        path = Path(json_path)
        raw = path.read_text(encoding="utf-8").strip()

        records: list[dict]
        if raw.startswith("["):
            records = json.loads(raw)
        else:
            records = [json.loads(line) for line in raw.splitlines() if line.strip()]

        return self._import_records(records)

    def import_from_postgres_dump(self, rows: list[dict]) -> int:
        """Import from PostgreSQL-style trajectory rows.

        Each dict is expected to have the shape produced by the TS
        ``export-planner-trajectories`` script:  metadata/steps/metrics as
        JSON blobs (either already parsed or stringified).  Steps are
        normalized into the ``trajectory_steps`` table.

        Returns the count of trajectories imported.
        """
        return self._import_records(rows)

    def _import_records(self, records: list[dict]) -> int:
        count = 0
        for rec in records:
            r = _normalize_keys(rec, _camel_to_snake)

            # Resolve embedded steps blob — pop BOTH variants to prevent
            # insert_trajectory from finding them and double-inserting.
            steps_raw = r.pop("steps", None)
            steps_json_raw = r.pop("steps_json", None)
            steps_raw = steps_raw or steps_json_raw
            if isinstance(steps_raw, str):
                try:
                    steps_raw = json.loads(steps_raw)
                except (json.JSONDecodeError, TypeError):
                    steps_raw = []
            steps: list[dict] = steps_raw if isinstance(steps_raw, list) else []

            # Insert trajectory row
            trajectory_id = self.insert_trajectory(r)

            # Normalise + insert each step
            for idx, step_raw in enumerate(steps):
                if not isinstance(step_raw, dict):
                    continue
                step = _normalize_keys(step_raw, _camel_to_snake)
                step.setdefault("step_number", idx)
                step_id = self.insert_step(trajectory_id, step)

                # LLM calls
                llm_calls = step.pop("llm_calls", None) or []
                for ci, lc in enumerate(llm_calls):
                    if not isinstance(lc, dict):
                        continue
                    lc = _normalize_keys(lc, _camel_to_snake)
                    lc.setdefault("call_index", ci)
                    self.insert_llm_call(step_id, trajectory_id, lc)

                # Provider accesses
                provider_accesses = step.pop("provider_accesses", None) or []
                for pa in provider_accesses:
                    if not isinstance(pa, dict):
                        continue
                    self.insert_provider_access(step_id, trajectory_id, pa)

            count += 1
        return count

    # -- read: trajectories -------------------------------------------------

    def get_trajectory(self, trajectory_id: str) -> dict | None:
        """Get a trajectory with all its steps, LLM calls, and provider accesses."""
        conn = self._get_conn()
        cur = conn.execute(
            "SELECT * FROM trajectories WHERE trajectory_id = ?",
            (trajectory_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None

        traj = _row_to_dict(cur, row)

        # Attach steps
        traj["steps"] = self.get_steps(trajectory_id)

        # Attach LLM calls and provider accesses to each step
        for step in traj["steps"]:
            step["llm_calls"] = self.get_llm_calls(step["id"])
            step["provider_accesses"] = self._get_provider_accesses(step["id"])

        return traj

    def list_trajectories(
        self,
        agent_id: str | None = None,
        archetype: str | None = None,
        source: str | None = None,
        min_reward: float | None = None,
        is_training: bool | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """List trajectories with filtering."""
        clauses: list[str] = []
        params: list[object] = []

        if agent_id is not None:
            clauses.append("agent_id = ?")
            params.append(agent_id)
        if archetype is not None:
            clauses.append("archetype = ?")
            params.append(archetype)
        if source is not None:
            clauses.append("source = ?")
            params.append(source)
        if min_reward is not None:
            clauses.append("total_reward >= ?")
            params.append(min_reward)
        if is_training is not None:
            clauses.append("is_training_data = ?")
            params.append(1 if is_training else 0)

        where = ""
        if clauses:
            where = "WHERE " + " AND ".join(clauses)

        sql = f"SELECT * FROM trajectories {where} ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        conn = self._get_conn()
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
        return [_row_to_dict(cur, r) for r in rows]

    # -- read: steps --------------------------------------------------------

    def get_steps(self, trajectory_id: str) -> list[dict]:
        """Get all steps for a trajectory, ordered by step_number."""
        conn = self._get_conn()
        cur = conn.execute(
            "SELECT * FROM trajectory_steps WHERE trajectory_id = ? ORDER BY step_number",
            (trajectory_id,),
        )
        return [_row_to_dict(cur, r) for r in cur.fetchall()]

    # -- read: LLM calls ----------------------------------------------------

    def get_llm_calls(self, step_id: str) -> list[dict]:
        """Get all LLM calls for a step."""
        conn = self._get_conn()
        cur = conn.execute(
            "SELECT * FROM llm_calls WHERE step_id = ? ORDER BY call_index",
            (step_id,),
        )
        return [_row_to_dict(cur, r) for r in cur.fetchall()]

    # -- read: provider accesses (internal) ---------------------------------

    def _get_provider_accesses(self, step_id: str) -> list[dict]:
        conn = self._get_conn()
        cur = conn.execute(
            "SELECT * FROM provider_accesses WHERE step_id = ? ORDER BY timestamp",
            (step_id,),
        )
        return [_row_to_dict(cur, r) for r in cur.fetchall()]

    # -- read: control frames -----------------------------------------------

    def get_control_frames(
        self,
        trajectory_id: str,
        start_time: float | None = None,
        end_time: float | None = None,
    ) -> list[dict]:
        """Get control frames for a trajectory within optional time range."""
        clauses = ["trajectory_id = ?"]
        params: list[object] = [trajectory_id]

        if start_time is not None:
            clauses.append("timestamp >= ?")
            params.append(start_time)
        if end_time is not None:
            clauses.append("timestamp <= ?")
            params.append(end_time)

        where = "WHERE " + " AND ".join(clauses)
        conn = self._get_conn()
        cur = conn.execute(
            f"SELECT * FROM control_frames {where} ORDER BY timestamp",
            params,
        )
        return [_row_to_dict(cur, r) for r in cur.fetchall()]

    # -- read: training batch -----------------------------------------------

    def get_training_batch(
        self,
        archetype: str | None = None,
        min_score: float | None = None,
        limit: int = 1000,
    ) -> list[dict]:
        """Get trajectories suitable for training.

        Returns completed trajectories that are flagged as training data,
        optionally filtered by archetype and minimum total reward.
        """
        clauses: list[str] = [
            "status IN ('completed', 'terminated')",
            "is_training_data = 1",
        ]
        params: list[object] = []

        if archetype is not None:
            clauses.append("archetype = ?")
            params.append(archetype)
        if min_score is not None:
            clauses.append("total_reward >= ?")
            params.append(min_score)

        where = "WHERE " + " AND ".join(clauses)
        sql = f"SELECT * FROM trajectories {where} ORDER BY total_reward DESC LIMIT ?"
        params.append(limit)

        conn = self._get_conn()
        cur = conn.execute(sql, params)
        results: list[dict] = []
        for row in cur.fetchall():
            traj = _row_to_dict(cur, row)
            traj["steps"] = self.get_steps(traj["trajectory_id"])
            results.append(traj)
        return results

    # -- stats --------------------------------------------------------------

    def get_stats(self) -> dict:
        """Get database statistics."""
        conn = self._get_conn()
        stats: dict = {}

        for table in (
            "trajectories",
            "trajectory_steps",
            "llm_calls",
            "provider_accesses",
            "control_frames",
            "embodied_contexts",
        ):
            cur = conn.execute(f"SELECT COUNT(*) FROM {table}")  # noqa: S608
            stats[f"{table}_count"] = cur.fetchone()[0]

        # Trajectory status breakdown
        cur = conn.execute(
            "SELECT status, COUNT(*) FROM trajectories GROUP BY status"
        )
        stats["status_counts"] = dict(cur.fetchall())

        # Source breakdown
        cur = conn.execute(
            "SELECT source, COUNT(*) FROM trajectories WHERE source IS NOT NULL GROUP BY source"
        )
        stats["source_counts"] = dict(cur.fetchall())

        # Reward stats
        cur = conn.execute(
            "SELECT MIN(total_reward), MAX(total_reward), AVG(total_reward) "
            "FROM trajectories WHERE total_reward IS NOT NULL"
        )
        row = cur.fetchone()
        stats["reward_min"] = row[0]
        stats["reward_max"] = row[1]
        stats["reward_avg"] = row[2]

        # Training data count
        cur = conn.execute(
            "SELECT COUNT(*) FROM trajectories WHERE is_training_data = 1"
        )
        stats["training_trajectories"] = cur.fetchone()[0]

        return stats

    # -- export: RLDS -------------------------------------------------------

    def export_rlds(self, trajectory_ids: list[str], output_dir: str) -> str:
        """Export trajectories in RLDS-compatible format.

        Each trajectory becomes a JSON file with the RLDS episode structure:
        ``{steps: [{observation, action, reward, is_terminal, ...}]}``.

        Returns the output directory path.
        """
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        for tid in trajectory_ids:
            traj = self.get_trajectory(tid)
            if traj is None:
                continue

            rlds_steps: list[dict] = []
            for step in traj.get("steps", []):
                rlds_steps.append({
                    "observation": step.get("observation_json") or step.get("environment_state_json") or {},
                    "action": {
                        "type": step.get("action_type", ""),
                        "name": step.get("action_name", ""),
                        "params": step.get("action_params_json") or {},
                    },
                    "reward": step.get("reward", 0.0),
                    "is_terminal": bool(step.get("done")),
                    "is_first": step.get("step_number", 0) == 0,
                    "is_last": bool(step.get("done")),
                })

            episode = {
                "trajectory_id": tid,
                "agent_id": traj.get("agent_id"),
                "steps": rlds_steps,
                "metadata": {
                    "total_reward": traj.get("total_reward"),
                    "status": traj.get("status"),
                    "source": traj.get("source"),
                },
            }

            ep_path = out / f"{tid}.json"
            ep_path.write_text(json.dumps(episode, indent=2), encoding="utf-8")

        return str(out)

    # -- export: ART --------------------------------------------------------

    def export_art(self, trajectory_ids: list[str]) -> list[dict]:
        """Export trajectories in ART/OpenPipe format.

        Returns a list of dicts, each with ``messages``, ``reward``, and
        ``metadata`` matching the ART trajectory schema.
        """
        results: list[dict] = []
        for tid in trajectory_ids:
            traj = self.get_trajectory(tid)
            if traj is None:
                continue

            messages: list[dict] = []
            actions_taken: list[str] = []
            errors: list[str] = []

            for step in traj.get("steps", []):
                # Collect LLM calls as assistant/user turns
                llm_calls = step.get("llm_calls", [])
                for lc in llm_calls:
                    if lc.get("system_prompt") and not messages:
                        messages.append({
                            "role": "system",
                            "content": lc["system_prompt"],
                        })
                    if lc.get("user_prompt"):
                        messages.append({
                            "role": "user",
                            "content": lc["user_prompt"],
                        })
                    if lc.get("response"):
                        messages.append({
                            "role": "assistant",
                            "content": lc["response"],
                        })

                action_name = step.get("action_name", "")
                if action_name:
                    actions_taken.append(action_name)
                if not step.get("action_success"):
                    result_json = step.get("action_result_json")
                    err = ""
                    if isinstance(result_json, dict):
                        err = result_json.get("error", "action failed")
                    else:
                        err = "action failed"
                    errors.append(err)

            # If no messages came from LLM calls, create a minimal summary
            if not messages:
                messages.append({
                    "role": "system",
                    "content": "Trajectory replay",
                })
                messages.append({
                    "role": "user",
                    "content": f"Execute trajectory {tid}",
                })
                messages.append({
                    "role": "assistant",
                    "content": json.dumps({"actions": actions_taken}),
                })

            metrics_json = traj.get("metrics_json") or {}
            metadata_json = traj.get("metadata_json") or {}

            art_record: dict = {
                "messages": messages,
                "reward": traj.get("total_reward", 0.0),
                "metadata": {
                    "trajectoryId": tid,
                    "agentId": traj.get("agent_id", ""),
                    "scenarioId": traj.get("scenario_id"),
                    "environmentContext": {
                        "initialBalance": (metadata_json.get("initial_balance")
                                           or metadata_json.get("initialBalance")
                                           or 0),
                        "finalBalance": traj.get("final_balance") or 0,
                        "initialPnL": 0,
                        "finalPnL": traj.get("final_pnl") or 0,
                        "actionsTaken": actions_taken,
                        "errors": errors,
                    },
                    "metrics": metrics_json if isinstance(metrics_json, dict) else {},
                },
            }
            results.append(art_record)
        return results
