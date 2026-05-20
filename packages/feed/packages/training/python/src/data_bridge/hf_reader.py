"""
HuggingFace Dataset Reader for Babylon Trajectories

Loads trajectory data from HuggingFace datasets as an alternative to PostgreSQL.
This provides reproducible training by using versioned, frozen datasets.

The reader is compatible with datasets created by trajectories_to_hf_dataset.py
and mirrors the PostgresTrajectoryReader API for seamless integration.

Usage:
    from data_bridge.hf_reader import HuggingFaceTrajectoryReader, HFReaderConfig

    config = HFReaderConfig(
        dataset_id="elizaos/babylon-trajectories-simulation-v1",
        split="raw",
    )

    reader = HuggingFaceTrajectoryReader(config)
    await reader.connect()

    windows = await reader.get_window_ids(limit=100)
    for window_id in windows:
        trajectories = await reader.get_trajectories_by_window(window_id)
        # Process trajectories...
"""

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from functools import partial
from typing import Any

from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .reader import (
    TrajectoryRow,
    count_usable_action_steps,
    validate_llm_calls,
)

logger = logging.getLogger(__name__)


def _parse_float(value: Any, default: float | None = None) -> float | None:
    """Safely parse a value to float, returning default on failure."""
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_int(value: Any, default: int | None = None) -> int | None:
    """Safely parse a value to int, returning default on failure."""
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@dataclass
class HFReaderConfig:
    """Configuration for HuggingFace dataset reader."""

    # Dataset identifier on HuggingFace Hub
    dataset_id: str

    # Dataset split to use: raw, preferences, sft
    split: str = "raw"

    # Whether to stream data (for very large datasets)
    streaming: bool = False

    # Maximum trajectories to load (prevents OOM)
    max_trajectories: int = 50000

    # Minimum actions required per trajectory
    min_actions: int = 3

    # HuggingFace cache directory (optional, uses default if None)
    cache_dir: str | None = None

    # HuggingFace token for private datasets (optional, uses HF_TOKEN env var)
    hf_token: str | None = None

    def __post_init__(self):
        if not self.hf_token:
            self.hf_token = os.environ.get("HF_TOKEN")


