"""
Babylon Trajectory Reader

Reads trajectories from PostgreSQL database or local JSON files for training.
Validates LLM call quality to ensure training data authenticity.
"""

import json
import os
from dataclasses import dataclass
from typing import Optional, List, Dict
from pathlib import Path
import logging

# Handle optional psycopg2 import for JSON-only workflows.
try:
    import psycopg2
except ImportError:
    psycopg2 = None

logger = logging.getLogger(__name__)


@dataclass
class TrajectoryRow:
    """Raw trajectory data from database. Used by PostgresTrajectoryReader."""

    trajectory_id: str
    agent_id: str
    window_id: str
    steps_json: str
    metrics_json: str
    metadata_json: str
    total_reward: float
    episode_length: int
    final_status: str
    final_pnl: Optional[float]
    trades_executed: Optional[int]
    ai_judge_reward: Optional[float]
    archetype: Optional[str]


def get_connection():
    """
    Get PostgreSQL connection from environment.

    Returns:
        psycopg2 connection

    Raises:
        ValueError: If DATABASE_URL not set
        ImportError: If psycopg2 is not installed
    """
    if psycopg2 is None:
        raise ImportError(
            "psycopg2 is not installed. Please install it with 'pip install psycopg2-binary'")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL environment variable required")
    return psycopg2.connect(database_url)


def validate_llm_calls(steps: list, min_steps_with_llm: int = 3) -> tuple[bool, list[str]]:
    """
    Validate trajectory steps contain real LLM calls.

    Training data MUST have actual LLM calls with real prompts and responses.
    Synthetic or placeholder data will cause training failures.

    Args:
        steps: List of trajectory steps
        min_steps_with_llm: Minimum steps with valid LLM calls

    Returns:
        Tuple of (is_valid, list of issue descriptions)
    """
    issues: list[str] = []
    steps_with_llm = 0

    if not steps:
        issues.append("Trajectory has no steps.")
        return False, issues

    for i, step in enumerate(steps):
        llm_calls = step.get("llmCalls") or step.get("llm_calls") or []
        if not llm_calls:
            continue

        valid_calls_in_step = 0
        for call_idx, call in enumerate(llm_calls):
            system_prompt = call.get("systemPrompt") or call.get(
                "system_prompt") or ""
            user_prompt = call.get("userPrompt") or call.get(
                "user_prompt") or ""
            response = call.get("response") or ""

            call_issues = []
            if len(system_prompt) < 20:
                call_issues.append("system_prompt too short")
            if len(user_prompt) < 20:
                call_issues.append("user_prompt too short")
            if len(response) < 20:
                call_issues.append("response too short")

            if not call_issues:
                valid_calls_in_step += 1
            else:
                issues.append(
                    f"Step {i}, Call {call_idx}: " + ", ".join(call_issues))

        if valid_calls_in_step > 0:
            steps_with_llm += 1

    if steps_with_llm < min_steps_with_llm:
        issues.append(
            f"Only {steps_with_llm}/{len(steps)} steps have valid LLM calls (need at least {min_steps_with_llm})")

    return len(issues) == 0, issues


