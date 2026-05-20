"""
Feed Trajectory Reader

Reads trajectories from PostgreSQL database or local JSON files for training.
Validates LLM call quality to ensure training data authenticity.
"""

import json
import logging
import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Handle optional psycopg2 import for JSON-only workflows.
try:
    import psycopg2
except ImportError:
    psycopg2 = None

logger = logging.getLogger(__name__)


IGNORED_EXPORT_FILES = {
    "ground-truth.json",
    "manifest.json",
    "matched-agents.json",
    "agent-configs.json",
    "registered-agents.json",
    "llm-call-logs.jsonl",
    "reward-judgments.jsonl",
    "checkpoint.json",
    "run-summary.json",
    "collection-summary.json",
    "corpus_audit.json",
    "export_summary.json",
    "training_manifest.json",
    "training_metrics.json",
    "validation_report.json",
}


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
    final_pnl: float | None
    trades_executed: int | None
    ai_judge_reward: float | None
    archetype: str | None


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
            "psycopg2 is not installed. Please install it with 'pip install psycopg2-binary'"
        )
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
            system_prompt = call.get("systemPrompt") or call.get("system_prompt") or ""
            user_prompt = call.get("userPrompt") or call.get("user_prompt") or ""
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
                issues.append(f"Step {i}, Call {call_idx}: " + ", ".join(call_issues))

        if valid_calls_in_step > 0:
            steps_with_llm += 1

    if steps_with_llm < min_steps_with_llm:
        issues.append(
            f"Only {steps_with_llm}/{len(steps)} steps have valid LLM calls (need at least {min_steps_with_llm})"
        )

    return len(issues) == 0, issues


def _step_to_dict(step: object) -> dict[str, Any]:
    if isinstance(step, dict):
        return step
    if hasattr(step, "model_dump"):
        return step.model_dump(by_alias=True)  # type: ignore[no-any-return]
    return {}


def _step_has_valid_llm_call(step: dict[str, Any]) -> bool:
    llm_calls = step.get("llmCalls") or step.get("llm_calls") or []
    for call in llm_calls:
        if not isinstance(call, dict):
            continue
        system_prompt = call.get("systemPrompt") or call.get("system_prompt") or ""
        user_prompt = call.get("userPrompt") or call.get("user_prompt") or ""
        response = call.get("response") or ""
        if len(system_prompt) >= 20 and len(user_prompt) >= 20 and len(response) >= 20:
            return True
    return False


def _step_has_usable_action(step: dict[str, Any]) -> bool:
    action = step.get("action")
    if isinstance(action, dict) and action:
        action_type = (
            action.get("actionType")
            or action.get("action_type")
            or action.get("type")
            or action.get("action")
            or ""
        )
        if str(action_type).strip():
            return True

        if bool(action.get("parameters") or action.get("result")):
            return True

    llm_calls = step.get("llmCalls") or step.get("llm_calls") or []
    for call in llm_calls:
        if not isinstance(call, dict):
            continue
        llm_action_type = call.get("actionType") or call.get("action_type") or ""
        llm_purpose = call.get("purpose") or ""
        if str(llm_action_type).strip():
            return True
        if str(llm_purpose).strip().lower() == "action":
            return True

    return False


def count_valid_llm_steps(steps: list) -> int:
    """Count steps that contain at least one usable LLM call."""
    valid_steps = 0

    if not steps:
        return valid_steps

    for step in steps:
        if _step_has_valid_llm_call(_step_to_dict(step)):
            valid_steps += 1

    return valid_steps


def has_minimum_valid_llm_steps(steps: list, min_steps_with_llm: int = 1) -> tuple[bool, int]:
    """Return whether a trajectory has enough usable LLM-backed steps."""
    valid_steps = count_valid_llm_steps(steps)
    return valid_steps >= min_steps_with_llm, valid_steps


