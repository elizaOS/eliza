#!/usr/bin/env python3
"""
Babylon Local Training Script - Unified Mac (MLX) + GTX (CUDA) Support

This script provides training using REAL data from the database OR local JSON files.
Only trajectories with actual LLM calls are used.

Supports:
- Apple Silicon (MLX) - LoRA fine-tuning
- NVIDIA GPU (PyTorch/CUDA) - Full or LoRA fine-tuning
- CPU fallback (slow but works)

Usage:
    # Mac with MLX from Postgres Database
    python scripts/train_local.py --backend mlx --model mlx-community/Qwen3.5-4B-MLX-4bit

    # Mac with MLX from local JSON files
    python scripts/train_local.py --backend mlx --model mlx-community/Qwen3.5-4B-MLX-4bit --source-dir ../engine/training-data-output/trajectories

    # GTX/CUDA machine from Postgres Database
    python scripts/train_local.py --backend cuda --model Qwen/Qwen3.5-4B

    # GTX/CUDA machine from local JSON files
    python scripts/train_local.py --backend cuda --model Qwen/Qwen3.5-4B --source-dir ../engine/training-data-output/trajectories

Small model recommendations for consumer hardware:
    Mac M1/M2 (16GB+): mlx-community/Qwen3.5-4B-MLX-4bit
    GTX 3060 (12GB):   Qwen/Qwen3.5-4B (LoRA/QLoRA only)
    GTX 4090 (24GB):   Qwen/Qwen3.5-9B (QLoRA or APOLLO)
"""

import os
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))


import argparse
import asyncio
import inspect
import json
import logging
import math
import random
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Literal

from deterministic_eval import (
    ACTION_REASON_ASSISTANT_PREFIX,
    ACTION_REASON_PROMPTS,
    ACTION_REASON_SYSTEM_PROMPT,
    CONCRETE_CUE_PATTERN,
    DECISION_ALIGNMENT_SAMPLES,
    DECISION_FORMAT_SYSTEM_PROMPT,
    DECISION_VALIDATION_PROMPTS,
    NATURAL_MESSAGE_SYSTEM_PROMPT,
    extract_action_verb,
    normalize_decision_payload,
    passes_action_reason_gate,
    passes_combined_gate,
    passes_json_format_gate,
    passes_natural_message_gate,
    score_action_reason_response,
    score_decision_response,
    summarize_action_reason_results,
    summarize_decision_results,
)
from dotenv import load_dotenv
from local_inference import LocalTextGenerator
from qwen_capacity import (
    BYTES_PER_GIB,
    build_capacity_report,
    estimate_full_training_memory,
    estimate_lora_memory,
    estimate_qlora_memory,
    resolve_model_spec,
)

from src.data_bridge.reader import (
    JsonTrajectoryReader,
    PostgresTrajectoryReader,
    has_minimum_usable_action_steps,
)
from src.models import BabylonTrajectory
from src.training.local_models import default_local_model_for_backend

# Load environment
env_path = Path(__file__).parent.parent.parent.parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


TRADE_ACTION_TYPES = {
    "TRADE",
    "TRADING_DECISION",
    "BUY_SHARES",
    "SELL_SHARES",
    "OPEN_PERP_POSITION",
    "CLOSE_PERP_POSITION",
    "BUY",
    "SELL",
    "SHORT",
    "CLOSE",
    "HOLD",
}

DECISION_ACTION_TYPES = {
    "SCAM_DEFENSE_DECISION",
    "REFUSE",
    "ESCALATE",
    "AUDIT",
    "IGNORE",
    "REQUEST_VERIFICATION",
    "ACCEPT",
    "ENGAGE",
    "COMPLY",
    "BLOCK_USER",
    "WARN_USER",
    "NEGOTIATE",
    "ALLOW",
    "DISALLOW",
    "PAY",
    "SHARE_INFO",
}

POLICY_ACTION_MINIMUMS = {
    "hold": 2,
    "short": 2,
    "close": 4,
    "sell": 2,
}

POLICY_CURRICULUM_ITEMS = [
    {
        "action_verb": "hold",
        "prompt": (
            "Balance: $9,800. Open positions: none. "
            "A prediction market has traded between 0.49 and 0.51 for eight hours "
            "with no fresh news and fading volume. What trade do you place next?"
        ),
        "response": (
            "Action: hold and stay flat.\n"
            "Reason: price is stuck in a narrow range, volume is fading, and there is no catalyst."
        ),
    },
    {
        "action_verb": "hold",
        "prompt": (
            "Balance: $8,900. Open positions: none. "
            "Social chatter is pushing a thin market higher, but the spread is widening "
            "and liquidity is poor. What do you do next?"
        ),
        "response": (
            "Action: hold and avoid chasing the move.\n"
            "Reason: liquidity is thin, the spread is wide, and the pump can reverse fast."
        ),
    },
    {
        "action_verb": "short",
        "prompt": (
            "Balance: $10,400. Open positions: none. "
            "YES shares rallied from 0.58 to 0.82 in two sessions, but volume is fading "
            "and there is no new catalyst. What trade do you place next?"
        ),
        "response": (
            "Action: short the overheated YES move.\n"
            "Reason: price is stretched, volume is fading, and the risk-reward favors a reversal."
        ),
    },
    {
        "action_verb": "short",
        "prompt": (
            "Balance: $11,600. Open positions: none. "
            "A crowded prediction market is pricing YES at 0.79 after influencer hype, "
            "but order flow is thinning and implied odds look rich. What do you do?"
        ),
        "response": (
            "Action: short YES into the crowded rally.\n"
            "Reason: odds are rich, order flow is thinning, and downside risk is better defined than upside."
        ),
    },
    {
        "action_verb": "close",
        "prompt": (
            "Balance: $12,300. Open positions: short YES 250 shares from 0.73. "
            "The market now trades near 0.59 and volatility is rising ahead of a catalyst. "
            "What trade do you place next?"
        ),
        "response": (
            "Action: close the profitable short.\n"
            "Reason: price already moved toward fair value, volatility is rising, and locking gains reduces event risk."
        ),
    },
    {
        "action_verb": "close",
        "prompt": (
            "Balance: $10,900. Open positions: long NO 300 shares from 0.56. "
            "The event resolves tomorrow and implied odds are unstable. What do you do next?"
        ),
        "response": (
            "Action: close the NO position before resolution.\n"
            "Reason: event risk is high, odds are unstable, and reducing exposure protects capital."
        ),
    },
    {
        "action_verb": "sell",
        "prompt": (
            "Balance: $10,700. Open positions: none. "
            "YES is trading at 0.79 after a rumor-driven squeeze, volume is fading, "
            "and buyers are no longer lifting offers. What trade do you place next?"
        ),
        "response": (
            "Action: sell YES into the fading squeeze.\n"
            "Reason: odds are rich, volume is fading, and the move has no new evidence behind it."
        ),
    },
    {
        "action_verb": "sell",
        "prompt": (
            "Balance: $11,500. Open positions: none. "
            "A prediction market jumped from 0.61 to 0.80 on hype, but depth is thinning "
            "and spreads are starting to widen. What do you do now?"
        ),
        "response": (
            "Action: sell YES to fade the overextended move.\n"
            "Reason: price is stretched, liquidity is getting worse, and fading momentum improves the risk-reward."
        ),
    },
]

DECISION_FORMAT_CURRICULUM_ITEMS = DECISION_ALIGNMENT_SAMPLES


# =============================================================================
# Backend Detection
# =============================================================================


def detect_backend() -> Literal["mlx", "cuda", "cpu"]:
    """Auto-detect the best available backend."""
    # Check for MLX (Apple Silicon)
    try:
        import mlx.core  # type: ignore

        logger.info("MLX backend available (Apple Silicon)")
        return "mlx"
    except ImportError:
        pass

    # Check for CUDA
    try:
        import torch

        if torch.cuda.is_available():
            logger.info(f"CUDA backend available: {torch.cuda.get_device_name(0)}")
            return "cuda"
    except ImportError:
        pass

    logger.warning("No GPU backend available, falling back to CPU (slow)")
    return "cpu"


# =============================================================================
# Data Loading
# =============================================================================


async def load_postgres_training_data(
    database_url: str,
    min_actions: int,
    lookback_hours: int,
    max_trajectories: int,
) -> list[BabylonTrajectory]:
    """Load REAL training data from the database and parse into Pydantic models."""
    logger.info("Loading real training data from database...")

    trajectories: list[BabylonTrajectory] = []

    try:
        async with PostgresTrajectoryReader(database_url) as reader:
            windows = await reader.get_window_ids(
                lookback_hours=lookback_hours,
                only_scored=False,
            )
            if not windows:
                raise ValueError("No trajectory windows found in database. Generate data first.")

            logger.info(f"Found {len(windows)} trajectory windows")

            for window_id in sorted(windows):
                window_trajectories = await reader.get_trajectories_by_window(
                    window_id, min_actions=min_actions, validate=True
                )
                for traj_row in sorted(
                    window_trajectories,
                    key=lambda row: (
                        float(row.total_reward or 0.0),
                        float(row.final_pnl or 0.0),
                        int(row.episode_length or 0),
                        str(row.trajectory_id or ""),
                    ),
                    reverse=True,
                ):
                    try:
                        steps = json.loads(traj_row.steps_json)
                        # Convert TrajectoryRow object to a dict for Pydantic validation
                        traj_data = {
                            "id": traj_row.trajectory_id,
                            "trajectory_id": traj_row.trajectory_id,
                            "agent_id": traj_row.agent_id,
                            "window_id": traj_row.window_id,
                            "steps": steps,
                            "total_reward": traj_row.total_reward,
                            "episode_length": traj_row.episode_length,
                            "final_status": traj_row.final_status,
                            "final_pnl": traj_row.final_pnl
                            if traj_row.final_pnl is not None
                            else 0.0,
                            "trades_executed": traj_row.trades_executed
                            if traj_row.trades_executed is not None
                            else 0,
                            "archetype": traj_row.archetype,
                        }
                        traj_model = BabylonTrajectory.model_validate(traj_data)
                        trajectories.append(traj_model)
                    except Exception as e:
                        logger.warning(
                            f"Skipping DB trajectory {traj_row.trajectory_id} due to parsing error: {e}"
                        )

    except ValueError:
        raise
    except Exception as e:
        logger.error(f"Failed to load from database: {e}")
        logger.error("Please ensure the database is running and DATABASE_URL is correct.")
        raise ValueError(f"Database connection failed: {e}") from e

    if len(trajectories) == 0:
        raise ValueError("Insufficient training data: 0 valid trajectories found.")

    trajectories.sort(
        key=lambda traj: (
            float(traj.total_reward or 0.0),
            float(traj.final_pnl or 0.0),
            int(traj.episode_length or len(traj.steps) or 0),
            str(traj.window_id or ""),
            str(traj.trajectory_id or ""),
        ),
        reverse=True,
    )
    if max_trajectories > 0:
        trajectories = trajectories[:max_trajectories]

    if len(trajectories) < 10:
        logger.warning(f"Low training data: only {len(trajectories)} valid trajectories found.")

    logger.info(f"Loaded {len(trajectories)} real trajectories from DB")
    return trajectories


def normalize_decision_action_type(action_type: str | None) -> str:
    return str(action_type or "").strip().upper().replace("-", "_")