class HuggingFaceTrajectoryReader:
    """
    Reads Babylon trajectories from a HuggingFace dataset.

    Provides the same interface as PostgresTrajectoryReader for compatibility
    with the training pipeline. Trajectories are loaded from the 'raw' split
    and grouped by window_id for GRPO training.
    """

    def __init__(self, config: HFReaderConfig):
        self.config = config
        self._dataset = None
        self._trajectories_by_window: dict[str, list[dict]] = {}
        self._loaded = False

    async def __aenter__(self):
        """Async context manager entry - loads the dataset."""
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit - cleanup."""
        self._dataset = None
        self._trajectories_by_window = {}
        self._loaded = False

    async def connect(self) -> bool:
        """
        Load the dataset from HuggingFace Hub.

        Uses retry logic with exponential backoff for network resilience.
        Runs the blocking load_dataset call in an executor to avoid blocking
        the event loop.

        Returns True if successful, raises exceptions on failure.
        """
        logger.info(f"Loading HuggingFace dataset: {self.config.dataset_id}")
        logger.info(f"  Split: {self.config.split}")
        logger.info(f"  Streaming: {self.config.streaming}")

        load_kwargs: dict[str, Any] = {
            "path": self.config.dataset_id,
            "split": self.config.split,
            "streaming": self.config.streaming,
        }

        if self.config.cache_dir:
            load_kwargs["cache_dir"] = self.config.cache_dir

        if self.config.hf_token:
            load_kwargs["token"] = self.config.hf_token

        # Run blocking load_dataset in executor with retry logic
        loop = asyncio.get_running_loop()
        self._dataset = await loop.run_in_executor(
            None, partial(self._load_dataset_with_retry, **load_kwargs)
        )

        # Parse and group trajectories by window
        await self._parse_and_group_trajectories()

        self._loaded = True
        logger.info(f"Loaded {len(self._trajectories_by_window)} windows from HuggingFace dataset")

        return True

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=60),
        retry=retry_if_exception_type((ConnectionError, TimeoutError, OSError)),
        before_sleep=lambda retry_state: logger.warning(
            f"HuggingFace load failed (attempt {retry_state.attempt_number}), retrying..."
        ),
    )
    def _load_dataset_with_retry(self, **kwargs):
        """Load dataset with retry logic for network failures."""
        from datasets import load_dataset

        return load_dataset(**kwargs)

    async def _parse_and_group_trajectories(self):
        """Parse raw dataset and group by window_id."""
        if self._dataset is None:
            raise RuntimeError("Dataset not loaded")

        count = 0
        skipped = 0

        for row in self._dataset:
            if count >= self.config.max_trajectories:
                logger.info(f"Reached max_trajectories limit ({self.config.max_trajectories})")
                break

            # Parse steps from JSON string
            steps_raw = row.get("steps")
            if isinstance(steps_raw, str):
                try:
                    steps = json.loads(steps_raw)
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse steps JSON: {e}")
                    skipped += 1
                    continue
            elif isinstance(steps_raw, list):
                steps = steps_raw
            else:
                skipped += 1
                continue

            # Filter by minimum usable action-bearing steps
            usable_action_steps = count_usable_action_steps(steps)
            if usable_action_steps < self.config.min_actions:
                skipped += 1
                continue

            # Parse metadata from JSON string
            metadata_raw = row.get("metadata")
            if isinstance(metadata_raw, str):
                try:
                    metadata = json.loads(metadata_raw) if metadata_raw else {}
                except json.JSONDecodeError:
                    metadata = {}
            elif isinstance(metadata_raw, dict):
                metadata = metadata_raw
            else:
                metadata = {}

            # Extract window_id for grouping (use default if None or empty)
            window_id = row.get("window_id") or "default_window"

            if window_id not in self._trajectories_by_window:
                self._trajectories_by_window[window_id] = []

            # Build trajectory dict matching PostgresTrajectoryReader output
            # Use safe parsing helpers to handle malformed data
            final_pnl = _parse_float(row.get("final_pnl"), default=0.0)
            final_balance = _parse_float(row.get("final_balance"))
            total_reward = _parse_float(row.get("total_reward"), default=0.0)

            trajectory = {
                "trajectory_id": row.get("trajectory_id") or f"hf_{count}",
                "agent_id": row.get("agent_id") or "unknown",
                "agent_name": row.get("agent_name") or row.get("agent_id", "Agent")[:8],
                "window_id": window_id,
                "scenario_id": row.get("scenario_id") or None,
                "archetype": row.get("archetype") or "default",
                "metadata": metadata,
                "steps": steps,
                "final_pnl": final_pnl,
                "final_balance": final_balance,
                "starting_balance": None,  # Will be computed from final_balance - final_pnl
                "episode_length": len(steps),  # Use actual step count, not stored value
                "total_reward": total_reward,
                "usable_action_steps": usable_action_steps,
            }

            # Compute starting_balance if both final_balance and final_pnl are available
            if final_balance is not None and final_pnl is not None:
                trajectory["starting_balance"] = final_balance - final_pnl

            self._trajectories_by_window[window_id].append(trajectory)
            count += 1

        logger.info(f"Parsed {count} trajectories, skipped {skipped}")

    async def get_window_ids(
        self,
        limit: int = 100,
        only_scored: bool = True,  # Ignored for HF datasets (no live scoring)
        lookback_hours: int = 168,  # Ignored for HF datasets (static data)
        min_agents: int = 1,
    ) -> list[str]:
        """
        Get distinct window IDs with sufficient trajectories.

        Args:
            limit: Maximum windows to return
            only_scored: Ignored (HF datasets have pre-scored data)
            lookback_hours: Ignored (HF datasets are static)
            min_agents: Minimum trajectories per window

        Returns:
            List of window IDs
        """
        if not self._loaded:
            raise RuntimeError("Reader not connected. Call connect() first.")

        # Filter windows with enough trajectories
        valid_windows = []
        for window_id in sorted(self._trajectories_by_window.keys(), reverse=True):
            trajectories = self._trajectories_by_window[window_id]
            agent_ids = {
                str(trajectory.get("agent_id") or "").strip()
                for trajectory in trajectories
                if str(trajectory.get("agent_id") or "").strip()
            }
            if len(agent_ids) >= min_agents:
                valid_windows.append(window_id)

        valid_windows.sort(reverse=True)
        return valid_windows[:limit]

    async def get_trajectories_by_window(
        self,
        window_id: str,
        min_score: float | None = None,  # Ignored for HF datasets
        validate: bool = True,
        min_actions: int = 1,
    ) -> list[TrajectoryRow]:
        """
        Get trajectories for a specific window.

        Args:
            window_id: Window ID to query
            min_score: Ignored (HF datasets don't have live AI judge scores)
            validate: Whether to validate LLM calls in trajectories
            min_actions: Minimum actions required

        Returns:
            List of TrajectoryRow objects
        """
        if not self._loaded:
            raise RuntimeError("Reader not connected. Call connect() first.")

        trajectories = self._trajectories_by_window.get(window_id, [])
        results = []

        for traj in trajectories:
            # Filter by minimum actions (use actual step count, not stored episode_length)
            usable_action_steps = count_usable_action_steps(traj["steps"])
            if usable_action_steps < min_actions:
                logger.debug(
                    "Skipping trajectory %s: only %s usable action-bearing steps",
                    traj["trajectory_id"],
                    usable_action_steps,
                )
                continue

            # Validate LLM calls if requested
            if validate:
                is_valid, issues = validate_llm_calls(traj["steps"])
                if not is_valid:
                    logger.debug(f"Skipping HF trajectory {traj['trajectory_id']}: {issues}")
                    continue

            # Convert to TrajectoryRow for compatibility with existing code
            row = TrajectoryRow(
                trajectory_id=traj["trajectory_id"],
                agent_id=traj["agent_id"],
                window_id=traj["window_id"],
                steps_json=json.dumps(traj["steps"]),
                metrics_json="{}",  # HF datasets don't have separate metrics
                metadata_json=json.dumps(traj["metadata"]),
                total_reward=traj["total_reward"],
                episode_length=traj["episode_length"],
                final_status="completed",  # HF datasets are completed trajectories
                final_pnl=traj["final_pnl"],
                trades_executed=None,  # Will be computed from steps if needed
                ai_judge_reward=None,  # HF datasets don't have live AI judge scores
                archetype=traj["archetype"],
            )
            results.append(row)

        return results

    def get_trajectory_groups(
        self,
        min_agents_per_window: int = 2,
    ) -> list[dict]:
        """
        Get all trajectory groups formatted for the training pipeline.

        This returns data in the same format as BabylonRLAIFEnv._load_trajectories.

        Args:
            min_agents_per_window: Minimum trajectories per window

        Returns:
            List of dicts with 'group_key' and 'trajectories' keys
        """
        if not self._loaded:
            raise RuntimeError("Reader not connected. Call connect() first.")

        groups = []

        for window_id, trajectories in self._trajectories_by_window.items():
            agent_ids = {
                str(trajectory.get("agent_id") or "").strip()
                for trajectory in trajectories
                if str(trajectory.get("agent_id") or "").strip()
            }
            if len(agent_ids) >= min_agents_per_window:
                # Get scenario_id from first trajectory (should be same for all in window)
                scenario_id = trajectories[0].get("scenario_id") or "default"
                group_key = f"{window_id}_{scenario_id}"

                groups.append(
                    {
                        "group_key": group_key,
                        "trajectories": trajectories,
                    }
                )

        logger.info(
            f"Prepared {len(groups)} trajectory groups (min_agents={min_agents_per_window})"
        )
        return groups

    def get_stats(self) -> dict[str, Any]:
        """Get statistics about the loaded dataset."""
        if not self._loaded:
            return {"loaded": False}

        total_trajectories = sum(len(t) for t in self._trajectories_by_window.values())
        total_windows = len(self._trajectories_by_window)

        # Calculate average metrics
        all_pnl = []
        all_lengths = []
        archetypes = set()

        for trajectories in self._trajectories_by_window.values():
            for traj in trajectories:
                all_pnl.append(traj["final_pnl"])
                all_lengths.append(traj["episode_length"])
                archetypes.add(traj["archetype"])

        return {
            "loaded": True,
            "dataset_id": self.config.dataset_id,
            "split": self.config.split,
            "total_trajectories": total_trajectories,
            "total_windows": total_windows,
            "avg_trajectories_per_window": total_trajectories / total_windows
            if total_windows > 0
            else 0,
            "avg_pnl": sum(all_pnl) / len(all_pnl) if all_pnl else 0,
            "avg_episode_length": sum(all_lengths) / len(all_lengths) if all_lengths else 0,
            "archetypes": list(archetypes),
        }


async def create_trajectory_reader_from_hf(
    dataset_id: str,
    split: str = "raw",
    max_trajectories: int = 50000,
    min_actions: int = 3,
) -> HuggingFaceTrajectoryReader:
    """
    Factory function to create and connect a HuggingFace trajectory reader.

    Args:
        dataset_id: HuggingFace dataset ID (e.g., "elizaos/babylon-trajectories-v1")
        split: Dataset split to use (raw, preferences, sft)
        max_trajectories: Maximum trajectories to load
        min_actions: Minimum actions per trajectory

    Returns:
        Connected HuggingFaceTrajectoryReader instance
    """
    config = HFReaderConfig(
        dataset_id=dataset_id,
        split=split,
        max_trajectories=max_trajectories,
        min_actions=min_actions,
    )

    reader = HuggingFaceTrajectoryReader(config)
    await reader.connect()

    return reader