def count_usable_action_steps(steps: list) -> int:
    """Count steps with both a usable LLM call and an action payload."""
    usable_steps = 0

    if not steps:
        return usable_steps

    for step in steps:
        step_dict = _step_to_dict(step)
        if _step_has_valid_llm_call(step_dict) and _step_has_usable_action(step_dict):
            usable_steps += 1

    return usable_steps


def has_minimum_usable_action_steps(steps: list, min_actions: int = 1) -> tuple[bool, int]:
    """Return whether a trajectory has enough usable action-bearing steps."""
    usable_steps = count_usable_action_steps(steps)
    return usable_steps >= min_actions, usable_steps


def _iter_directories_following_symlinks(root: Path) -> Iterator[Path]:
    """Walk a directory tree while following symlinked directories once."""
    pending = [root]
    seen: set[Path] = set()

    while pending:
        current = pending.pop()
        try:
            resolved = current.resolve()
        except OSError:
            continue

        if resolved in seen or not current.is_dir():
            continue

        seen.add(resolved)
        yield current

        try:
            children = sorted(current.iterdir(), key=lambda path: path.name, reverse=True)
        except OSError:
            continue

        for child in children:
            if child.is_dir():
                pending.append(child)


def discover_local_export_files(root: Path) -> list[Path]:
    """Discover export JSON/JSONL files, including under symlinked export dirs."""
    direct_files = list(root.glob("*.json")) + list(root.glob("*.jsonl"))

    nested_files: list[Path] = []
    for directory in _iter_directories_following_symlinks(root):
        manifest_path = directory / "manifest.json"
        if manifest_path.is_file():
            nested_files.extend(directory.glob("*.json"))
            nested_files.extend(directory.glob("*.jsonl"))

    if not direct_files and not nested_files:
        for directory in _iter_directories_following_symlinks(root):
            nested_files.extend(directory.glob("*.json"))
            nested_files.extend(directory.glob("*.jsonl"))

    deduped = {
        path.resolve()
        for path in [*direct_files, *nested_files]
        if path.is_file()
        and path.name not in IGNORED_EXPORT_FILES
        and not path.name.startswith("corpus_audit")
    }
    return sorted(deduped)