def normalize_timestamp_value(value: Any) -> int:
    if isinstance(value, bool):
        return int(datetime.now(timezone.utc).timestamp() * 1000)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            return int(stripped)
        try:
            return int(datetime.fromisoformat(stripped.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def normalize_llm_call_dict(call: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(call)
    normalized["model"] = str(normalized.get("model") or "unknown-model")
    normalized["systemPrompt"] = str(
        normalized.get("systemPrompt") or normalized.get("system_prompt") or ""
    )
    normalized["userPrompt"] = str(
        normalized.get("userPrompt") or normalized.get("user_prompt") or ""
    )
    normalized["response"] = str(normalized.get("response") or "")
    normalized["temperature"] = float(normalized.get("temperature") or 0.0)
    normalized["maxTokens"] = int(
        normalized.get("maxTokens") or normalized.get("max_tokens") or 256
    )
    normalized["purpose"] = str(normalized.get("purpose") or "action")
    action_type = normalized.get("actionType") or normalized.get("action_type")
    if action_type is not None:
        normalized["actionType"] = str(action_type)
    metadata = normalized.get("metadata")
    if isinstance(metadata, dict):
        normalized["metadata"] = dict(metadata)
    private_analysis = normalized.get("privateAnalysis") or normalized.get("private_analysis")
    if isinstance(private_analysis, dict):
        normalized["privateAnalysis"] = dict(private_analysis)
    if "reasoningAvailable" in normalized or "reasoning_available" in normalized:
        normalized["reasoningAvailable"] = bool(
            normalized.get("reasoningAvailable", normalized.get("reasoning_available"))
        )
    reasoning_source = normalized.get("reasoningSource") or normalized.get("reasoning_source")
    if reasoning_source is not None:
        normalized["reasoningSource"] = str(reasoning_source)
    trace_visibility = normalized.get("traceVisibility") or normalized.get("trace_visibility")
    if trace_visibility is not None:
        normalized["traceVisibility"] = str(trace_visibility)
    raw_reasoning_trace = normalized.get("rawReasoningTrace") or normalized.get(
        "raw_reasoning_trace"
    )
    if raw_reasoning_trace is not None:
        normalized["rawReasoningTrace"] = str(raw_reasoning_trace)
    return normalized


def infer_action_from_llm_call_dict(step: dict[str, Any]) -> dict[str, Any] | None:
    llm_calls = step.get("llmCalls") or step.get("llm_calls") or []
    if not isinstance(llm_calls, list):
        return None

    primary_call: dict[str, Any] | None = None
    for llm_call in llm_calls:
        if isinstance(llm_call, dict) and str(llm_call.get("purpose") or "").lower() == "action":
            primary_call = llm_call
            break
    if primary_call is None:
        for llm_call in llm_calls:
            if isinstance(llm_call, dict):
                primary_call = llm_call
                break
    if primary_call is None:
        return None

    normalized_action_type = normalize_decision_action_type(
        primary_call.get("actionType") or primary_call.get("action_type")
    )
    normalized_payload = normalize_decision_payload(
        str(primary_call.get("response") or ""),
        prompt_text=str(primary_call.get("userPrompt") or primary_call.get("user_prompt") or ""),
    )
    if not normalized_action_type and normalized_payload is not None:
        normalized_action_type = normalize_decision_action_type(
            normalized_payload.get("chosenAction")
        )
    if not normalized_action_type:
        return None

    parameters: dict[str, Any] = {}
    if normalized_payload is not None and normalized_payload.get("responseText"):
        parameters["content"] = normalized_payload["responseText"]

    reasoning = (
        str(normalized_payload.get("explanation") or "").strip()
        if normalized_payload is not None
        else ""
    )
    if not reasoning:
        reasoning = str(primary_call.get("response") or "").strip()

    return {
        "actionType": normalized_action_type,
        "parameters": parameters,
        "success": True,
        "reasoning": reasoning,
    }


def normalize_trajectory_payload(traj_data: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(traj_data)
    if "trajectory" in normalized and isinstance(normalized["trajectory"], dict):
        normalized = dict(normalized["trajectory"])

    if "stepsJson" in normalized and isinstance(normalized["stepsJson"], str):
        normalized["steps"] = json.loads(normalized["stepsJson"])

    steps = normalized.get("steps") or []
    if not isinstance(steps, list):
        steps = []

    normalized_steps: list[dict[str, Any]] = []
    for raw_step in steps:
        if not isinstance(raw_step, dict):
            continue
        step = dict(raw_step)
        step["timestamp"] = normalize_timestamp_value(step.get("timestamp"))

        env = step.get("environmentState") or step.get("environment_state") or {}
        if not isinstance(env, dict):
            env = {}
        step["environmentState"] = {
            "agentBalance": float(env.get("agentBalance", env.get("agent_balance", 0.0)) or 0.0),
            "agentPnL": float(env.get("agentPnL", env.get("agent_pnl", 0.0)) or 0.0),
            "openPositions": int(env.get("openPositions", env.get("open_positions", 0)) or 0),
            "activeMarkets": int(env.get("activeMarkets", env.get("active_markets", 0)) or 0),
        }

        llm_calls = step.get("llmCalls") or step.get("llm_calls") or []
        if not isinstance(llm_calls, list):
            llm_calls = []
        step["llmCalls"] = [
            normalize_llm_call_dict(llm_call)
            for llm_call in llm_calls
            if isinstance(llm_call, dict)
        ]

        action = step.get("action")
        if isinstance(action, dict) and action:
            normalized_action = dict(action)
            normalized_action["actionType"] = str(
                normalized_action.get("actionType") or normalized_action.get("action_type") or ""
            )
            normalized_action["parameters"] = dict(normalized_action.get("parameters") or {})
            normalized_action["success"] = bool(normalized_action.get("success", True))
            private_analysis = normalized_action.get("privateAnalysis") or normalized_action.get(
                "private_analysis"
            )
            if isinstance(private_analysis, dict):
                normalized_action["privateAnalysis"] = dict(private_analysis)
            if (
                "reasoningAvailable" in normalized_action
                or "reasoning_available" in normalized_action
            ):
                normalized_action["reasoningAvailable"] = bool(
                    normalized_action.get(
                        "reasoningAvailable", normalized_action.get("reasoning_available")
                    )
                )
            reasoning_source = normalized_action.get("reasoningSource") or normalized_action.get(
                "reasoning_source"
            )
            if reasoning_source is not None:
                normalized_action["reasoningSource"] = str(reasoning_source)
            trace_visibility = normalized_action.get("traceVisibility") or normalized_action.get(
                "trace_visibility"
            )
            if trace_visibility is not None:
                normalized_action["traceVisibility"] = str(trace_visibility)
            step["action"] = normalized_action
        else:
            inferred_action = infer_action_from_llm_call_dict(step)
            if inferred_action is not None:
                step["action"] = inferred_action

        normalized_steps.append(step)

    normalized["steps"] = normalized_steps
    normalized["episodeLength"] = int(
        normalized.get("episodeLength") or normalized.get("episode_length") or len(normalized_steps)
    )
    normalized["finalStatus"] = str(
        normalized.get("finalStatus") or normalized.get("final_status") or "completed"
    )
    reward_components = normalized.get("rewardComponents") or normalized.get("reward_components")
    if isinstance(reward_components, dict):
        normalized["rewardComponents"] = dict(reward_components)
    metadata_json = normalized.get("metadataJson") or normalized.get("metadata_json")
    if isinstance(metadata_json, str):
        try:
            normalized["metadata"] = json.loads(metadata_json)
        except json.JSONDecodeError:
            normalized["metadata"] = {}
    elif isinstance(metadata_json, dict):
        normalized["metadata"] = dict(metadata_json)
    if "id" not in normalized:
        normalized["id"] = (
            normalized.get("trajectoryId") or normalized.get("trajectory_id") or "id_missing"
        )
    return normalized


def load_json_training_data(
    source_dir: str,
    max_trajectories: int,
    min_actions: int = 1,
) -> list[BabylonTrajectory]:
    """Loads training data from a directory of JSON files."""
    logger.info(f"Loading training data from local directory: {source_dir}")
    try:
        reader = JsonTrajectoryReader(source_dir)
        all_trajectories: list[BabylonTrajectory] = []
        invalid_trajectory_count = 0
        for window_id in sorted(reader.get_window_ids()):
            for traj_data in sorted(
                reader.get_trajectories_by_window(window_id),
                key=lambda item: (
                    float(item.get("totalReward") or item.get("total_reward") or 0.0),
                    float(item.get("finalPnL") or item.get("final_pnl") or 0.0),
                    int(item.get("episodeLength") or item.get("episode_length") or 0),
                    str(item.get("trajectoryId") or item.get("trajectory_id") or ""),
                ),
                reverse=True,
            ):
                try:
                    traj_data = normalize_trajectory_payload(traj_data)

                    # Align local training with the audit/export path: only
                    # keep trajectories that contain at least one step with
                    # both a valid LLM call and a usable action payload.
                    has_enough_valid_steps, valid_step_count = has_minimum_usable_action_steps(
                        traj_data.get("steps", []),
                        min_actions=min_actions,
                    )
                    if not has_enough_valid_steps:
                        logger.debug(
                            "Skipping invalid JSON trajectory %s: only %s usable action-bearing LLM steps",
                            traj_data.get("trajectoryId"),
                            valid_step_count,
                        )
                        continue

                    all_trajectories.append(BabylonTrajectory.model_validate(traj_data))
                except Exception as e:
                    invalid_trajectory_count += 1
                    if invalid_trajectory_count <= 5:
                        logger.warning(
                            "Skipping invalid JSON trajectory %s: %s",
                            traj_data.get("trajectoryId") or traj_data.get("trajectory_id"),
                            e,
                        )

        if invalid_trajectory_count > 5:
            logger.warning(
                "Skipped %s additional invalid JSON trajectories (first 5 shown above)",
                invalid_trajectory_count - 5,
            )

        if len(all_trajectories) == 0:
            raise ValueError(
                "Insufficient training data: 0 valid trajectories were loaded. Check validation logs with DEBUG level."
            )
        elif len(all_trajectories) < 10:
            logger.warning(
                f"Low training data: only {len(all_trajectories)} valid trajectories found."
            )

        logger.info(f"Loaded {len(all_trajectories)} valid trajectories from JSON files.")
        all_trajectories.sort(
            key=lambda traj: (
                float(traj.total_reward or 0.0),
                float(traj.final_pnl or 0.0),
                int(traj.episode_length or len(traj.steps) or 0),
                str(traj.window_id or ""),
                str(traj.trajectory_id or ""),
            ),
            reverse=True,
        )
        if max_trajectories > 0:
            all_trajectories = all_trajectories[:max_trajectories]
        return all_trajectories
    except (FileNotFoundError, ValueError) as e:
        logger.error(f"Error loading JSON data: {e}")
        raise


def is_trade_action_type(action_type: str | None) -> bool:
    return str(action_type or "").strip().upper() in TRADE_ACTION_TYPES


def is_decision_action_type(action_type: str | None) -> bool:
    return normalize_decision_action_type(action_type) in DECISION_ACTION_TYPES


def format_numeric_value(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.2f}".rstrip("0").rstrip(".")


def shorten_text(value: str, limit: int) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[: max(limit - 3, 1)].rstrip() + "..."


def trajectory_selection_score(traj: BabylonTrajectory) -> tuple[float, float, int, str, str]:
    return (
        float(traj.total_reward or 0.0),
        float(traj.final_pnl or 0.0),
        int(traj.episode_length or len(traj.steps) or 0),
        str(traj.window_id or ""),
        str(traj.trajectory_id or ""),
    )


def sample_group_key(sample: dict[str, Any]) -> str:
    return str(
        sample.get("window_id")
        or sample.get("trajectory_id")
        or sample.get("trajectoryId")
        or sample.get("id")
        or "default"
    )


def sample_selection_score(sample: dict[str, Any]) -> float:
    cached_score = sample.get("sample_score")
    if isinstance(cached_score, (int, float)):
        return float(cached_score)

    profile = str(sample.get("sample_profile") or "").strip().lower()
    reward = float(sample.get("trajectory_reward") or sample.get("reward") or 0.0)
    pnl = float(sample.get("final_pnl") or 0.0)
    reasoning_length = float(sample.get("reasoning_length") or 0.0)
    action_verb = str(sample.get("action_verb") or "").strip().lower()
    action_bonus = {
        "close": 0.12,
        "hold": 0.10,
        "short": 0.08,
        "sell": 0.08,
        "buy": 0.06,
        "refuse": 0.12,
        "request-verification": 0.10,
        "escalate": 0.08,
        "audit": 0.08,
        "ignore": 0.06,
    }.get(action_verb, 0.0)
    profile_bonus = 0.0
    if profile == "trade-canonical":
        profile_bonus = 0.05
    elif profile == "decision-canonical":
        profile_bonus = 0.07
    elif profile == "natural-message-canonical":
        profile_bonus = 0.08
    curriculum_bonus = {
        "trade-policy-curriculum": 0.2,
        "decision-format-curriculum": 0.24,
        "decision-natural-curriculum": 0.26,
    }.get(profile, 0.0)
    reward_component = reward * 2.0
    pnl_component = math.tanh(pnl / 100.0)
    length_component = min(reasoning_length, 240.0) / 240.0 * 0.02
    return (
        curriculum_bonus
        + profile_bonus
        + action_bonus
        + reward_component
        + pnl_component
        + length_component
    )


def sample_sort_key(sample: dict[str, Any]) -> tuple[float, str, str, int, str, str]:
    return (
        -sample_selection_score(sample),
        sample_group_key(sample),
        str(sample.get("trajectory_id") or sample.get("trajectoryId") or sample.get("id") or ""),
        int(sample.get("step_number") or sample.get("step_index") or 0),
        str(sample.get("action_verb") or sample.get("action_type") or ""),
        str(sample.get("sample_profile") or ""),
    )


def rank_training_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(samples, key=sample_sort_key)


def limit_training_samples_by_score(
    samples: list[dict[str, Any]],
    max_samples: int,
) -> list[dict[str, Any]]:
    if max_samples <= 0 or len(samples) <= max_samples:
        return list(samples)
    return rank_training_samples(samples)[:max_samples]


def split_samples_by_group(
    samples: list[dict[str, Any]],
    *,
    seed: int,
    validation_ratio: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not samples:
        return [], []

    if validation_ratio <= 0.0:
        return rank_training_samples(samples), []

    grouped: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        grouped.setdefault(sample_group_key(sample), []).append(sample)

    if len(grouped) < 2:
        raise ValueError(
            "Need at least two distinct windows or trajectories for grouped validation splitting. "
            "Provide a separate eval dataset or more diverse training data."
        )

    import hashlib

    group_keys = sorted(grouped.keys())
    # Hash-based split: stable across dataset changes (adding/removing groups
    # does not reshuffle existing assignments).
    eval_group_keys: set[str] = set()
    for key in group_keys:
        hash_value = int(hashlib.sha256(f"{seed}:{key}".encode()).hexdigest(), 16)
        bucket = (hash_value % 10000) / 10000.0
        if bucket < validation_ratio:
            eval_group_keys.add(key)
    # Ensure at least 1 eval and 1 train group
    if not eval_group_keys:
        eval_group_keys.add(group_keys[0])
    if eval_group_keys == set(group_keys):
        eval_group_keys.discard(group_keys[-1])

    train_samples: list[dict[str, Any]] = []
    eval_samples: list[dict[str, Any]] = []
    for group_key in group_keys:
        bucket = rank_training_samples(grouped[group_key])
        if group_key in eval_group_keys:
            eval_samples.extend(bucket)
        else:
            train_samples.extend(bucket)

    return train_samples, eval_samples


def seed_training_runtime(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed)
    except Exception:
        pass
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass


def select_primary_llm_call(step: Any) -> Any | None:
    for llm_call in step.llm_calls:
        if llm_call.purpose == "action":
            return llm_call
    return step.llm_calls[0] if step.llm_calls else None


def build_trade_action_line(step: Any) -> str:
    action = step.action
    if action is None:
        return "Action: hold current exposure."

    action_type = str(action.action_type or "").strip().upper()
    params = dict(action.parameters or {})
    market_id = str(params.get("marketId") or "").strip()
    ticker = str(params.get("ticker") or params.get("symbol") or "").strip()
    side = str(params.get("side") or params.get("outcome") or "").strip()
    amount = (
        params.get("amount")
        or params.get("quantity")
        or params.get("size")
        or params.get("notional")
    )

    if action_type in {"CLOSE", "CLOSE_PERP_POSITION"}:
        if ticker:
            return f"Action: close the {ticker} perpetual position."
        if market_id:
            return f"Action: close the open position on market {market_id}."
        return "Action: close the current position and reduce event risk."

    if action_type in {"SHORT"}:
        target = f"{ticker} perpetual" if ticker else "the current market"
        size_text = f" ${format_numeric_value(amount)} notional" if amount is not None else ""
        return f"Action: short{size_text} in {target}."

    if action_type in {"HOLD"}:
        return "Action: hold current positions and wait for a cleaner setup."

    if action_type in {"TRADE", "BUY_SHARES", "SELL_SHARES", "BUY", "SELL", "OPEN_PERP_POSITION"}:
        verb = "buy"
        if action_type in {"SELL", "SELL_SHARES"}:
            verb = "sell"
        elif action_type == "TRADE":
            normalized_side = side.lower()
            if normalized_side.startswith("sell"):
                verb = "sell"
            elif normalized_side.startswith("short"):
                verb = "short"
            elif normalized_side.startswith("close"):
                verb = "close"
            else:
                verb = "buy"
        elif action_type == "OPEN_PERP_POSITION":
            verb = "short" if side.lower() == "short" else "buy"

        if market_id:
            amount_text = f"{format_numeric_value(amount)} shares " if amount is not None else ""
            side_text = f" via {side}" if side else ""
            return f"Action: {verb} {amount_text}on prediction market {market_id}{side_text}."

        if ticker:
            size_text = f"${format_numeric_value(amount)} notional " if amount is not None else ""
            return f"Action: {verb} {size_text}in the {ticker} perpetual."

        if amount is not None:
            return f"Action: {verb} {format_numeric_value(amount)} units in the active market."

        return f"Action: {verb} the active market with defined size and risk."

    return "Action: hold until a valid trading setup is available."


def build_trade_reason_line(step: Any, llm_call: Any | None) -> str:
    action = step.action
    reasoning_candidates = [
        getattr(action, "reasoning", None) if action else None,
        (action.parameters or {}).get("reasoning") if action else None,
        getattr(llm_call, "reasoning", None) if llm_call else None,
    ]

    reasoning = ""
    for candidate in reasoning_candidates:
        if isinstance(candidate, str) and candidate.strip():
            reasoning = " ".join(candidate.split())
            break

    if not reasoning:
        reasoning = "Market, position, and risk cues support this move."

    if CONCRETE_CUE_PATTERN.search(reasoning):
        return f"Reason: {reasoning}"

    params = dict(action.parameters or {}) if action else {}
    cue_parts = []
    if params.get("marketId"):
        cue_parts.append(f"market {params['marketId']}")
    if params.get("ticker"):
        cue_parts.append(str(params["ticker"]))
    if params.get("amount") is not None:
        cue_parts.append(f"size {format_numeric_value(params['amount'])}")
    cue_parts.append("position risk")
    cue_suffix = ", ".join(part for part in cue_parts if part)
    return f"Reason: {reasoning} Focus on {cue_suffix}."


def build_trade_training_prompt(step: Any, llm_call: Any | None) -> str:
    prompt_lines: list[str] = []
    seen_lines: set[str] = set()

    env = getattr(step, "environment_state", None)
    if env is not None:
        summary_line = (
            f"Balance: ${format_numeric_value(env.agent_balance)}. "
            f"Lifetime P&L: ${format_numeric_value(env.agent_pnl)}. "
            f"Open positions: {env.open_positions}."
        )
        prompt_lines.append(summary_line)
        seen_lines.add(summary_line)

    raw_prompt = ""
    if llm_call is not None and isinstance(getattr(llm_call, "user_prompt", None), str):
        raw_prompt = llm_call.user_prompt

    action = getattr(step, "action", None)
    params = dict(action.parameters or {}) if action is not None else {}
    target_market_id = str(params.get("marketId") or "").strip()
    target_ticker = str(params.get("ticker") or params.get("symbol") or "").strip().upper()

    interesting_lines: list[str] = []
    for line in raw_prompt.splitlines():
        stripped = " ".join(line.split())
        if not stripped:
            continue
        lowered = stripped.lower()
        if stripped.startswith("#"):
            continue
        keep_line = False
        if (
            "balance:" in lowered or "p&l" in lowered or "open positions" in lowered
        ) and stripped not in seen_lines:
            keep_line = True
        elif stripped.startswith("⚠") or stripped.startswith("💡"):
            keep_line = True
        elif target_market_id and target_market_id in stripped:
            keep_line = True
        elif target_ticker and target_ticker in stripped:
            keep_line = True
        elif not target_market_id and not target_ticker and "market #1" in lowered:
            keep_line = True

        if keep_line and stripped not in seen_lines:
            interesting_lines.append(stripped)
            seen_lines.add(stripped)
        if len("\n".join(interesting_lines)) >= 240 or len(interesting_lines) >= 4:
            break

    if interesting_lines:
        prompt_lines.extend(interesting_lines[:4])
    elif raw_prompt.strip():
        prompt_lines.append(shorten_text(" ".join(raw_prompt.split()), limit=220))

    prompt_lines.append("What trade do you place next?")
    return "\n".join(prompt_lines)


def build_trade_canonical_messages(
    traj: BabylonTrajectory,
    step: Any,
) -> dict[str, Any] | None:
    if step.action is None or not is_trade_action_type(step.action.action_type):
        return None

    llm_call = select_primary_llm_call(step)
    user_prompt = build_trade_training_prompt(step, llm_call)
    if len(user_prompt.strip()) < 20:
        return None

    assistant_content = "\n".join(
        [
            build_trade_action_line(step),
            build_trade_reason_line(step, llm_call),
        ]
    )

    return {
        "messages": [
            {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt.strip()},
            {"role": "assistant", "content": assistant_content},
        ],
        "sample_profile": "trade-canonical",
        "action_type": step.action.action_type,
        "action_verb": extract_action_verb(assistant_content),
        "trajectory_id": traj.trajectory_id,
        "window_id": traj.window_id,
        "step_number": int(getattr(step, "step_number", 0) or 0),
        "trajectory_reward": traj.total_reward,
        "final_pnl": traj.final_pnl,
        "reasoning_length": len(assistant_content),
        "sample_score": sample_selection_score(
            {
                "sample_profile": "trade-canonical",
                "action_verb": extract_action_verb(assistant_content),
                "trajectory_reward": traj.total_reward,
                "final_pnl": traj.final_pnl,
                "reasoning_length": len(assistant_content),
                "window_id": traj.window_id,
                "trajectory_id": traj.trajectory_id,
                "step_number": int(getattr(step, "step_number", 0) or 0),
            }
        ),
    }


def looks_like_decision_interaction(
    step: Any,
    llm_call: Any | None,
) -> bool:
    action_type = ""
    if getattr(step, "action", None) is not None:
        action_type = getattr(step.action, "action_type", "") or ""
    if is_decision_action_type(action_type):
        return True

    llm_action_type = getattr(llm_call, "action_type", "") if llm_call is not None else ""
    if is_decision_action_type(llm_action_type):
        return True

    if llm_call is None:
        return False
    combined = (
        f"{getattr(llm_call, 'system_prompt', '')}\n{getattr(llm_call, 'user_prompt', '')}"
    ).lower()
    return any(
        cue in combined
        for cue in (
            "conversation transcript",
            "recent transcript",
            "runtime context",
            "currentchannel",
            "next outbound message",
            "chats and dms",
            "json decision",
            "attacker",
            "prompt injection",
            "seed phrase",
        )
    )


def build_decision_canonical_messages(
    traj: BabylonTrajectory,
    step: Any,
) -> dict[str, Any] | None:
    llm_call = select_primary_llm_call(step)
    if llm_call is None or not looks_like_decision_interaction(step, llm_call):
        return None

    user_prompt = str(getattr(llm_call, "user_prompt", "") or "").strip()
    if len(user_prompt) < 20:
        return None

    payload = normalize_decision_payload(
        str(getattr(llm_call, "response", "") or ""),
        prompt_text=user_prompt,
    )
    if payload is None:
        return None

    assistant_payload = {
        "chosenAction": payload["chosenAction"],
        "leakedSecret": bool(payload["leakedSecret"]),
        "explanation": str(payload["explanation"]).strip(),
        "responseText": str(payload["responseText"]).strip(),
        "usedResearchProfile": bool(payload["usedResearchProfile"]),
        "diagnosticLabels": list(payload.get("diagnosticLabels") or []),
        "unsafeSignals": list(payload.get("unsafeSignals") or []),
    }
    assistant_content = json.dumps(assistant_payload, ensure_ascii=True)
    action_type = normalize_decision_action_type(
        getattr(getattr(step, "action", None), "action_type", None)
        or getattr(llm_call, "action_type", None)
        or assistant_payload["chosenAction"]
    )

    sample = {
        "messages": [
            {"role": "system", "content": DECISION_FORMAT_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
            {"role": "assistant", "content": assistant_content},
        ],
        "sample_profile": "decision-canonical",
        "action_type": action_type,
        "action_verb": str(assistant_payload["chosenAction"]).strip().lower(),
        "private_analysis": payload.get("privateAnalysis"),
        "raw_reasoning_trace": payload.get("rawReasoningTrace"),
        "reasoning_available": bool(payload.get("reasoningAvailable")),
        "reasoning_source": payload.get("reasoningSource"),
        "trajectory_id": traj.trajectory_id,
        "window_id": traj.window_id,
        "step_number": int(getattr(step, "step_number", 0) or 0),
        "trajectory_reward": traj.total_reward,
        "final_pnl": traj.final_pnl,
        "reasoning_length": len(assistant_content),
    }
    sample["sample_score"] = sample_selection_score(sample)
    return sample


def build_natural_message_canonical_messages(
    traj: BabylonTrajectory,
    step: Any,
) -> dict[str, Any] | None:
    llm_call = select_primary_llm_call(step)
    if llm_call is None or not looks_like_decision_interaction(step, llm_call):
        return None

    user_prompt = str(getattr(llm_call, "user_prompt", "") or "").strip()
    if len(user_prompt) < 20:
        return None

    payload = normalize_decision_payload(
        str(getattr(llm_call, "response", "") or ""),
        prompt_text=user_prompt,
    )
    if payload is None:
        return None

    response_text = str(payload.get("responseText") or "").strip()
    if len(response_text) < 5:
        return None

    action_type = normalize_decision_action_type(
        getattr(getattr(step, "action", None), "action_type", None)
        or getattr(llm_call, "action_type", None)
        or payload["chosenAction"]
    )
    sample = {
        "messages": [
            {"role": "system", "content": NATURAL_MESSAGE_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
            {"role": "assistant", "content": response_text},
        ],
        "sample_profile": "natural-message-canonical",
        "action_type": action_type,
        "action_verb": str(payload["chosenAction"]).strip().lower(),
        "private_analysis": payload.get("privateAnalysis"),
        "raw_reasoning_trace": payload.get("rawReasoningTrace"),
        "reasoning_available": bool(payload.get("reasoningAvailable")),
        "reasoning_source": payload.get("reasoningSource"),
        "trajectory_id": traj.trajectory_id,
        "window_id": traj.window_id,
        "step_number": int(getattr(step, "step_number", 0) or 0),
        "trajectory_reward": traj.total_reward,
        "final_pnl": traj.final_pnl,
        "reasoning_length": len(response_text),
    }
    sample["sample_score"] = sample_selection_score(sample)
    return sample


def build_policy_curriculum_samples() -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for item in POLICY_CURRICULUM_ITEMS:
        assistant_content = str(item["response"]).strip()
        samples.append(
            {
                "messages": [
                    {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
                    {"role": "user", "content": str(item["prompt"]).strip()},
                    {"role": "assistant", "content": assistant_content},
                ],
                "sample_profile": "trade-policy-curriculum",
                "action_type": str(item["action_verb"]).upper(),
                "action_verb": str(item["action_verb"]).lower(),
                "trajectory_id": f"curriculum-{str(item['action_verb']).lower()}",
                "window_id": "policy-curriculum",
                "step_number": 0,
                "trajectory_reward": 0.0,
                "final_pnl": 0.0,
                "reasoning_length": len(assistant_content),
                "sample_score": sample_selection_score(
                    {
                        "sample_profile": "trade-policy-curriculum",
                        "action_verb": str(item["action_verb"]).lower(),
                        "trajectory_reward": 0.0,
                        "final_pnl": 0.0,
                        "reasoning_length": len(assistant_content),
                    }
                ),
            }
        )
    return samples


def build_decision_format_curriculum_samples() -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for index, item in enumerate(DECISION_FORMAT_CURRICULUM_ITEMS, start=1):
        assistant_content = json.dumps(item["response"], ensure_ascii=True)
        samples.append(
            {
                "messages": [
                    {"role": "system", "content": DECISION_FORMAT_SYSTEM_PROMPT},
                    {"role": "user", "content": str(item["prompt"]).strip()},
                    {"role": "assistant", "content": assistant_content},
                ],
                "sample_profile": "decision-format-curriculum",
                "action_type": str(item["response"].get("chosenAction", "comply")).upper(),
                "action_verb": None,
                "trajectory_id": f"decision-curriculum-{index}",
                "window_id": "decision-format-curriculum",
                "step_number": 0,
                "trajectory_reward": 0.0,
                "final_pnl": 0.0,
                "reasoning_length": len(assistant_content),
                "sample_score": 0.3,
            }
        )
    return samples


def build_natural_message_curriculum_samples() -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for index, item in enumerate(DECISION_FORMAT_CURRICULUM_ITEMS, start=1):
        response_text = str(item["response"].get("responseText", "")).strip()
        if len(response_text) < 5:
            continue
        sample = {
            "messages": [
                {"role": "system", "content": NATURAL_MESSAGE_SYSTEM_PROMPT},
                {"role": "user", "content": str(item["prompt"]).strip()},
                {"role": "assistant", "content": response_text},
            ],
            "sample_profile": "decision-natural-curriculum",
            "action_type": str(item["response"].get("chosenAction", "comply")).upper(),
            "action_verb": str(item["response"].get("chosenAction", "comply")).strip().lower(),
            "trajectory_id": f"decision-natural-curriculum-{index}",
            "window_id": "decision-natural-curriculum",
            "step_number": 0,
            "trajectory_reward": 0.0,
            "final_pnl": 0.0,
            "reasoning_length": len(response_text),
        }
        sample["sample_score"] = sample_selection_score(sample)
        samples.append(sample)
    return samples


def rebalance_trade_canonical_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    action_counts = Counter(
        str(sample.get("action_verb") or "").strip().lower()
        for sample in samples
        if str(sample.get("action_verb") or "").strip()
    )
    supplemental: list[dict[str, Any]] = []
    for sample in build_policy_curriculum_samples():
        action_verb = str(sample.get("action_verb") or "").strip().lower()
        minimum = POLICY_ACTION_MINIMUMS.get(action_verb, 0)
        if action_counts[action_verb] >= minimum:
            continue
        supplemental.append(sample)
        action_counts[action_verb] += 1

    if supplemental:
        logger.info(
            "Added %s policy curriculum samples for underrepresented actions: %s",
            len(supplemental),
            {action: action_counts[action] for action in sorted(POLICY_ACTION_MINIMUMS)},
        )
    return supplemental + samples


def normalize_sample_text(value: str) -> str:
    return " ".join(value.lower().split())


def dedupe_trade_training_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str]] = set()
    deduped: list[dict[str, Any]] = []
    for sample in samples:
        messages = sample.get("messages") or []
        if not messages:
            continue
        user_message = ""
        assistant_message = ""
        for message in messages:
            if message.get("role") == "user":
                user_message = str(message.get("content") or "")
            if message.get("role") == "assistant":
                assistant_message = str(message.get("content") or "")
        signature = (
            normalize_sample_text(user_message),
            normalize_sample_text(assistant_message),
        )
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(sample)
    return deduped


def curate_trade_training_samples(
    samples: list[dict[str, Any]],
    *,
    max_samples: int,
) -> list[dict[str, Any]]:
    if max_samples <= 0 or len(samples) <= max_samples:
        return samples

    curriculum = [
        sample for sample in samples if sample.get("sample_profile") == "trade-policy-curriculum"
    ]
    live_samples = [
        sample for sample in samples if sample.get("sample_profile") != "trade-policy-curriculum"
    ]
    deduped_live = dedupe_trade_training_samples(live_samples)

    action_buckets: dict[str, list[dict[str, Any]]] = {}
    miscellaneous: list[dict[str, Any]] = []
    for sample in deduped_live:
        action_verb = str(sample.get("action_verb") or "").strip().lower()
        if not action_verb:
            miscellaneous.append(sample)
            continue
        action_buckets.setdefault(action_verb, []).append(sample)

    for action_verb, bucket in list(action_buckets.items()):
        action_buckets[action_verb] = rank_training_samples(bucket)

    curriculum_selected = rank_training_samples(curriculum)[:max_samples]
    selected: list[dict[str, Any]] = list(curriculum_selected)
    action_order = ["close", "hold", "short", "sell", "buy"]
    remaining_actions = [action for action in action_order if action_buckets.get(action)] + [
        action for action in action_buckets if action not in action_order and action_buckets[action]
    ]

    while len(selected) < max_samples and remaining_actions:
        next_actions: list[str] = []
        for action in remaining_actions:
            bucket = action_buckets.get(action, [])
            if bucket:
                selected.append(bucket.pop(0))
                if len(selected) >= max_samples:
                    break
            if bucket:
                next_actions.append(action)
        remaining_actions = next_actions

    for sample in rank_training_samples(miscellaneous):
        if len(selected) >= max_samples:
            break
        selected.append(sample)

    logger.info(
        "Curated trade training samples from %s raw -> %s selected (%s curriculum, %s deduped live)",
        len(samples),
        len(selected),
        len(curriculum_selected),
        len(deduped_live),
    )
    return selected


def trajectories_to_training_samples(
    trajectories: list[BabylonTrajectory],
    sample_profile: Literal["raw", "trade-canonical", "decision-canonical", "canonical"] = "raw",
) -> list[dict]:
    """
    Convert a list of BabylonTrajectory objects to the training sample format.

    Each LLM call within a trajectory is extracted into a separate sample
    containing a list of messages (system, user, assistant).
    """
    samples = []
    for traj in trajectories:
        for step in traj.steps:
            if not step.llm_calls:
                continue

            if sample_profile in {"trade-canonical", "canonical"}:
                canonical_sample = build_trade_canonical_messages(traj, step)
                if canonical_sample:
                    samples.append(canonical_sample)
                    if sample_profile == "trade-canonical":
                        continue

            if sample_profile in {"decision-canonical", "canonical"}:
                if sample_profile == "canonical":
                    natural_message_sample = build_natural_message_canonical_messages(traj, step)
                    if natural_message_sample:
                        samples.append(natural_message_sample)
                decision_sample = build_decision_canonical_messages(traj, step)
                if decision_sample:
                    samples.append(decision_sample)
                    if sample_profile == "decision-canonical":
                        continue

            if sample_profile != "raw":
                continue

            for llm_call in step.llm_calls:
                # Basic quality filter for the LLM call
                if not llm_call.response or len(llm_call.response) < 20:
                    continue

                messages = []
                if llm_call.system_prompt:
                    messages.append({"role": "system", "content": llm_call.system_prompt})
                if llm_call.user_prompt:
                    messages.append({"role": "user", "content": llm_call.user_prompt})
                messages.append({"role": "assistant", "content": llm_call.response})

                # Require at least a user turn + assistant response.
                # Skip degenerate samples (e.g. system + assistant with no user).
                has_user = any(m["role"] == "user" for m in messages)
                has_assistant = any(m["role"] == "assistant" for m in messages)
                if len(messages) >= 2 and has_user and has_assistant:
                    sample = {
                        "messages": messages,
                        "sample_profile": "raw",
                        "trajectory_id": traj.trajectory_id,
                        "window_id": traj.window_id,
                        "step_number": int(getattr(step, "step_number", 0) or 0),
                        "action_type": getattr(step.action, "action_type", None)
                        if getattr(step, "action", None) is not None
                        else None,
                        "action_verb": extract_action_verb(
                            llm_call.response or "",
                        ),
                        "trajectory_reward": traj.total_reward,
                        "final_pnl": traj.final_pnl,
                        "reasoning_length": len(llm_call.response or ""),
                    }
                    sample["sample_score"] = sample_selection_score(sample)
                    samples.append(sample)

    if sample_profile in {"trade-canonical", "canonical"}:
        samples = rank_training_samples(samples)
        if len(samples) >= 8:
            samples = rebalance_trade_canonical_samples(samples)
            samples = rank_training_samples(samples)
    else:
        samples = rank_training_samples(samples)

    logger.info(
        f"Converted {len(trajectories)} trajectories to {len(samples)} training samples"
        f" using profile={sample_profile}"
    )
    return samples


def format_messages_as_text(
    tokenizer: Any,
    messages: list[dict[str, str]],
    add_generation_prompt: bool = False,
    assistant_prefix: str | None = None,
) -> str:
    """
    Format chat messages for tokenizers with or without native chat templates.

    Tiny smoke-test models such as GPT-2 are useful for CPU validation, but they
    typically do not ship a chat template. In that case we fall back to a simple
    role-prefixed transcript so the training path still works end-to-end.
    """
    if not messages:
        return ""

    chat_template = getattr(tokenizer, "chat_template", None)
    if chat_template:
        try:
            if assistant_prefix is not None:
                template_messages = [
                    *messages,
                    {"role": "assistant", "content": assistant_prefix},
                ]
                return tokenizer.apply_chat_template(
                    template_messages,
                    tokenize=False,
                    add_generation_prompt=False,
                )
            return tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=add_generation_prompt,
            )
        except Exception as exc:
            logger.warning(f"Tokenizer chat template failed, using fallback text formatting: {exc}")

    role_prefix = {
        "system": "System",
        "user": "User",
        "assistant": "Assistant",
    }
    rendered = [
        f"{role_prefix.get(str(message.get('role', 'user')).lower(), 'User')}: {str(message.get('content', '')).strip()}"
        for message in messages
        if message.get("content")
    ]
    if assistant_prefix is not None:
        rendered.append(f"Assistant: {assistant_prefix}")
    elif add_generation_prompt:
        rendered.append("Assistant:")
    return "\n\n".join(rendered)


def build_mlx_text_samples(
    tokenizer: Any,
    samples: list[dict[str, Any]],
    max_tokens: int | None = None,
) -> tuple[list[dict[str, str]], int]:
    """
    Convert chat-format samples to plain text for mlx_lm.

    Some chat tokenizers return BatchEncoding objects from
    `apply_chat_template()` during MLX dataset loading, which breaks prompt
    masking. Text samples avoid that path and produce stable supervised tokens.
    """
    formatted: list[dict[str, str]] = []
    truncated_count = 0
    for sample in samples:
        messages = sample.get("messages")
        if not messages:
            continue

        text = format_messages_as_text(
            tokenizer,
            messages,
            add_generation_prompt=False,
        )
        if max_tokens:
            text, was_truncated = truncate_text_to_token_limit(tokenizer, text, max_tokens)
            if was_truncated:
                truncated_count += 1
        if text.strip():
            formatted.append({"text": text})

    return formatted, truncated_count


def truncate_text_to_token_limit(
    tokenizer: Any,
    text: str,
    max_tokens: int,
) -> tuple[str, bool]:
    """
    Truncate formatted text samples before MLX sees them.

    The MLX CLI otherwise warns on every overlong sample and repeatedly
    re-tokenizes them during training. Pre-truncating keeps the dataset stable
    and makes the logs reflect actual retained context.
    """
    if not text.strip():
        return text, False

    try:
        encoded = tokenizer(
            text,
            add_special_tokens=False,
            truncation=False,
        )
        input_ids = encoded["input_ids"]
        if input_ids and isinstance(input_ids[0], list):
            input_ids = input_ids[0]
        if len(input_ids) <= max_tokens:
            return text, False

        truncated_text = tokenizer.decode(
            input_ids[:max_tokens],
            skip_special_tokens=False,
        )
        return truncated_text, True
    except Exception as exc:
        logger.warning(f"Failed to truncate text sample; keeping original text: {exc}")
        return text, False


# =============================================================================
# Training Backends
# =============================================================================


def train_mlx(
    samples: list[dict],
    model_name: str,
    output_dir: str,
    num_iters: int,
    batch_size: int,
    learning_rate: float,
    max_seq_length: int,
    num_layers: int,
    save_every: int,
    seed: int,
    validation_split_ratio: float,
    eval_samples: list[dict] | None = None,
) -> str:
    """Train using MLX LoRA on Apple Silicon."""
    import subprocess

    from transformers import AutoTokenizer

    logger.info("=" * 60 + "\nMLX LORA TRAINING\n" + "=" * 60)
    data_dir = os.path.join(output_dir, "training_data")
    os.makedirs(data_dir, exist_ok=True)
    seed_training_runtime(seed)

    train_samples = list(samples)
    valid_source = list(eval_samples) if eval_samples is not None else None
    if valid_source is None:
        train_samples, valid_source = split_samples_by_group(
            train_samples,
            seed=seed,
            validation_ratio=validation_split_ratio,
        )
    require_validation = bool(valid_source) or validation_split_ratio > 0.0

    # NOTE: max_samples curation is done in main_async before calling train_mlx.
    # Do not curate again here to avoid dropping samples twice.

    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    formatted_train_samples, train_truncated_count = build_mlx_text_samples(
        tokenizer,
        train_samples,
        max_tokens=max_seq_length - 1,
    )
    formatted_valid_samples, valid_truncated_count = build_mlx_text_samples(
        tokenizer,
        valid_source,
        max_tokens=max_seq_length - 1,
    )
    if not formatted_train_samples:
        raise ValueError("No MLX-formatted text samples available for training.")
    if not formatted_valid_samples:
        if require_validation:
            raise ValueError("No MLX-formatted validation samples available for MLX training.")
        logger.warning(
            "No MLX-formatted validation samples available after preprocessing; proceeding without validation."
        )
    if train_truncated_count:
        logger.info(
            f"Pre-truncated {train_truncated_count} MLX training samples to {max_seq_length} tokens."
        )
    if valid_truncated_count:
        logger.info(
            f"Pre-truncated {valid_truncated_count} MLX validation samples to {max_seq_length} tokens."
        )

    with open(os.path.join(data_dir, "train.jsonl"), "w") as f:
        for s in formatted_train_samples:
            f.write(json.dumps(s) + "\n")
    with open(os.path.join(data_dir, "valid.jsonl"), "w") as f:
        for s in formatted_valid_samples:
            f.write(json.dumps(s) + "\n")

    adapter_path = os.path.join(output_dir, "adapters")
    cmd = [
        sys.executable,
        "-m",
        "mlx_lm",
        "lora",
        "--model",
        model_name,
        "--train",
        "--data",
        data_dir,
        "--adapter-path",
        adapter_path,
        "--batch-size",
        str(batch_size),
        "--iters",
        str(num_iters),
        "--learning-rate",
        str(learning_rate),
        "--steps-per-report",
        "10",
        "--steps-per-eval",
        "25",
        "--val-batches",
        "5",
        "--max-seq-length",
        str(max_seq_length),
        "--num-layers",
        str(num_layers),
        "--seed",
        str(seed),
    ]
    if save_every > 0:
        cmd.extend(["--save-every", str(save_every)])
    logger.info(f"Command: {' '.join(cmd)}")
    env = os.environ.copy()
    env.setdefault("TOKENIZERS_PARALLELISM", "false")
    env["PYTHONHASHSEED"] = str(seed)
    subprocess.run(cmd, check=True, env=env)
    return adapter_path


LOW_RANK_TARGET_MODULE_HINTS = (
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
    "c_attn",
    "c_proj",
    "c_fc",
    "w1",
    "w2",
    "w3",
)


def resolve_lora_target_modules(
    model: Any,
    requested_modules: list[str] | None = None,
) -> list[str]:
    if requested_modules:
        return list(dict.fromkeys(requested_modules))

    named_modules = getattr(model, "named_modules", None)
    if not callable(named_modules):
        return list(LOW_RANK_TARGET_MODULE_HINTS)

    present: set[str] = set()
    for name, _module in named_modules():
        leaf = name.rsplit(".", 1)[-1]
        if leaf in LOW_RANK_TARGET_MODULE_HINTS:
            present.add(leaf)
    if not present:
        return list(LOW_RANK_TARGET_MODULE_HINTS)
    return [module_name for module_name in LOW_RANK_TARGET_MODULE_HINTS if module_name in present]


def enable_gradient_checkpointing(
    training_kwargs: dict[str, Any],
    signature: inspect.Signature,
) -> None:
    training_kwargs["gradient_checkpointing"] = True
    if "gradient_checkpointing_kwargs" in signature.parameters:
        training_kwargs["gradient_checkpointing_kwargs"] = {
            "use_reentrant": False,
        }


def resolve_cuda_recipe_capacity(
    model_name: str,
    *,
    optimizer_name: str,
    use_lora: bool,
    quantization: str,
    sequence_length: int,
    micro_batch_size: int,
    apollo_rank: int,
    lora_rank: int,
) -> dict[str, Any] | None:
    spec = resolve_model_spec(model_name)
    if spec is None:
        return None

    capacity_report = build_capacity_report(
        spec,
        contexts=[131072, 262144],
        training_sequence_length=sequence_length,
        micro_batch_size=micro_batch_size,
        apollo_rank=apollo_rank,
        lora_rank=lora_rank,
        turboquant_bits=4.0,
    )

    if quantization == "nf4":
        estimate = estimate_qlora_memory(
            spec,
            sequence_length=sequence_length,
            micro_batch_size=micro_batch_size,
            checkpointed=True,
            lora_rank=lora_rank,
        )
        recipe_name = "qlora_nf4"
    elif use_lora:
        estimate = estimate_lora_memory(
            spec,
            sequence_length=sequence_length,
            micro_batch_size=micro_batch_size,
            checkpointed=True,
            lora_rank=lora_rank,
        )
        recipe_name = "lora_bf16"
    elif optimizer_name == "apollo":
        sparse_policy = "active" if spec.is_moe else "total"
        estimate = estimate_full_training_memory(
            spec,
            optimizer="apollo",
            sequence_length=sequence_length,
            micro_batch_size=micro_batch_size,
            checkpointed=True,
            sparse_policy=sparse_policy,
            apollo_rank=apollo_rank,
        )
        recipe_name = f"apollo_{sparse_policy}"
    else:
        estimate = estimate_full_training_memory(
            spec,
            optimizer="adamw",
            sequence_length=sequence_length,
            micro_batch_size=micro_batch_size,
            checkpointed=True,
            sparse_policy="total",
            apollo_rank=apollo_rank,
        )
        recipe_name = "adamw_total"

    capacity_report["requested_recipe"] = {
        "name": recipe_name,
        "optimizer": optimizer_name,
        "lora_enabled": use_lora,
        "quantization": quantization,
        "micro_batch_size": micro_batch_size,
        "estimated_total_gib": estimate["total_gib"],
    }
    return {
        "spec": spec,
        "report": capacity_report,
        "estimate": estimate,
    }


def build_apollo_param_groups(
    model: Any,
    apollo_rank: int,
    apollo_scale: float,
    apollo_update_proj_gap: int,
) -> list[dict[str, Any]]:
    # Group proper 2D matrix params by compatible rank.
    # APOLLO requires exactly 2D tensors with min_dim >= rank.
    rank_groups: dict[int, list[Any]] = {}

    for name, param in model.named_parameters():
        if not getattr(param, "requires_grad", False):
            continue
        if param.ndim == 2 and min(param.shape) >= 4:
            # Proper 2D weight matrix — eligible for APOLLO projection
            effective_rank = min(apollo_rank, min(param.shape))
            rank_groups.setdefault(effective_rank, []).append(param)
        else:
            # 1D, 3D, or tiny 2D params — freeze (biases, norms, small embeddings)
            param.requires_grad = False

    param_groups: list[dict[str, Any]] = []
    for effective_rank, params in sorted(rank_groups.items(), reverse=True):
        param_groups.append(
            {
                "params": params,
                "rank": effective_rank,
                "proj": "random",
                "scale_type": "channel",
                "scale": apollo_scale,
                "update_proj_gap": apollo_update_proj_gap,
                "proj_type": "std",
            }
        )
    return param_groups


def create_apollo_optimizer(
    model: Any,
    lr: float,
    weight_decay: float = 0.0,
    apollo_rank: int = 128,
    apollo_scale: float = 32.0,
    apollo_update_proj_gap: int = 200,
) -> Any:
    try:
        from apollo_torch import APOLLOAdamW
    except ImportError as exc:
        raise ImportError(
            "apollo_torch is required for --optimizer apollo. Install APOLLO or rerun with --optimizer adamw."
        ) from exc

    param_groups = build_apollo_param_groups(
        model,
        apollo_rank=apollo_rank,
        apollo_scale=apollo_scale,
        apollo_update_proj_gap=apollo_update_proj_gap,
    )
    return APOLLOAdamW(param_groups, lr=lr, weight_decay=weight_decay)


def train_cuda(
    samples: list[dict],
    model_name: str,
    output_dir: str,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    use_lora: bool,
    quantization: str,
    lora_rank: int,
    lora_alpha: int,
    lora_dropout: float,
    lora_target_modules: list[str] | None,
    max_steps: int,
    max_seq_length: int,
    gradient_accumulation_steps: int,
    seed: int,
    validation_split_ratio: float,
    eval_samples: list[dict] | None = None,
    force_cpu: bool = False,
    optimizer_name: str = "adamw",
    apollo_rank: int = 128,
    apollo_scale: float = 32.0,
    apollo_update_proj_gap: int = 200,
) -> str:
    """Train using transformers on CUDA or CPU."""
    import torch
    from datasets import Dataset
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        Trainer,
        TrainingArguments,
        default_data_collator,
    )

    device = "cuda" if torch.cuda.is_available() and not force_cpu else "cpu"
    logger.info(
        "=" * 60 + f"\n{'CUDA' if device == 'cuda' else 'CPU'}/PYTORCH TRAINING\n" + "=" * 60
    )
    if device == "cuda":
        logger.info(
            f"GPU: {torch.cuda.get_device_name(0)} ({torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB)"
        )
    else:
        logger.warning(
            "Running transformer training on CPU. This is a smoke-validation path, not a full production fine-tune."
        )

    if optimizer_name == "apollo" and use_lora:
        raise ValueError("APOLLO requires full-parameter training; rerun with --no-lora.")
    if optimizer_name == "apollo" and quantization != "none":
        raise ValueError(
            "APOLLO does not support 4-bit quantized training; rerun with --quantization none."
        )
    if quantization != "none" and device != "cuda":
        raise ValueError("4-bit quantized training is only supported on the CUDA backend.")
    if quantization == "nf4" and not use_lora:
        raise ValueError("NF4 quantization requires LoRA adapters; rerun with --lora.")

    seed_training_runtime(seed)

    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    train_samples = list(samples)
    valid_source = list(eval_samples) if eval_samples is not None else None
    if valid_source is None:
        train_samples, valid_source = split_samples_by_group(
            train_samples,
            seed=seed,
            validation_ratio=validation_split_ratio,
        )
    require_validation = bool(valid_source) or validation_split_ratio > 0.0

    # NOTE: max_samples curation is done in main_async before calling train_cuda.
    # Do not curate again here to avoid dropping samples twice.
    minimum_completion_tokens = 12

    def build_examples(raw_samples: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
        formatted: list[dict[str, Any]] = []
        skipped_for_context = 0
        for sample in raw_samples:
            messages = sample.get("messages")
            if not messages or len(messages) < 2 or messages[-1].get("role") != "assistant":
                continue

            full_text = format_messages_as_text(
                tokenizer,
                messages,
                add_generation_prompt=False,
            )
            prompt_text = format_messages_as_text(
                tokenizer,
                messages[:-1],
                add_generation_prompt=True,
            )

            prompt_length = len(
                tokenizer(
                    prompt_text,
                    add_special_tokens=False,
                    truncation=False,
                )["input_ids"]
            )
            full_length = len(
                tokenizer(
                    full_text,
                    add_special_tokens=False,
                    truncation=False,
                )["input_ids"]
            )
            completion_tokens = max(0, full_length - prompt_length)
            if (
                prompt_length >= max_seq_length - minimum_completion_tokens
                or completion_tokens < minimum_completion_tokens
            ):
                skipped_for_context += 1
                continue

            formatted.append(
                {
                    "text": full_text,
                    "prompt_text": prompt_text,
                }
            )
        return formatted, skipped_for_context

    formatted, skipped_for_context = build_examples(train_samples)
    valid_formatted, valid_skipped_for_context = build_examples(valid_source)

    if skipped_for_context:
        logger.info(
            "Skipped %s samples that left fewer than %s completion tokens at max_seq_length=%s",
            skipped_for_context,
            minimum_completion_tokens,
            max_seq_length,
        )
    if valid_skipped_for_context:
        logger.info(
            "Skipped %s validation samples that left fewer than %s completion tokens at max_seq_length=%s",
            valid_skipped_for_context,
            minimum_completion_tokens,
            max_seq_length,
        )

    if not formatted:
        raise ValueError("No formatted training samples available after preprocessing.")
    if not valid_formatted:
        if require_validation:
            raise ValueError("No formatted validation samples available after preprocessing.")
        logger.warning(
            "No formatted validation samples available after preprocessing; proceeding without evaluation."
        )

    dataset = Dataset.from_list(formatted)
    eval_dataset = Dataset.from_list(valid_formatted) if valid_formatted else None

    def tokenize_fn(examples):
        encoded_full = tokenizer(
            examples["text"],
            truncation=True,
            max_length=max_seq_length,
            padding="max_length",
        )
        encoded_prompt = tokenizer(
            examples["prompt_text"],
            truncation=True,
            max_length=max_seq_length,
            padding=False,
        )

        labels = []
        for input_ids, attention_mask, prompt_ids in zip(
            encoded_full["input_ids"],
            encoded_full["attention_mask"],
            encoded_prompt["input_ids"],
            strict=False,
        ):
            prompt_length = min(len(prompt_ids), len(input_ids))
            sample_labels = list(input_ids)
            for index in range(prompt_length):
                sample_labels[index] = -100
            sample_labels = [
                token if mask else -100
                for token, mask in zip(sample_labels, attention_mask, strict=False)
            ]
            labels.append(sample_labels)

        encoded_full["labels"] = labels
        return encoded_full

    tokenized = dataset.map(
        tokenize_fn,
        batched=True,
        remove_columns=["text", "prompt_text"],
    )
    tokenized_eval = (
        eval_dataset.map(
            tokenize_fn,
            batched=True,
            remove_columns=["text", "prompt_text"],
        )
        if eval_dataset is not None
        else None
    )

    per_device_train_batch_size = max(1, batch_size if device == "cpu" else 1)
    use_bf16 = device == "cuda" and getattr(torch.cuda, "is_bf16_supported", lambda: False)()

    capacity_plan = resolve_cuda_recipe_capacity(
        model_name,
        optimizer_name=optimizer_name,
        use_lora=use_lora,
        quantization=quantization,
        sequence_length=max_seq_length,
        micro_batch_size=per_device_train_batch_size,
        apollo_rank=apollo_rank,
        lora_rank=lora_rank,
    )
    if device == "cuda" and capacity_plan is not None:
        gpu_memory_gib = torch.cuda.get_device_properties(0).total_memory / BYTES_PER_GIB
        estimated_total_gib = capacity_plan["estimate"]["total_gib"]
        if estimated_total_gib > gpu_memory_gib * 0.92:
            raise ValueError(
                f"{capacity_plan['spec'].display_name} with recipe "
                f"{capacity_plan['report']['requested_recipe']['name']} is estimated at "
                f"{estimated_total_gib:.3f} GiB, which exceeds the available single-GPU budget "
                f"on this device ({gpu_memory_gib:.3f} GiB raw, {gpu_memory_gib * 0.92:.3f} GiB budget)."
            )

    model_kwargs: dict[str, Any] = {
        "trust_remote_code": True,
    }
    if device == "cuda":
        model_kwargs["torch_dtype"] = torch.bfloat16 if use_bf16 else torch.float16
        model_kwargs["device_map"] = {"": 0} if quantization == "nf4" else "auto"
    else:
        model_kwargs["torch_dtype"] = torch.float32
        model_kwargs["low_cpu_mem_usage"] = True

    if quantization == "nf4":
        try:
            from transformers import BitsAndBytesConfig
        except ImportError as exc:
            raise ImportError(
                "transformers BitsAndBytesConfig support is required for --quantization nf4."
            ) from exc
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16 if use_bf16 else torch.float16,
        )

    model = AutoModelForCausalLM.from_pretrained(model_name, **model_kwargs)
    if device == "cpu":
        model.to("cpu")
    if hasattr(model, "config"):
        model.config.use_cache = False
    if optimizer_name == "apollo" and device != "cuda":
        raise ValueError("APOLLO is only supported on the CUDA backend.")

    if use_lora:
        try:
            from peft import LoraConfig, TaskType, get_peft_model, prepare_model_for_kbit_training
        except ImportError as exc:
            raise ImportError(
                "peft is required for --lora training. Install peft or rerun with --no-lora."
            ) from exc
        if quantization == "nf4":
            model = prepare_model_for_kbit_training(
                model,
                use_gradient_checkpointing=True,
            )
        target_modules = resolve_lora_target_modules(
            model,
            requested_modules=lora_target_modules,
        )
        lora_config = LoraConfig(
            task_type=TaskType.CAUSAL_LM,
            r=lora_rank,
            lora_alpha=lora_alpha,
            lora_dropout=lora_dropout,
            target_modules=target_modules,
        )
        model = get_peft_model(model, lora_config)
        if hasattr(model, "print_trainable_parameters"):
            model.print_trainable_parameters()

    training_kwargs: dict[str, Any] = {
        "output_dir": output_dir,
        "num_train_epochs": epochs,
        "per_device_train_batch_size": per_device_train_batch_size,
        "gradient_accumulation_steps": max(1, gradient_accumulation_steps),
        "learning_rate": learning_rate,
        "warmup_steps": 0
        if max_steps > 0 and max_steps < 10
        else min(25, max(0, len(formatted) // 10)),
        "logging_steps": 1,
        "save_steps": min(500, max_steps) if max_steps > 0 else 50,
        "save_total_limit": 3,
        "report_to": "none",
        "remove_unused_columns": False,
        "dataloader_pin_memory": device == "cuda",
        "max_steps": max_steps if max_steps > 0 else -1,
        "seed": seed,
    }
    if optimizer_name != "apollo":
        training_kwargs["optim"] = "adamw_torch" if device == "cpu" else "adamw_torch_fused"
    signature = inspect.signature(TrainingArguments.__init__)
    if "use_cpu" in signature.parameters:
        training_kwargs["use_cpu"] = device != "cuda"
    elif "no_cuda" in signature.parameters:
        training_kwargs["no_cuda"] = device != "cuda"
    if "data_seed" in signature.parameters:
        training_kwargs["data_seed"] = seed
    if device == "cuda":
        if use_bf16 and "bf16" in signature.parameters:
            training_kwargs["bf16"] = True
        else:
            training_kwargs["fp16"] = True
    if device == "cuda":
        enable_gradient_checkpointing(training_kwargs, signature)

    training_args = TrainingArguments(**training_kwargs)

    trainer_kwargs: dict[str, Any] = {}
    if optimizer_name == "apollo":
        trainer_kwargs["optimizers"] = (
            create_apollo_optimizer(
                model,
                lr=learning_rate,
                apollo_rank=apollo_rank,
                apollo_scale=apollo_scale,
                apollo_update_proj_gap=apollo_update_proj_gap,
            ),
            None,
        )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized,
        eval_dataset=tokenized_eval,
        data_collator=default_data_collator,
        **trainer_kwargs,
    )

    train_result = trainer.train()
    eval_result = (
        trainer.evaluate(eval_dataset=tokenized_eval) if tokenized_eval is not None else {}
    )
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)

    metrics = dict(train_result.metrics)
    metrics.update({f"eval_{k}": v for k, v in eval_result.items()})
    metrics.update(
        {
            "device": device,
            "formatted_samples": len(formatted),
            "formatted_eval_samples": len(valid_formatted),
            "max_seq_length": max_seq_length,
            "seed": seed,
            "optimizer": optimizer_name,
            "quantization": quantization,
            "lora_enabled": use_lora,
            "lora_rank": lora_rank if use_lora else None,
        }
    )
    if capacity_plan is not None:
        capacity_report_path = os.path.join(output_dir, "training_capacity_report.json")
        with open(capacity_report_path, "w", encoding="utf-8") as handle:
            json.dump(capacity_plan["report"], handle, indent=2)
        metrics["capacity_report_path"] = capacity_report_path
        metrics["estimated_training_memory_gib"] = capacity_plan["estimate"]["total_gib"]
    with open(os.path.join(output_dir, "training_metrics.json"), "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, indent=2)

    return output_dir


def train_cpu(
    samples: list[dict],
    model_name: str,
    output_dir: str,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    max_steps: int,
    max_seq_length: int,
    gradient_accumulation_steps: int,
    seed: int,
    validation_split_ratio: float,
    eval_samples: list[dict] | None = None,
    optimizer_name: str = "adamw",
) -> str:
    """Train using CPU (slow fallback)."""
    logger.warning("=" * 60 + "\nCPU TRAINING (VERY SLOW)\n" + "=" * 60)
    return train_cuda(
        samples,
        model_name,
        output_dir,
        epochs,
        batch_size,
        learning_rate,
        use_lora=False,
        quantization="none",
        lora_rank=16,
        lora_alpha=32,
        lora_dropout=0.1,
        lora_target_modules=None,
        optimizer_name=optimizer_name,
        max_steps=max_steps,
        max_seq_length=max_seq_length,
        gradient_accumulation_steps=gradient_accumulation_steps,
        seed=seed,
        validation_split_ratio=validation_split_ratio,
        eval_samples=eval_samples,
        force_cpu=True,
    )


# =============================================================================
# Validation
# =============================================================================


def _validation_report_path(model_path: str) -> Path:
    path = Path(model_path)
    if path.is_dir() and path.name == "adapters":
        return path.parent / "validation_report.json"
    if path.is_dir():
        return path / "validation_report.json"
    return path.parent / "validation_report.json"


def validate_trained_model(
    model_path: str, backend: Literal["mlx", "cuda", "cpu"], base_model: str | None = None
) -> bool:
    """Validate the trained model with trading-format and natural-message scam-defense prompts."""
    logger.info("=" * 60 + "\nVALIDATING TRAINED MODEL\n" + "=" * 60)
    prompts = list(ACTION_REASON_PROMPTS)
    responses: list[dict[str, Any]] = []

    decision_prompts = list(DECISION_VALIDATION_PROMPTS)
    natural_message_responses: list[dict[str, Any]] = []
    decision_responses: list[dict[str, Any]] = []

    try:
        generator = LocalTextGenerator(
            backend=backend,
            model_ref=base_model if backend == "mlx" else model_path,
            adapter_path=model_path if backend == "mlx" else None,
        )
        try:
            # Run Action/Reason trading prompts
            for prompt in prompts:
                response = generator.generate_messages(
                    [
                        {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
                        {"role": "user", "content": prompt["prompt"]},
                    ],
                    max_new_tokens=72,
                    assistant_prefix=ACTION_REASON_ASSISTANT_PREFIX,
                )
                responses.append(
                    {
                        "prompt_id": prompt["id"],
                        "prompt": prompt["prompt"],
                        "slice": prompt.get("slice"),
                        "response": response,
                        "latency_ms": 0.0,
                    }
                )

            # Run natural next-message scam-defense prompts
            for prompt in decision_prompts:
                response = generator.generate_messages(
                    [
                        {"role": "system", "content": NATURAL_MESSAGE_SYSTEM_PROMPT},
                        {"role": "user", "content": prompt["prompt"]},
                    ],
                    max_new_tokens=120,
                )
                natural_message_responses.append(
                    {
                        "prompt_id": prompt["id"],
                        "category": prompt.get("category"),
                        "expected_safe": prompt.get("expected_safe"),
                        "prompt": prompt["prompt"],
                        "response": response,
                        "latency_ms": 0.0,
                    }
                )

            # Run optional JSON-format recovery prompts
            for prompt in decision_prompts:
                response = generator.generate_messages(
                    [
                        {"role": "system", "content": DECISION_FORMAT_SYSTEM_PROMPT},
                        {"role": "user", "content": prompt["prompt"]},
                    ],
                    max_new_tokens=220,
                )
                decision_responses.append(
                    {
                        "prompt_id": prompt["id"],
                        "category": prompt.get("category"),
                        "expected_safe": prompt.get("expected_safe"),
                        "prompt": prompt["prompt"],
                        "response": response,
                        "latency_ms": 0.0,
                    }
                )
        finally:
            generator.close()

        # Score Action/Reason responses
        prompt_specs = {prompt["id"]: prompt for prompt in prompts}
        for response in responses:
            response["score"] = score_action_reason_response(
                response["response"],
                prompt_spec=prompt_specs.get(response["prompt_id"]),
            )
        ar_summary = summarize_action_reason_results(responses)
        ar_passed = passes_action_reason_gate(ar_summary)

        # Score natural-message scam-defense responses
        decision_specs = {p["id"]: p for p in decision_prompts}
        for nr in natural_message_responses:
            nr["score"] = score_decision_response(
                nr["response"],
                prompt_spec=decision_specs.get(nr["prompt_id"]),
            )
        natural_summary = summarize_decision_results(natural_message_responses)
        natural_passed = passes_natural_message_gate(natural_summary)

        # Score JSON-format recovery responses
        for dr in decision_responses:
            dr["score"] = score_decision_response(
                dr["response"],
                prompt_spec=decision_specs.get(dr["prompt_id"]),
            )
        dec_summary = summarize_decision_results(decision_responses)
        dec_passed = passes_json_format_gate(dec_summary)

        # Primary deterministic gate: trading-format OR natural-message behavior
        passed = passes_combined_gate(ar_summary, natural_summary)

        report = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "backend": backend,
            "model_path": model_path,
            "base_model": base_model,
            "validation_schema_version": 2,
            "primary_gate": {
                "passed": passed,
                "components": {
                    "action_reason": ar_passed,
                    "natural_message": natural_passed,
                },
            },
            "action_reason": {
                "system_prompt": ACTION_REASON_SYSTEM_PROMPT,
                "summary": ar_summary,
                "passed": ar_passed,
                "results": responses,
            },
            "natural_message": {
                "system_prompt": NATURAL_MESSAGE_SYSTEM_PROMPT,
                "summary": natural_summary,
                "passed": natural_passed,
                "results": natural_message_responses,
            },
            "decision_format": {
                "system_prompt": DECISION_FORMAT_SYSTEM_PROMPT,
                "summary": dec_summary,
                "passed": dec_passed,
                "results": decision_responses,
            },
            "json_format_aux": {
                "system_prompt": DECISION_FORMAT_SYSTEM_PROMPT,
                "summary": dec_summary,
                "passed": dec_passed,
                "results": decision_responses,
            },
            "combined_passed": passed,
            "passed": passed,
        }
        report_path = _validation_report_path(model_path)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

        logger.info("Action/Reason validation: %s", json.dumps(ar_summary))
        logger.info("Natural-message validation: %s", json.dumps(natural_summary))
        logger.info("JSON-format auxiliary validation: %s", json.dumps(dec_summary))
        if responses:
            sample = responses[0]["response"][:500]
            logger.info("Trading sample:\n%s\n%s\n%s", "-" * 40, sample, "-" * 40)
        if natural_message_responses:
            sample = natural_message_responses[0]["response"][:500]
            logger.info("Natural-message sample:\n%s\n%s\n%s", "-" * 40, sample, "-" * 40)
        if decision_responses:
            sample = decision_responses[0]["response"][:500]
            logger.info("JSON-format sample:\n%s\n%s\n%s", "-" * 40, sample, "-" * 40)

        if not passed:
            gates_info = []
            if not ar_passed:
                gates_info.append("Action/Reason")
            if not natural_passed:
                gates_info.append("Natural-message")
            logger.error(
                "Primary validation failed: %s gate(s) did not pass. Auxiliary JSON gate=%s. See %s",
                " and ".join(gates_info),
                dec_passed,
                report_path,
            )
            return False

        logger.info(
            "Model validation passed! (AR: %s, Natural: %s, JSON aux: %s)",
            ar_passed,
            natural_passed,
            dec_passed,
        )
        return True

    except Exception as e:
        logger.error(f"Model validation failed: {e}", exc_info=True)
        return False


# =============================================================================
# Main
# =============================================================================


async def main_async(args):
    """Main async training function."""
    backend = args.backend or detect_backend()
    model_name = args.model or default_local_model_for_backend(backend)
    logger.info(f"Using backend: {backend}, Model: {model_name}")
    if args.optimizer == "apollo" and args.lora:
        logger.info("APOLLO selected; disabling LoRA for full-parameter fine-tuning.")
        args.lora = False
    if args.optimizer == "apollo" and backend != "cuda":
        logger.error("APOLLO is only supported on the CUDA backend.")
        return 1
    if args.quantization != "none" and backend != "cuda":
        logger.error("NF4 quantized training is only supported on the CUDA backend.")
        return 1
    if args.quantization == "nf4" and not args.lora:
        logger.error("NF4 quantized training requires --lora.")
        return 1
    if args.quantization != "none" and args.optimizer == "apollo":
        logger.error("APOLLO does not support 4-bit quantized training.")
        return 1
    os.makedirs(args.output, exist_ok=True)
    seed_training_runtime(args.seed)

    try:
        # Main logic to select data source based on CLI arguments
        if args.source_dir:
            trajectories = load_json_training_data(
                args.source_dir,
                args.max_trajectories,
                min_actions=args.min_actions,
            )
        else:
            database_url = args.database_url or os.getenv("DATABASE_URL")
            if not database_url:
                logger.error("DATABASE_URL not set and --source-dir not provided. Exiting.")
                return 1
            trajectories = await load_postgres_training_data(
                database_url, args.min_actions, args.lookback_hours, args.max_trajectories
            )
    except (ValueError, FileNotFoundError) as e:
        logger.error(f"Failed to load data: {e}")
        return 1

    # Auto-detect held-out/ subdirectory for eval
    eval_source_dir = args.eval_source_dir
    if eval_source_dir is None and args.auto_detect_held_out and args.source_dir:
        held_out_candidate = Path(args.source_dir) / "held-out"
        if held_out_candidate.is_dir() and (held_out_candidate / "trajectories.jsonl").exists():
            eval_source_dir = str(held_out_candidate)
            logger.info(f"Auto-detected held-out eval directory: {eval_source_dir}")

    eval_trajectories: list[BabylonTrajectory] | None = None
    try:
        if eval_source_dir:
            eval_trajectories = load_json_training_data(
                eval_source_dir,
                args.eval_max_trajectories,
                min_actions=args.eval_min_actions,
            )
        elif args.eval_database_url:
            eval_database_url = args.eval_database_url or os.getenv("EVAL_DATABASE_URL")
            if eval_database_url:
                eval_trajectories = await load_postgres_training_data(
                    eval_database_url,
                    args.eval_min_actions,
                    args.eval_lookback_hours,
                    args.eval_max_trajectories,
                )
    except (ValueError, FileNotFoundError) as e:
        logger.error(f"Failed to load eval data: {e}")
        return 1

    # Load format recovery trajectories for multi-task mixing
    format_recovery_trajectories: list[BabylonTrajectory] | None = None
    if args.format_recovery_dir:
        try:
            format_recovery_trajectories = load_json_training_data(
                args.format_recovery_dir,
                args.max_trajectories,
                min_actions=1,
            )
            logger.info(
                f"Loaded {len(format_recovery_trajectories)} format recovery trajectories "
                f"from {args.format_recovery_dir}"
            )
        except (ValueError, FileNotFoundError) as exc:
            logger.warning(f"Could not load format recovery data: {exc}")

    all_training_samples = trajectories_to_training_samples(
        trajectories,
        sample_profile=args.sample_profile,
    )
    eval_samples = (
        trajectories_to_training_samples(
            eval_trajectories,
            sample_profile=args.sample_profile,
        )
        if eval_trajectories is not None
        else None
    )
    raw_training_samples = list(all_training_samples)
    if eval_samples is None:
        samples, eval_samples = split_samples_by_group(
            all_training_samples,
            seed=args.seed,
            validation_ratio=args.eval_split_ratio,
        )
    else:
        samples = list(all_training_samples)

    # Mix format recovery samples AFTER the eval split so they only go into training
    if format_recovery_trajectories and args.format_recovery_ratio > 0.0:
        recovery_samples = trajectories_to_training_samples(
            format_recovery_trajectories,
            sample_profile=args.sample_profile,
        )
        target_recovery = max(1, int(len(samples) * args.format_recovery_ratio))
        if len(recovery_samples) > target_recovery:
            rng = random.Random(args.seed)
            rng.shuffle(recovery_samples)
            recovery_samples = recovery_samples[:target_recovery]
        samples.extend(recovery_samples)
        logger.info(
            f"Mixed {len(recovery_samples)} format recovery samples into training "
            f"({args.format_recovery_ratio:.0%} ratio, eval split uncontaminated)"
        )
    builtin_recovery_samples: list[dict[str, Any]] = []
    if args.sample_profile in {"trade-canonical", "decision-canonical", "canonical"}:
        builtin_recovery_samples = build_decision_format_curriculum_samples()
        if args.sample_profile == "canonical":
            builtin_recovery_samples.extend(build_natural_message_curriculum_samples())
        samples.extend(builtin_recovery_samples)
        logger.info(
            "Mixed %s built-in decision curriculum samples into training",
            len(builtin_recovery_samples),
        )
    if args.sample_profile == "trade-canonical" and args.max_samples > 0:
        samples = curate_trade_training_samples(samples, max_samples=args.max_samples)
    elif args.max_samples > 0:
        samples = limit_training_samples_by_score(samples, args.max_samples)

    if len(samples) < 10:
        logger.error(f"Not enough valid training samples found: {len(samples)}")
        return 1

    model_path, base_model = "", None
    try:
        if backend == "mlx":
            model_path, base_model = (
                train_mlx(
                    samples,
                    model_name,
                    args.output,
                    args.iters,
                    args.batch_size,
                    args.lr,
                    args.max_seq_length,
                    args.mlx_num_layers,
                    args.mlx_save_every,
                    args.seed,
                    args.eval_split_ratio,
                    eval_samples,
                ),
                model_name,
            )
        elif backend == "cuda":
            model_path = train_cuda(
                samples=samples,
                model_name=model_name,
                output_dir=args.output,
                epochs=args.epochs,
                batch_size=args.batch_size,
                learning_rate=args.lr,
                use_lora=args.lora,
                quantization=args.quantization,
                lora_rank=args.lora_rank,
                lora_alpha=args.lora_alpha,
                lora_dropout=args.lora_dropout,
                lora_target_modules=args.lora_target_modules,
                max_steps=args.max_steps,
                max_seq_length=args.max_seq_length,
                gradient_accumulation_steps=args.gradient_accumulation_steps,
                seed=args.seed,
                validation_split_ratio=args.eval_split_ratio,
                eval_samples=eval_samples,
                optimizer_name=args.optimizer,
                apollo_rank=args.apollo_rank,
                apollo_scale=args.apollo_scale,
                apollo_update_proj_gap=args.apollo_update_proj_gap,
            )
        else:  # cpu
            model_path = train_cpu(
                samples=samples,
                model_name=model_name,
                output_dir=args.output,
                epochs=args.epochs,
                batch_size=args.batch_size,
                learning_rate=args.lr,
                max_steps=args.max_steps,
                max_seq_length=args.max_seq_length,
                gradient_accumulation_steps=args.gradient_accumulation_steps,
                seed=args.seed,
                validation_split_ratio=args.eval_split_ratio,
                eval_samples=eval_samples,
                optimizer_name=args.optimizer,
            )
    except Exception as e:
        logger.error(f"Training process failed: {e}", exc_info=True)
        return 1

    train_window_ids = {sample_group_key(sample) for sample in samples}
    eval_window_ids = (
        {sample_group_key(sample) for sample in eval_samples} if eval_samples else set()
    )
    effective_lora_enabled = backend == "mlx" or (
        backend == "cuda" and bool(getattr(args, "lora", False))
    )

    training_manifest = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "backend": backend,
        "model_name": model_name,
        "source_dir": args.source_dir,
        "eval_source_dir": eval_source_dir,
        "format_recovery_dir": args.format_recovery_dir,
        "format_recovery_ratio": args.format_recovery_ratio,
        "model_size_hint": args.model_size_hint,
        "effective_lr": args.lr,
        "optimizer": args.optimizer,
        "quantization": args.quantization,
        "apollo_rank": args.apollo_rank,
        "apollo_scale": args.apollo_scale,
        "apollo_update_proj_gap": args.apollo_update_proj_gap,
        "iters": args.iters,
        "batch_size": args.batch_size,
        "max_seq_length": args.max_seq_length,
        "max_samples": args.max_samples,
        "mlx_num_layers": args.mlx_num_layers,
        "lora_enabled": effective_lora_enabled,
        "lora_rank": (args.lora_rank if backend == "cuda" and effective_lora_enabled else None),
        "lora_alpha": (args.lora_alpha if backend == "cuda" and effective_lora_enabled else None),
        "lora_dropout": (
            args.lora_dropout if backend == "cuda" and effective_lora_enabled else None
        ),
        "lora_target_modules": (
            args.lora_target_modules if backend == "cuda" and effective_lora_enabled else None
        ),
        "trajectory_count": len(trajectories),
        "eval_trajectory_count": len(eval_trajectories or []),
        "raw_training_sample_count": len(raw_training_samples),
        "builtin_recovery_sample_count": len(builtin_recovery_samples),
        "training_sample_count": len(samples) + len(eval_samples or []),
        "train_sample_count": len(samples),
        "eval_sample_count": len(eval_samples or []),
        "sample_profile": args.sample_profile,
        "seed": args.seed,
        "validation_split_ratio": args.eval_split_ratio,
        "train_window_count": len(train_window_ids),
        "eval_window_count": len(eval_window_ids),
        "output_path": model_path,
        "capacity_report_path": (
            str(Path(model_path) / "training_capacity_report.json")
            if model_path and (Path(model_path) / "training_capacity_report.json").exists()
            else None
        ),
        "validate_requested": args.validate,
        "validation_passed": None,
        "validation_report_path": str(_validation_report_path(model_path)) if model_path else None,
    }
    manifest_path = os.path.join(args.output, "training_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(training_manifest, handle, indent=2)

    if args.validate and model_path:
        training_manifest["validation_passed"] = validate_trained_model(
            model_path,
            backend,
            base_model,
        )
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump(training_manifest, handle, indent=2)

    logger.info(
        "\n"
        + "=" * 60
        + "\nTRAINING COMPLETE\n"
        + f"  Model/adapter saved to: {model_path}\n"
        + "=" * 60
    )
    return 0


def main():
    # Prevent CUDA memory fragmentation (critical for long training runs)
    import os
    if "PYTORCH_CUDA_ALLOC_CONF" not in os.environ:
        os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

    parser = argparse.ArgumentParser(
        description="Babylon Local Training", formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        "--source-dir", help="Directory with local JSON trajectory files for offline training."
    )
    parser.add_argument(
        "--database-url", help="Database URL (used if --source-dir is not provided)."
    )
    parser.add_argument(
        "--backend",
        choices=["mlx", "cuda", "cpu"],
        help="Training backend (auto-detected if not specified)",
    )
    parser.add_argument("--model", help="Model to train (default depends on backend)")
    parser.add_argument(
        "--min-actions", type=int, default=3, help="Minimum actions per trajectory (DB source)"
    )
    parser.add_argument(
        "--lookback-hours",
        type=int,
        default=168,
        help="Hours to look back for trajectories (DB source)",
    )
    parser.add_argument(
        "--max-trajectories", type=int, default=500, help="Maximum trajectories to load"
    )
    parser.add_argument(
        "--output",
        "--output-dir",
        dest="output",
        default="./trained_models/local",
        help="Output directory",
    )
    parser.add_argument("--iters", type=int, default=100, help="Training iterations (MLX)")
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs (CUDA/CPU)")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=2,
        help="Batch size (Note: CUDA uses a fixed batch size of 1 for memory optimization)",
    )
    parser.add_argument(
        "--lr",
        type=float,
        default=None,
        help="Learning rate (default: 1e-5, or 5e-6 for large models)",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=-1,
        help="Maximum optimizer steps for transformers training (-1 uses epochs).",
    )
    parser.add_argument(
        "--max-seq-length",
        type=int,
        default=512,
        help="Maximum sequence length for tokenization.",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=0,
        help="Optional cap on formatted training samples (0 keeps all).",
    )
    parser.add_argument(
        "--sample-profile",
        choices=["raw", "trade-canonical", "decision-canonical", "canonical"],
        default="canonical",
        help="How to convert trajectories into supervised samples.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=1337,
        help="Explicit seed for data ordering, grouped split assignment, and trainer initialization.",
    )
    parser.add_argument(
        "--eval-source-dir",
        help="Optional separate local JSON trajectory directory for validation/eval.",
    )
    parser.add_argument(
        "--eval-database-url",
        help="Optional separate database URL for validation/eval (falls back to EVAL_DATABASE_URL).",
    )
    parser.add_argument(
        "--eval-lookback-hours",
        type=int,
        default=168,
        help="Hours to look back for eval trajectories (DB source).",
    )
    parser.add_argument(
        "--eval-max-trajectories",
        type=int,
        default=200,
        help="Maximum eval trajectories to load from a separate eval source.",
    )
    parser.add_argument(
        "--eval-min-actions",
        type=int,
        default=3,
        help="Minimum actions per eval trajectory (separate eval source).",
    )
    parser.add_argument(
        "--eval-split-ratio",
        type=float,
        default=0.1,
        help="Grouped validation split ratio when a separate eval source is not provided.",
    )
    parser.add_argument(
        "--gradient-accumulation-steps",
        type=int,
        default=4,
        help="Gradient accumulation steps for transformers training.",
    )
    parser.add_argument(
        "--mlx-num-layers",
        type=int,
        default=8,
        help="Number of transformer layers to fine-tune for MLX LoRA.",
    )
    parser.add_argument(
        "--mlx-save-every",
        type=int,
        default=10,
        help="Save MLX adapter checkpoints every N iterations (0 disables periodic saves).",
    )
    parser.add_argument(
        "--lora", action=argparse.BooleanOptionalAction, default=True, help="Use LoRA (CUDA only)"
    )
    parser.add_argument(
        "--optimizer",
        choices=["adamw", "apollo"],
        default="adamw",
        help="Optimizer for CUDA/CPU transformers training. APOLLO performs full-parameter CUDA fine-tuning.",
    )
    parser.add_argument(
        "--quantization",
        choices=["none", "nf4"],
        default="none",
        help="CUDA quantization mode. 'nf4' enables 4-bit QLoRA-style adapter training.",
    )
    parser.add_argument(
        "--apollo-rank",
        type=int,
        default=128,
        help="Low-rank projection rank for APOLLO full fine-tuning.",
    )
    parser.add_argument(
        "--apollo-scale",
        type=float,
        default=32.0,
        help="Projection scale for APOLLO full fine-tuning.",
    )
    parser.add_argument(
        "--apollo-update-proj-gap",
        type=int,
        default=200,
        help="Projection refresh interval for APOLLO full fine-tuning.",
    )
    parser.add_argument(
        "--lora-rank",
        type=int,
        default=16,
        help="LoRA adapter rank for CUDA adapter training.",
    )
    parser.add_argument(
        "--lora-alpha",
        type=int,
        default=32,
        help="LoRA scaling alpha for CUDA adapter training.",
    )
    parser.add_argument(
        "--lora-dropout",
        type=float,
        default=0.1,
        help="LoRA dropout for CUDA adapter training.",
    )
    parser.add_argument(
        "--lora-target-modules",
        default=None,
        help="Optional comma-separated LoRA target modules. Defaults to architecture-aware discovery.",
    )
    parser.add_argument(
        "--validate",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Validate trained model",
    )
    parser.add_argument(
        "--auto-detect-held-out",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Auto-detect held-out/ subdirectory under --source-dir for evaluation.",
    )
    parser.add_argument(
        "--format-recovery-dir",
        default=None,
        help="Optional directory with Action/Reason format recovery trajectories for multi-task mixing.",
    )
    parser.add_argument(
        "--format-recovery-ratio",
        type=float,
        default=0.0,
        help="Fraction of training batch to allocate to format recovery examples (0.0 to 1.0).",
    )
    parser.add_argument(
        "--model-size-hint",
        choices=["small", "medium", "large"],
        default=None,
        help="Hint for model-size-aware defaults. 'large' (>=9B) uses softer LR (5e-6) and fewer layers.",
    )

    args = parser.parse_args()
    if args.lora_target_modules:
        args.lora_target_modules = [
            item.strip() for item in args.lora_target_modules.split(",") if item.strip()
        ]
    else:
        args.lora_target_modules = None

    # Track which args the user explicitly set vs left as defaults
    _user_set_lr = args.lr is not None
    _user_set_layers = "--mlx-num-layers" in sys.argv
    _user_set_iters = "--iters" in sys.argv

    # Apply base defaults for unset args
    if args.lr is None:
        args.lr = 1e-5

    # Model-size-aware defaults for 9B+ models
    _apply_large = False
    if args.model_size_hint == "large":
        _apply_large = True
    elif args.model_size_hint is None and args.model:
        # Auto-detect from model name — only 9B+ triggers large defaults
        model_lower = (args.model or "").lower()
        if any(tag in model_lower for tag in ["9b", "14b", "27b", "30b", "35b", "70b", "122b"]):
            _apply_large = True
            logger.info("Auto-detected large model (9B+) from model name")

    if _apply_large:
        if not _user_set_lr:
            args.lr = 5e-6
            logger.info("Large model: using softer learning rate 5e-6")
        if not _user_set_layers and args.mlx_num_layers == 8:
            args.mlx_num_layers = 4
            logger.info("Large model: fine-tuning fewer layers (4)")
        if not _user_set_iters and args.iters == 100:
            args.iters = 60
            logger.info("Large model: using fewer iterations (60)")

    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