class PostgresTrajectoryReader:
    """Reads Babylon trajectories from a PostgreSQL database."""

    def __init__(self, database_url: str):
        if psycopg2 is None:
            raise ImportError(
                "psycopg2 is not installed for PostgresTrajectoryReader. Please install it with 'pip install psycopg2-binary'")
        if not database_url:
            raise ValueError(
                "DATABASE_URL must be provided for PostgresTrajectoryReader")
        self.db_url = database_url
        self.conn = None

    async def __aenter__(self):
        """Connect to the database upon entering the async context."""
        # Check to satisfy Pylance's static analysis
        if psycopg2 is None:
            raise ImportError(
                "psycopg2 is not installed, cannot connect to database.")
        self.conn = psycopg2.connect(self.db_url)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Close the database connection upon exiting the context."""
        if self.conn:
            self.conn.close()

    async def get_window_ids(self, limit: int = 100, only_scored: bool = True, lookback_hours: int = 168, min_agents: int = 1) -> list[str]:
        if not self.conn:
            raise ConnectionError("Database not connected.")
        with self.conn.cursor() as cur:
            query = """
                SELECT DISTINCT "windowId" FROM trajectories
                WHERE "isTrainingData" = true AND "createdAt" > NOW() - INTERVAL '%s hours'
            """
            params = [lookback_hours]
            if only_scored:
                query += ' AND "aiJudgeReward" IS NOT NULL'
            query += ' ORDER BY "windowId" DESC LIMIT %s'
            params.append(limit)
            cur.execute(query, tuple(params))
            return [row[0] for row in cur.fetchall() if row[0]]

    async def get_trajectories_by_window(
        self, window_id: str, min_score: Optional[float] = None,
        validate: bool = True, min_actions: int = 1
    ) -> list[TrajectoryRow]:
        if not self.conn:
            raise ConnectionError("Database not connected.")
        with self.conn.cursor() as cur:
            query = """
                SELECT "trajectoryId", "agentId", "windowId", "stepsJson", "metricsJson", "metadataJson",
                       "totalReward", "episodeLength", "finalStatus", "finalPnL", "tradesExecuted",
                       "aiJudgeReward", "archetype"
                FROM trajectories WHERE "windowId" = %s AND "isTrainingData" = true AND "episodeLength" >= %s
            """
            params: list = [window_id, min_actions]
            if min_score is not None:
                query += ' AND "aiJudgeReward" >= %s'
                params.append(min_score)
            cur.execute(query, tuple(params))
            rows = cur.fetchall()

        results = []
        for row in rows:
            trajectory = TrajectoryRow(
                trajectory_id=row[0], agent_id=row[1], window_id=row[2], steps_json=row[3],
                metrics_json=row[4], metadata_json=row[5], total_reward=float(
                    row[6] or 0.0),
                episode_length=int(row[7] or 0), final_status=row[8] or "unknown",
                final_pnl=float(row[9]) if row[9] else None, trades_executed=int(row[10]) if row[10] else None,
                ai_judge_reward=float(row[11]) if row[11] else None, archetype=row[12],
            )
            if validate:
                try:
                    steps = json.loads(trajectory.steps_json)
                    is_valid, issues = validate_llm_calls(steps)
                    if not is_valid:
                        logger.debug(
                            f"Skipping DB trajectory {trajectory.trajectory_id}: {issues}")
                        continue
                except (json.JSONDecodeError, TypeError):
                    logger.warning(
                        f"Could not parse steps_json for trajectory {trajectory.trajectory_id}")
                    continue
            results.append(trajectory)
        return results


class JsonTrajectoryReader:
    """Reads Babylon trajectories from a local directory of JSON files."""

    def __init__(self, directory_path: str):
        self._directory = Path(directory_path)
        self._trajectories_by_window: Dict[str, List[Dict]] = {}

        if not self._directory.is_dir():
            raise FileNotFoundError(
                f"Source directory not found: {self._directory.resolve()}")

        self._scan_files()
        logger.info(
            f"Found {len(self._trajectories_by_window)} windows in {self._directory}")

    def _scan_files(self):
        file_count = 0
        for file_path in self._directory.glob("*.json"):
            file_count += 1
            try:
                with file_path.open('r', encoding='utf-8') as f:
                    data = json.load(f)
                trajectory_data = data.get('trajectory', data)
                window_id = trajectory_data.get("windowId", "default_window")
                if window_id not in self._trajectories_by_window:
                    self._trajectories_by_window[window_id] = []
                self._trajectories_by_window[window_id].append(trajectory_data)
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.warning(f"Skipping invalid JSON file {file_path}: {e}")

        if file_count == 0:
            logger.warning(
                f"No JSON files found in directory: {self._directory}")

    def get_window_ids(self) -> List[str]:
        return list(self._trajectories_by_window.keys())

    def get_trajectories_by_window(self, window_id: str) -> List[Dict]:
        return self._trajectories_by_window.get(window_id, [])


def get_window_ids(limit: int = 100, only_scored: bool = True) -> list[str]:
    """
    Get distinct window IDs with training data.

    Args:
        limit: Maximum windows to return
        only_scored: Only return windows with scored trajectories

    Returns:
        List of window IDs
    """
    conn = get_connection()
    cur = conn.cursor()
    query = 'SELECT DISTINCT "windowId" FROM trajectories WHERE "isTrainingData" = true'
    if only_scored:
        query += ' AND "aiJudgeReward" IS NOT NULL'
    query += ' ORDER BY "windowId" DESC LIMIT %s'
    cur.execute(query, (limit,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [row[0] for row in rows if row[0]]


def get_trajectories_by_window(
    window_id: str,
    min_score: Optional[float] = None,
    validate: bool = True,
) -> list[TrajectoryRow]:
    """
    Get trajectories for a specific window.

    Args:
        window_id: Window ID to query
        min_score: Optional minimum AI judge score
        validate: Whether to validate LLM calls

    Returns:
        List of trajectory rows
    """
    conn = get_connection()
    cur = conn.cursor()
    query = """
        SELECT "trajectoryId", "agentId", "windowId", "stepsJson", "metricsJson", "metadataJson",
               "totalReward", "episodeLength", "finalStatus", "finalPnL", "tradesExecuted", 
               "aiJudgeReward", "archetype"
        FROM trajectories WHERE "windowId" = %s AND "isTrainingData" = true
    """
    params: list = [window_id]
    if min_score is not None:
        query += ' AND "aiJudgeReward" >= %s'
        params.append(min_score)
    cur.execute(query, params)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    results: list[TrajectoryRow] = []
    for row in rows:
        trajectory = TrajectoryRow(
            trajectory_id=row[0], agent_id=row[1], window_id=row[2], steps_json=row[3],
            metrics_json=row[4], metadata_json=row[5], total_reward=float(
                row[6] or 0.0),
            episode_length=int(row[7] or 0), final_status=row[8] or "unknown",
            final_pnl=float(row[9]) if row[9] else None, trades_executed=int(row[10]) if row[10] else None,
            ai_judge_reward=float(row[11]) if row[11] else None, archetype=row[12],
        )
        if validate:
            steps = json.loads(trajectory.steps_json)
            is_valid, _ = validate_llm_calls(steps)
            if not is_valid:
                continue
        results.append(trajectory)
    return results


def get_all_training_trajectories(
    limit: int = 1000,
    min_score: Optional[float] = None,
    archetype: Optional[str] = None,
) -> list[TrajectoryRow]:
    """
    Get all training trajectories.

    Args:
        limit: Maximum trajectories to return
        min_score: Optional minimum AI judge score
        archetype: Optional filter by archetype

    Returns:
        List of trajectory rows
    """
    conn = get_connection()
    cur = conn.cursor()
    query = """
        SELECT "trajectoryId", "agentId", "windowId", "stepsJson", "metricsJson", "metadataJson",
               "totalReward", "episodeLength", "finalStatus", "finalPnL", "tradesExecuted", 
               "aiJudgeReward", "archetype"
        FROM trajectories WHERE "isTrainingData" = true
    """
    params: list = []
    if min_score is not None:
        query += ' AND "aiJudgeReward" >= %s'
        params.append(min_score)
    if archetype is not None:
        query += ' AND "archetype" = %s'
        params.append(archetype)
    query += ' ORDER BY "createdAt" DESC LIMIT %s'
    params.append(limit)
    cur.execute(query, params)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [TrajectoryRow(
        trajectory_id=r[0], agent_id=r[1], window_id=r[2], steps_json=r[3],
        metrics_json=r[4], metadata_json=r[5], total_reward=float(r[6] or 0.0),
        episode_length=int(r[7] or 0), final_status=r[8] or "unknown",
        final_pnl=float(r[9]) if r[9] else None, trades_executed=int(r[10]) if r[10] else None,
        ai_judge_reward=float(r[11]) if r[11] else None, archetype=r[12],
    ) for r in rows]


def get_trajectory_stats() -> dict:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT COUNT(*), COUNT("aiJudgeReward"), AVG("aiJudgeReward"),
               MIN("aiJudgeReward"), MAX("aiJudgeReward"), COUNT(DISTINCT "archetype")
        FROM trajectories WHERE "isTrainingData" = true
    """)
    row = cur.fetchone()
    cur.close()
    conn.close()

    if row is None:
        return {"total": 0, "scored": 0, "avg_score": 0.0, "min_score": 0.0, "max_score": 0.0, "archetypes": 0}

    return {
        "total": row[0] or 0, "scored": row[1] or 0,
        "avg_score": float(row[2]) if row[2] else 0.0,
        "min_score": float(row[3]) if row[3] else 0.0,
        "max_score": float(row[4]) if row[4] else 0.0,
        "archetypes": row[5] or 0,
    }