class PostgresTrajectoryReader:
    """Reads Feed trajectories from a PostgreSQL database."""

    def __init__(self, database_url: str):
        if psycopg2 is None:
            raise ImportError(
                "psycopg2 is not installed for PostgresTrajectoryReader. Please install it with 'pip install psycopg2-binary'"
            )
        if not database_url:
            raise ValueError("DATABASE_URL must be provided for PostgresTrajectoryReader")
        self.db_url = database_url
        self.conn = None

        # Detect Supabase pooler and warn
        if "pooler.supabase.com" in database_url or ":6543" in database_url:
            logger.warning(
                "⚠️  Detected Supabase pooler connection. "
                "Consider using direct connection (port 5432) for reliability."
            )

    async def __aenter__(self):
        """Connect to the database upon entering the async context."""
        # Check to satisfy Pylance's static analysis
        if psycopg2 is None:
            raise ImportError("psycopg2 is not installed, cannot connect to database.")

        # Set connection options for pooler compatibility
        self.conn = psycopg2.connect(
            self.db_url,
            options="-c statement_timeout=120000",  # 2 minute timeout
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Close the database connection upon exiting the context."""
        if self.conn:
            self.conn.close()

    async def get_window_ids(
        self,
        limit: int = 100,
        only_scored: bool = True,
        lookback_hours: int = 168,
        min_agents: int = 1,
    ) -> list[str]:
        if not self.conn:
            raise ConnectionError("Database not connected.")
        with self.conn.cursor() as cur:
            query = """
                SELECT "windowId" FROM trajectories
                WHERE "isTrainingData" = true AND "createdAt" > NOW() - INTERVAL '%s hours'
            """
            params = [lookback_hours]
            if only_scored:
                query += ' AND "aiJudgeReward" IS NOT NULL'
            query += ' GROUP BY "windowId" HAVING COUNT(DISTINCT "agentId") >= %s'
            params.append(max(1, min_agents))
            query += ' ORDER BY "windowId" DESC'
            if limit and limit > 0:
                query += " LIMIT %s"
                params.append(limit)
            cur.execute(query, tuple(params))
            return [row[0] for row in cur.fetchall() if row[0]]

    async def get_trajectories_by_window(
        self,
        window_id: str,
        min_score: float | None = None,
        validate: bool = True,
        min_actions: int = 1,
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
                trajectory_id=row[0],
                agent_id=row[1],
                window_id=row[2],
                steps_json=row[3],
                metrics_json=row[4],
                metadata_json=row[5],
                total_reward=float(row[6] or 0.0),
                episode_length=int(row[7] or 0),
                final_status=row[8] or "unknown",
                final_pnl=float(row[9]) if row[9] else None,
                trades_executed=int(row[10]) if row[10] else None,
                ai_judge_reward=float(row[11]) if row[11] else None,
                archetype=row[12],
            )
            if validate:
                try:
                    steps = json.loads(trajectory.steps_json)
                    has_enough_valid_steps, valid_step_count = has_minimum_usable_action_steps(
                        steps,
                        min_actions=min_actions,
                    )
                    if not has_enough_valid_steps:
                        logger.debug(
                            "Skipping DB trajectory %s: only %s usable action-bearing steps",
                            trajectory.trajectory_id,
                            valid_step_count,
                        )
                        continue
                except (json.JSONDecodeError, TypeError):
                    logger.warning(
                        f"Could not parse steps_json for trajectory {trajectory.trajectory_id}"
                    )
                    continue
            results.append(trajectory)
        return results


class JsonTrajectoryReader:
    """Reads Feed trajectories from a local directory of JSON files."""

    def __init__(self, directory_path: str):
        self._directory = Path(directory_path)
        self._trajectories_by_window: dict[str, list[dict]] = {}
        self._ground_truth: dict | None = None
        self._seen_trajectory_ids: set[str] = set()
        self._export_context_cache: dict[Path, dict[str, Any]] = {}

        if not self._directory.is_dir():
            raise FileNotFoundError(f"Source directory not found: {self._directory.resolve()}")

        self._load_ground_truth()
        self._scan_files()
        logger.info(f"Found {len(self._trajectories_by_window)} windows in {self._directory}")

    def _load_ground_truth(self):
        """Load ground truth for enhanced rewards if available."""
        gt_path = self._directory / "ground-truth.json"
        if not gt_path.exists():
            # Check parent directory (trajectories may be in subdirectory)
            gt_path = self._directory.parent / "ground-truth.json"

        if gt_path.exists():
            try:
                with open(gt_path, encoding="utf-8") as f:
                    self._ground_truth = json.load(f)
            except (OSError, json.JSONDecodeError) as e:
                logger.warning(f"Failed to load ground truth from {gt_path}: {e}")
                self._ground_truth = None
                return
            logger.info(f"Loaded ground truth from {gt_path}")

    def _build_price_context(self) -> dict:
        """Build price context from ground truth for enhanced rewards."""
        if not self._ground_truth:
            return {}

        price_context = {}
        if "priceHistory" in self._ground_truth:
            initial_prices = {}
            final_prices = {}
            for ticker, history in self._ground_truth["priceHistory"].items():
                if history and len(history) > 0:
                    initial_prices[ticker] = history[0]
                    final_prices[ticker] = history[-1]
            price_context = {
                "initialPrices": initial_prices,
                "finalPrices": final_prices,
                "priceHistory": self._ground_truth["priceHistory"],
            }

        return price_context

    def _scan_files(self):
        file_count = 0
        price_context = self._build_price_context()
        file_paths = self._discover_candidate_files()

        for file_path in file_paths:
            if file_path.name in IGNORED_EXPORT_FILES:
                continue

            file_count += 1
            try:
                for trajectory_data in self._iter_trajectory_records(file_path):
                    trajectory_key = self._trajectory_unique_id(trajectory_data)
                    if trajectory_key:
                        if trajectory_key in self._seen_trajectory_ids:
                            continue
                        self._seen_trajectory_ids.add(trajectory_key)
                    self._attach_ground_truth(trajectory_data, price_context, file_path)
                    window_id = trajectory_data.get("windowId", "default_window")
                    if window_id not in self._trajectories_by_window:
                        self._trajectories_by_window[window_id] = []
                    self._trajectories_by_window[window_id].append(trajectory_data)
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.warning(f"Skipping invalid JSON file {file_path}: {e}")

        if file_count == 0:
            logger.warning(f"No JSON files found in directory: {self._directory}")

    def _discover_candidate_files(self) -> list[Path]:
        return discover_local_export_files(self._directory)

    def _trajectory_unique_id(self, payload: dict[str, Any]) -> str:
        trajectory_id = payload.get("trajectoryId") or payload.get("trajectory_id")
        if trajectory_id:
            return str(trajectory_id)
        fallback_id = payload.get("id")
        return str(fallback_id) if fallback_id else ""

    def _attach_ground_truth(
        self,
        trajectory_data: dict,
        price_context: dict,
        file_path: Path,
    ) -> None:
        """Merge optional ground truth into trajectory metadata."""
        if not price_context:
            return

        metadata = trajectory_data.get("metadata", {})
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata) if metadata else {}
            except json.JSONDecodeError as e:
                logger.warning(f"Malformed metadata JSON in {file_path}, ignoring metadata: {e}")
                metadata = {}

        metadata["ground_truth"] = price_context
        trajectory_data["metadata"] = metadata

    def _load_export_context(self, file_path: Path) -> dict[str, Any]:
        export_dir = file_path.parent.resolve()
        cached = self._export_context_cache.get(export_dir)
        if cached is not None:
            return cached

        context: dict[str, Any] = {
            "batch_id": None,
            "experiment_run_id": None,
            "selection_strategy": None,
            "agents_by_user_id": {},
            "reward_judgments_by_trajectory": {},
        }

        manifest_path = export_dir / "manifest.json"
        if manifest_path.is_file():
            try:
                with manifest_path.open("r", encoding="utf-8") as handle:
                    manifest = json.load(handle)
                context["batch_id"] = (
                    manifest.get("sourceBatchId")
                    or manifest.get("batchId")
                    or manifest.get("sourceExperimentRunId")
                    or manifest.get("experimentRunId")
                    or f"legacy_export:{export_dir.name}"
                )
                context["experiment_run_id"] = (
                    manifest.get("sourceExperimentRunId")
                    or manifest.get("experimentRunId")
                    or manifest.get("sourceBatchId")
                    or manifest.get("batchId")
                )
                context["selection_strategy"] = manifest.get("selectionStrategy")
            except (OSError, json.JSONDecodeError):
                context["batch_id"] = f"legacy_export:{export_dir.name}"
        else:
            context["batch_id"] = f"legacy_export:{export_dir.name}"

        matched_agents_path = export_dir / "matched-agents.json"
        if matched_agents_path.is_file():
            try:
                with matched_agents_path.open("r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                for agent in payload.get("agents", []):
                    if not isinstance(agent, dict):
                        continue
                    user_id = agent.get("userId") or agent.get("agentId")
                    if not user_id:
                        continue
                    context["agents_by_user_id"][str(user_id)] = {
                        "modelSize": agent.get("modelSize"),
                        "trainingProfile": agent.get("trainingProfile"),
                        "username": agent.get("username"),
                        "displayName": agent.get("displayName"),
                        "instanceId": agent.get("instanceId"),
                        "initialGroupChatTarget": agent.get("initialGroupChatTarget"),
                        "initialGroupChatCount": agent.get("initialGroupChatCount"),
                        "initialGroupChatIds": agent.get("initialGroupChatIds"),
                    }
            except (OSError, json.JSONDecodeError):
                pass

        reward_judgments_path = export_dir / "reward-judgments.jsonl"
        if reward_judgments_path.is_file():
            try:
                with reward_judgments_path.open(
                    "r", encoding="utf-8", errors="surrogatepass"
                ) as handle:
                    for line in handle:
                        stripped = line.strip()
                        if not stripped:
                            continue
                        row = json.loads(stripped)
                        if not isinstance(row, dict):
                            continue
                        trajectory_id = row.get("trajectoryId") or row.get("trajectory_id")
                        if not trajectory_id:
                            continue
                        key = str(trajectory_id)
                        current = context["reward_judgments_by_trajectory"].get(key, [])
                        current.append(row)
                        context["reward_judgments_by_trajectory"][key] = current
            except (OSError, json.JSONDecodeError):
                pass

        self._export_context_cache[export_dir] = context
        return context

    def _attach_export_context(self, trajectory_data: dict, file_path: Path) -> None:
        context = self._load_export_context(file_path)

        metadata = trajectory_data.get("metadata", {})
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata) if metadata else {}
            except json.JSONDecodeError:
                metadata = {}
        if not metadata and isinstance(trajectory_data.get("metadataJson"), str):
            try:
                metadata = json.loads(trajectory_data["metadataJson"]) or {}
            except json.JSONDecodeError:
                metadata = {}
        if not isinstance(metadata, dict):
            metadata = {}

        batch_id = (
            trajectory_data.get("batchId")
            or trajectory_data.get("batch_id")
            or metadata.get("batchId")
            or metadata.get("batch_id")
            or context.get("batch_id")
        )
        if batch_id:
            trajectory_data["batchId"] = batch_id
            metadata.setdefault("batchId", batch_id)

        experiment_run_id = (
            metadata.get("experimentRunId")
            or metadata.get("experiment_run_id")
            or context.get("experiment_run_id")
        )
        if experiment_run_id:
            metadata.setdefault("experimentRunId", experiment_run_id)

        selection_strategy = context.get("selection_strategy")
        if selection_strategy:
            metadata.setdefault("selectionStrategy", selection_strategy)

        agent_id = trajectory_data.get("agentId") or trajectory_data.get("agent_id")
        agent_context = context.get("agents_by_user_id", {}).get(str(agent_id), {})
        if agent_context:
            for source_key, target_key in (
                ("modelSize", "modelSize"),
                ("trainingProfile", "trainingProfile"),
                ("username", "username"),
                ("displayName", "displayName"),
                ("instanceId", "instanceId"),
                ("initialGroupChatTarget", "initialGroupChatTarget"),
                ("initialGroupChatCount", "initialGroupChatCount"),
                ("initialGroupChatIds", "initialGroupChatIds"),
            ):
                value = agent_context.get(source_key)
                if value and not metadata.get(target_key):
                    metadata[target_key] = value

        trajectory_id = self._trajectory_unique_id(trajectory_data)
        reward_judgments = context.get("reward_judgments_by_trajectory", {}).get(
            trajectory_id,
            [],
        )
        if reward_judgments and not trajectory_data.get("rewardJudgments"):
            trajectory_data["rewardJudgments"] = reward_judgments
            metadata.setdefault("rewardJudgmentCount", len(reward_judgments))

        trajectory_data["metadata"] = metadata

    def _iter_trajectory_records(self, file_path: Path) -> Iterator[dict]:
        """Yield trajectory-like records from JSON or JSONL export files."""
        if file_path.suffix == ".jsonl":
            with file_path.open("r", encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, start=1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    payload = json.loads(stripped)
                    trajectory_data = payload.get("trajectory", payload)
                    if not self._looks_like_trajectory(trajectory_data):
                        logger.debug(
                            "Skipping non-trajectory JSONL row %s:%s",
                            file_path,
                            line_number,
                        )
                        continue
                    self._attach_export_context(trajectory_data, file_path)
                    yield trajectory_data
            return

        with file_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)

        trajectory_data = payload.get("trajectory", payload)
        if not self._looks_like_trajectory(trajectory_data):
            raise TypeError(f"File does not contain a trajectory payload: {file_path}")
        self._attach_export_context(trajectory_data, file_path)
        yield trajectory_data

    def _looks_like_trajectory(self, payload: object) -> bool:
        """Return True when a payload resembles a Feed trajectory export."""
        if not isinstance(payload, dict):
            return False
        return any(
            key in payload
            for key in (
                "trajectoryId",
                "trajectory_id",
                "stepsJson",
                "steps",
                "windowId",
                "window_id",
            )
        )

    def get_window_ids(self) -> list[str]:
        return list(self._trajectories_by_window.keys())

    def get_trajectories_by_window(self, window_id: str) -> list[dict]:
        return self._trajectories_by_window.get(window_id, [])


def get_window_ids(
    limit: int = 100,
    only_scored: bool = True,
    lookback_hours: int = 168,
    min_agents: int = 1,
) -> list[str]:
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
    query = """
        SELECT "windowId" FROM trajectories
        WHERE "isTrainingData" = true AND "createdAt" > NOW() - INTERVAL '%s hours'
    """
    params: list[object] = [lookback_hours]
    if only_scored:
        query += ' AND "aiJudgeReward" IS NOT NULL'
    query += ' GROUP BY "windowId" HAVING COUNT(DISTINCT "agentId") >= %s'
    params.append(max(1, min_agents))
    query += ' ORDER BY "windowId" DESC'
    if limit and limit > 0:
        query += " LIMIT %s"
        params.append(limit)
    cur.execute(query, tuple(params))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [row[0] for row in rows if row[0]]


def get_trajectories_by_window(
    window_id: str,
    min_score: float | None = None,
    validate: bool = True,
    min_actions: int = 1,
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
        FROM trajectories WHERE "windowId" = %s AND "isTrainingData" = true AND "episodeLength" >= %s
    """
    params: list = [window_id, min_actions]
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
            trajectory_id=row[0],
            agent_id=row[1],
            window_id=row[2],
            steps_json=row[3],
            metrics_json=row[4],
            metadata_json=row[5],
            total_reward=float(row[6] or 0.0),
            episode_length=int(row[7] or 0),
            final_status=row[8] or "unknown",
            final_pnl=float(row[9]) if row[9] else None,
            trades_executed=int(row[10]) if row[10] else None,
            ai_judge_reward=float(row[11]) if row[11] else None,
            archetype=row[12],
        )
        if validate:
            steps = json.loads(trajectory.steps_json)
            is_valid, _ = has_minimum_usable_action_steps(steps, min_actions)
            if not is_valid:
                continue
        results.append(trajectory)
    return results


def get_all_training_trajectories(
    limit: int = 1000,
    min_score: float | None = None,
    archetype: str | None = None,
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
    query += ' ORDER BY "createdAt" DESC'
    if limit and limit > 0:
        query += " LIMIT %s"
        params.append(limit)
    cur.execute(query, params)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [
        TrajectoryRow(
            trajectory_id=r[0],
            agent_id=r[1],
            window_id=r[2],
            steps_json=r[3],
            metrics_json=r[4],
            metadata_json=r[5],
            total_reward=float(r[6] or 0.0),
            episode_length=int(r[7] or 0),
            final_status=r[8] or "unknown",
            final_pnl=float(r[9]) if r[9] else None,
            trades_executed=int(r[10]) if r[10] else None,
            ai_judge_reward=float(r[11]) if r[11] else None,
            archetype=r[12],
        )
        for r in rows
    ]


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
        return {
            "total": 0,
            "scored": 0,
            "avg_score": 0.0,
            "min_score": 0.0,
            "max_score": 0.0,
            "archetypes": 0,
        }

    return {
        "total": row[0] or 0,
        "scored": row[1] or 0,
        "avg_score": float(row[2]) if row[2] else 0.0,
        "min_score": float(row[3]) if row[3] else 0.0,
        "max_score": float(row[4]) if row[4] else 0.0,
        "archetypes": row[5] or 0,
    }
