#!/usr/bin/env python3
"""
Export Babylon Trajectories to HuggingFace Datasets

Converts trajectory data from PostgreSQL into HuggingFace-compatible datasets for
GRPO-style ranking, supervised fine-tuning, and public release.

Output formats:
1. Ranked trajectory groups - for GRPO/ranking-oriented reward training
2. Preference pairs (legacy, optional) - for DPO/RLHF
3. Single trajectory SFT - for supervised fine-tuning
4. Raw trajectories - full data for analysis

Usage:
    # Export to local parquet files
    python scripts/hf/trajectories_to_hf_dataset.py --output ./hf_dataset

    # Export and push to HuggingFace Hub
    python scripts/hf/trajectories_to_hf_dataset.py --push-to-hub babylonlabs/babylon-trading-v1

    # Export ranked groups for GRPO-style training
    python scripts/hf/trajectories_to_hf_dataset.py --format rankings --output ./rankings

    # Limit export size
    python scripts/hf/trajectories_to_hf_dataset.py --max-pairs 10000 --format preferences --output ./subset

Environment:
    DATABASE_URL: PostgreSQL connection string
    HF_TOKEN: HuggingFace API token (for --push-to-hub)
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

PYTHON_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PYTHON_PACKAGE_ROOT))
from src.data_bridge.reader import JsonTrajectoryReader

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


@dataclass
class ExportConfig:
    """Configuration for HuggingFace export."""

    database_url: str = ""
    source_dir: str | None = None
    output_dir: str = "./hf_export"
    push_to_hub: str | None = None  # e.g., "babylonlabs/babylon-trading-v1"

    # Data selection
    lookback_hours: int = 720  # 30 days
    min_actions: int = 3
    max_trajectories: int = 50000
    max_pairs: int | None = None  # Limit legacy preference pairs

    # Format options
    format: str = "all"  # "rankings", "preferences", "sft", "raw", "all"
    include_metadata: bool = True

    # Filtering
    min_pnl_diff: float = 0.0  # Minimum PnL difference for legacy preference pairs
    archetypes: list[str] | None = None  # Filter by archetype

    def __post_init__(self):
        if not self.database_url:
            self.database_url = os.environ.get("DATABASE_URL", "")


@dataclass
class TrajectoryData:
    """Parsed trajectory data."""

    trajectory_id: str
    agent_id: str
    agent_name: str
    window_id: str
    scenario_id: str | None
    archetype: str
    steps: list[dict[str, Any]]
    final_pnl: float
    final_balance: float | None
    episode_length: int
    total_reward: float
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime | None = None
    batch_id: str | None = None
    episode_id: str | None = None
    experiment_run_id: str | None = None
    model_size: str | None = None
    training_profile: str | None = None
    team: str | None = None
    alignment: str | None = None


@dataclass
class PreferencePair:
    """A preference pair for DPO/RLHF training."""

    prompt: str
    chosen: str
    rejected: str
    chosen_score: float
    rejected_score: float
    window_id: str
    scenario_id: str | None
    archetype_chosen: str
    archetype_rejected: str
    pnl_diff: float
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RankedTrajectoryGroup:
    """A ranked set of candidate trajectories for GRPO-style training."""

    group_id: str
    window_id: str
    scenario_id: str | None
    score_field: str
    tie_breaker_field: str
    candidates: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalize_group_token(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return "unknown"
    normalized = "".join(char if char.isalnum() else "-" for char in text)
    normalized = "-".join(part for part in normalized.split("-") if part)
    return normalized or "unknown"


def _extract_step_action(step: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    action = step.get("action", {})
    if not isinstance(action, dict):
        return "", {}
    action_type = str(
        action.get("type") or action.get("actionType") or action.get("action") or ""
    ).strip()
    parameters = action.get("parameters", {})
    if not isinstance(parameters, dict):
        parameters = {}
    return action_type, parameters


def infer_dominant_market(traj: TrajectoryData) -> str | None:
    counts: Counter[str] = Counter()
    for step in traj.steps:
        if not isinstance(step, dict):
            continue
        _, parameters = _extract_step_action(step)
        candidates = [
            parameters.get("marketId"),
            parameters.get("market"),
            parameters.get("questionId"),
            parameters.get("token"),
            parameters.get("asset"),
            parameters.get("ticker"),
            parameters.get("symbol"),
        ]
        observation = step.get("observation", {})
        if isinstance(observation, dict):
            market = observation.get("market", {})
            if isinstance(market, dict):
                candidates.extend(
                    [
                        market.get("marketId"),
                        market.get("id"),
                        market.get("symbol"),
                        market.get("ticker"),
                        market.get("question"),
                    ]
                )

        for candidate in candidates:
            normalized = str(candidate or "").strip()
            if normalized:
                counts[normalized] += 1
                break

    return counts.most_common(1)[0][0] if counts else None


def infer_dominant_action_type(traj: TrajectoryData) -> str | None:
    counts: Counter[str] = Counter()
    for step in traj.steps:
        if not isinstance(step, dict):
            continue
        action_type, _ = _extract_step_action(step)
        normalized = action_type.strip().lower()
        if normalized:
            counts[normalized] += 1
    return counts.most_common(1)[0][0] if counts else None


def infer_ranking_context(traj: TrajectoryData) -> tuple[str, str]:
    dominant_market = infer_dominant_market(traj)
    if dominant_market:
        return "dominant_market", dominant_market

    dominant_action_type = infer_dominant_action_type(traj)
    if dominant_action_type:
        return "dominant_action_type", dominant_action_type

    return "window_scope", traj.window_id


def infer_batch_scope(traj: TrajectoryData) -> str:
    return str(
        traj.batch_id
        or traj.experiment_run_id
        or traj.metadata.get("batchId")
        or traj.metadata.get("experimentRunId")
        or "unknown_batch"
    )


def infer_round_scope(traj: TrajectoryData) -> str:
    round_number = traj.metadata.get("roundNumber") if isinstance(traj.metadata, dict) else None
    if round_number is None:
        return "round_unknown"
    return f"round_{round_number}"


def format_step_as_message(step: dict[str, Any]) -> tuple[str, str]:
    """
    Format a trajectory step as system/user context and assistant response.

    Returns:
        (context_text, response_text)
    """
    observation = step.get("observation", {})
    action = step.get("action", {})

    # Build context from observation
    context_parts = []

    # Market state
    market = observation.get("market", {})
    if market:
        context_parts.append("**Market State:**")
        context_parts.append(f"- Price: ${market.get('price', 'N/A')}")
        context_parts.append(f"- 24h Change: {market.get('priceChange24h', 'N/A')}%")
        context_parts.append(f"- Volume: ${market.get('volume24h', 'N/A')}")

    # Portfolio state
    portfolio = observation.get("portfolio", {})
    if portfolio:
        context_parts.append("\n**Your Portfolio:**")
        context_parts.append(f"- Balance: ${portfolio.get('balance', 'N/A')}")
        context_parts.append(f"- Holdings: {portfolio.get('holdings', {})}")
        context_parts.append(f"- Total Value: ${portfolio.get('totalValue', 'N/A')}")

    # Social context
    recent_posts = observation.get("recentPosts", [])
    if recent_posts:
        context_parts.append(f"\n**Recent Social Activity:** {len(recent_posts)} posts")

    # Task/Scenario
    task = observation.get("task", observation.get("scenario", ""))
    if task:
        context_parts.append(f"\n**Current Task:** {task}")

    context = "\n".join(context_parts) if context_parts else "Market observation available."

    # Build response from action
    action_type = action.get("type", action.get("action", "unknown"))
    parameters = action.get("parameters", {})
    reasoning = action.get("reasoning", parameters.get("reasoning", ""))

    response_parts = []
    if reasoning:
        response_parts.append(f"**Reasoning:** {reasoning}")

    response_parts.append(f"\n**Action:** {action_type}")

    # Action-specific details
    if action_type in ["BUY", "SELL", "buy", "sell"]:
        amount = parameters.get("amount", parameters.get("quantity", "N/A"))
        asset = parameters.get("asset", parameters.get("token", "N/A"))
        response_parts.append(f"- Asset: {asset}")
        response_parts.append(f"- Amount: {amount}")
    elif action_type in ["POST", "post"]:
        content = parameters.get("content") or parameters.get("message") or ""
        content = str(content)
        if len(content) > 200:
            response_parts.append(f"- Content: {content[:200]}...")
        else:
            response_parts.append(f"- Content: {content}")
    elif action_type in ["HOLD", "hold", "WAIT", "wait"]:
        response_parts.append("- Waiting for better opportunity")

    response = "\n".join(response_parts)

    return context, response


def _select_primary_llm_call(step: dict[str, Any]) -> dict[str, Any] | None:
    llm_calls = step.get("llmCalls") or step.get("llm_calls") or []
    if not isinstance(llm_calls, list):
        return None
    for llm_call in llm_calls:
        if isinstance(llm_call, dict) and llm_call.get("purpose") == "action":
            return llm_call
    for llm_call in llm_calls:
        if isinstance(llm_call, dict):
            return llm_call
    return None


def _normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return "\n".join(line.rstrip() for line in value.strip().splitlines()).strip()


def _extract_action_type_from_step(step: dict[str, Any]) -> str:
    action = _as_dict(step.get("action"))
    return str(
        action.get("actionType")
        or action.get("action_type")
        or action.get("type")
        or action.get("action")
        or ""
    ).strip()


def _extract_action_parameters(step: dict[str, Any]) -> dict[str, Any]:
    action = _as_dict(step.get("action"))
    return _as_dict(action.get("parameters"))


def _extract_action_result(step: dict[str, Any]) -> dict[str, Any]:
    action = _as_dict(step.get("action"))
    return _as_dict(action.get("result"))


def _extract_step_target(step: dict[str, Any]) -> str:
    params = _extract_action_parameters(step)
    result = _extract_action_result(step)

    for candidate in (
        params.get("marketId"),
        result.get("marketId"),
        params.get("ticker"),
        result.get("ticker"),
        params.get("symbol"),
        params.get("asset"),
        params.get("token"),
        params.get("postId"),
        params.get("commentId"),
        params.get("targetPostId"),
        params.get("targetCommentId"),
        params.get("targetUserId"),
        params.get("userId"),
        params.get("groupId"),
        params.get("chatId"),
    ):
        normalized = str(candidate or "").strip()
        if normalized:
            return normalized

    return "global"


def _extract_reasoning_text(step: dict[str, Any], llm_call: dict[str, Any] | None) -> str:
    action = _as_dict(step.get("action"))
    params = _extract_action_parameters(step)
    for candidate in (
        action.get("reasoning"),
        params.get("reasoning"),
        llm_call.get("reasoning") if llm_call else None,
    ):
        normalized = " ".join(str(candidate or "").split()).strip()
        if normalized:
            return normalized
    return "Use the available market and social context to choose the next action."


def _build_canonical_completion(step: dict[str, Any], llm_call: dict[str, Any] | None) -> str:
    action_type = _extract_action_type_from_step(step).upper() or "ACT"
    params = _extract_action_parameters(step)
    result = _extract_action_result(step)
    reasoning = _extract_reasoning_text(step, llm_call)

    market_id = str(params.get("marketId") or result.get("marketId") or "").strip()
    ticker = str(
        params.get("ticker")
        or result.get("ticker")
        or params.get("symbol")
        or params.get("asset")
        or ""
    ).strip()
    side = str(params.get("side") or params.get("outcome") or "").strip()
    amount = (
        params.get("amount")
        or params.get("quantity")
        or params.get("size")
        or params.get("notional")
    )
    content = _normalize_text(
        params.get("content") or params.get("message") or params.get("text") or ""
    )

    action_line: str
    if action_type == "TRADE":
        if market_id:
            amount_text = f" ${amount}" if amount is not None else ""
            side_text = f" via {side}" if side else ""
            action_line = f"Action: trade{amount_text} on prediction market {market_id}{side_text}."
        elif ticker:
            amount_text = f" ${amount}" if amount is not None else ""
            side_text = f" {side}" if side else ""
            action_line = f"Action: trade{amount_text}{side_text} on {ticker}."
        else:
            action_line = "Action: place the next trade in the active market."
    elif action_type in {"BUY", "SELL", "SHORT", "HOLD", "CLOSE"}:
        target = market_id or ticker or "the active market"
        amount_text = f" ${amount}" if amount is not None else ""
        action_line = f"Action: {action_type.lower()}{amount_text} on {target}."
    elif action_type in {"COMMENT", "REPLY_COMMENT", "REPLY"}:
        target = (
            str(
                params.get("commentId") or params.get("postId") or params.get("targetPostId") or ""
            ).strip()
            or "the thread"
        )
        body = content or "reply with a concise follow-up"
        action_line = f"Action: comment on {target} — {body}"
    elif action_type == "POST":
        body = content or "publish a public update"
        action_line = f"Action: post — {body}"
    elif action_type in {"FOLLOW", "LIKE", "REPOST"}:
        target = (
            str(
                params.get("targetUserId")
                or params.get("postId")
                or params.get("targetPostId")
                or ""
            ).strip()
            or "the target account"
        )
        action_line = f"Action: {action_type.lower()} {target}."
    elif action_type in {"SEND_MESSAGE", "GROUP_MESSAGE"}:
        target = (
            str(
                params.get("targetUserId") or params.get("groupId") or params.get("chatId") or ""
            ).strip()
            or "the counterparty"
        )
        body = content or "send a concise message"
        action_line = f"Action: {action_type.lower().replace('_', ' ')} to {target} — {body}"
    else:
        descriptor = action_type.lower().replace("_", " ")
        if content:
            action_line = f"Action: {descriptor} — {content}"
        else:
            action_line = f"Action: {descriptor}."

    return "\n".join([action_line.strip(), f"Reason: {reasoning}"])


def _build_decision_messages(
    llm_call: dict[str, Any], completion: str
) -> list[dict[str, str]] | None:
    system_prompt = _normalize_text(
        llm_call.get("systemPrompt") or llm_call.get("system_prompt") or ""
    )
    user_prompt = _normalize_text(llm_call.get("userPrompt") or llm_call.get("user_prompt") or "")
    if len(system_prompt) < 20 or len(user_prompt) < 20:
        return None
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
        {"role": "assistant", "content": completion},
    ]


def build_decision_examples(traj: TrajectoryData) -> list[dict[str, Any]]:
    examples: list[dict[str, Any]] = []

    for step in traj.steps:
        if not isinstance(step, dict):
            continue
        llm_call = _select_primary_llm_call(step)
        if not llm_call:
            continue

        completion = _build_canonical_completion(step, llm_call)
        messages = _build_decision_messages(llm_call, completion)
        if not messages:
            continue

        prompt, assistant_completion = conversation_to_text(messages)
        if not prompt or not assistant_completion:
            continue

        step_number = int(step.get("stepNumber") or 0)
        step_reward = float(step.get("reward") or 0.0)
        action_type = _extract_action_type_from_step(step).upper() or "ACT"
        target = _extract_step_target(step)
        group_key = "__".join(
            [
                f"{traj.window_id}_{traj.scenario_id or 'default'}",
                f"step_{step_number}",
                f"action_{_normalize_group_token(action_type)}",
                f"target_{_normalize_group_token(target)}",
            ]
        )

        # Extract counterparty context from step (if available)
        cp_ctx = step.get("counterpartyContext") or {}
        counterparty_data = {}
        if isinstance(cp_ctx, dict) and cp_ctx:
            counterparty_data = {
                "counterparty_alignment": cp_ctx.get("counterpartyAlignment"),
                "counterparty_team": cp_ctx.get("counterpartyTeam"),
                "sender_role": cp_ctx.get("senderRole"),
                "interaction_intent": cp_ctx.get("interactionIntent"),
                "is_verified_admin": cp_ctx.get("isVerifiedAdmin", False),
            }

        examples.append(
            {
                "group_key": group_key,
                "window_id": traj.window_id,
                "scenario_id": traj.scenario_id,
                "step_number": step_number,
                "trajectory_id": traj.trajectory_id,
                "agent_id": traj.agent_id,
                "agent_name": traj.agent_name,
                "archetype": traj.archetype,
                "prompt": prompt,
                "completion": assistant_completion,
                "messages": messages,
                "ranking_score": step_reward,
                "tie_breaker_score": traj.total_reward,
                "trajectory_final_pnl": traj.final_pnl,
                "trajectory_total_reward": traj.total_reward,
                "episode_length": traj.episode_length,
                "action_type": action_type,
                "target_key": target,
                "created_at": traj.created_at.isoformat() if traj.created_at else None,
                # Agent alignment labels (for offline RL reward relabeling)
                "agent_team": traj.team,
                "agent_alignment": traj.alignment,
                # Counterparty context (for intent-aware reward computation)
                **counterparty_data,
                "metadata": {
                    **(traj.metadata if isinstance(traj.metadata, dict) else {}),
                    "group_kind": "decision_step",
                    "round_scope": infer_round_scope(traj),
                    "model_size": traj.model_size,
                    "training_profile": traj.training_profile,
                    "team": traj.team,
                    "alignment": traj.alignment,
                },
            }
        )

    return examples


def trajectory_to_conversation(traj: TrajectoryData, max_steps: int = 10) -> list[dict[str, str]]:
    """
    Convert a trajectory to a multi-turn conversation format.

    Returns list of messages suitable for chat template.
    """
    messages = []

    # System prompt based on archetype
    archetype_prompts = {
        "trader": "You are a crypto trader focused on maximizing returns through strategic trades.",
        "hodler": "You are a long-term crypto investor who prefers holding through volatility.",
        "analyst": "You are a crypto analyst who makes decisions based on technical and fundamental analysis.",
        "degen": "You are an aggressive crypto trader willing to take high-risk positions for potential high rewards.",
        "conservative": "You are a conservative crypto investor focused on capital preservation.",
        "default": "You are an AI trading agent in a crypto simulation.",
    }

    system_prompt = archetype_prompts.get(traj.archetype.lower(), archetype_prompts["default"])
    system_prompt += (
        "\n\nYour goal is to make profitable trading decisions based on market conditions."
    )

    # Add alignment context if available (for intent-aware training)
    if traj.team:
        team_context = {
            "red": " Be skeptical of all requests and protect your assets.",
            "blue": " Be skeptical of all requests and protect your assets.",
            "gray": "",
        }
        system_prompt += team_context.get(traj.team, "")

    messages.append({"role": "system", "content": system_prompt})

    # Convert steps to conversation turns
    steps_to_use = traj.steps[:max_steps] if len(traj.steps) > max_steps else traj.steps

    for i, step in enumerate(steps_to_use):
        context, response = format_step_as_message(step)

        # User turn (observation/context)
        messages.append(
            {
                "role": "user",
                "content": f"Step {i + 1}/{len(steps_to_use)}:\n\n{context}\n\nWhat action do you take?",
            }
        )

        # Assistant turn (action)
        messages.append({"role": "assistant", "content": response})

    return messages


def conversation_to_text(messages: list[dict[str, str]]) -> tuple[str, str]:
    """
    Convert messages to prompt and completion text.

    Returns:
        (prompt, completion) where completion is the last assistant message
    """
    if not messages:
        return "", ""

    # Find last assistant message
    last_assistant_idx = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant":
            last_assistant_idx = i
            break

    if last_assistant_idx is None:
        # No assistant message
        prompt = "\n\n".join([f"[{m['role']}]: {m['content']}" for m in messages])
        return prompt, ""

    # Build prompt from all messages before last assistant
    prompt_parts = []
    for m in messages[:last_assistant_idx]:
        role_prefix = {"system": "[System]", "user": "[User]", "assistant": "[Assistant]"}.get(
            m["role"], f"[{m['role']}]"
        )
        prompt_parts.append(f"{role_prefix}: {m['content']}")

    prompt = "\n\n".join(prompt_parts)
    if last_assistant_idx > 0 and messages[last_assistant_idx - 1]["role"] == "user":
        prompt += "\n\n[Assistant]:"

    completion = messages[last_assistant_idx]["content"]

    return prompt, completion


async def fetch_trajectories(config: ExportConfig) -> list[TrajectoryData]:
    """Fetch trajectories from PostgreSQL or a local Babylon export."""
    if config.source_dir:
        return fetch_trajectories_from_local_export(config)

    return await fetch_trajectories_from_database(config)


async def fetch_trajectories_from_database(config: ExportConfig) -> list[TrajectoryData]:
    """Fetch trajectories from PostgreSQL database."""
    try:
        import asyncpg
    except ImportError:
        raise ImportError("asyncpg required: pip install asyncpg")

    logger.info("Connecting to database...")

    pool = await asyncpg.create_pool(
        config.database_url,
        min_size=2,
        max_size=10,
        command_timeout=120,
        statement_cache_size=0,  # For pooler compatibility
    )

    async with pool.acquire() as conn:
        logger.info(
            f"Fetching trajectories (lookback={config.lookback_hours}h, max={config.max_trajectories})..."
        )

        rows = await conn.fetch(
            """
            SELECT
                t."trajectoryId",
                t."agentId",
                t."windowId",
                t."scenarioId",
                t."stepsJson",
                t."metadataJson",
                t."finalPnL",
                t."finalBalance",
                t."episodeLength",
                t."totalReward",
                t."archetype",
                t."createdAt",
                u.username as agent_name
            FROM trajectories t
            LEFT JOIN "User" u ON t."agentId" = u.id
            WHERE
                t."createdAt" > NOW() - $1::interval
                AND t."stepsJson" IS NOT NULL
                AND t."stepsJson"::text != 'null'
                AND t."stepsJson"::text != '[]'
                AND t."episodeLength" >= $2
            ORDER BY t."createdAt" DESC
            LIMIT $3
        """,
            timedelta(hours=config.lookback_hours),
            config.min_actions,
            config.max_trajectories,
        )

    await pool.close()

    logger.info(f"Fetched {len(rows)} trajectories")

    trajectories = [
        trajectory
        for row in rows
        if (
            trajectory := parse_trajectory_payload(
                {
                    "trajectoryId": row["trajectoryId"],
                    "agentId": row["agentId"],
                    "agent_name": row["agent_name"],
                    "windowId": row["windowId"],
                    "scenarioId": row["scenarioId"],
                    "stepsJson": row["stepsJson"],
                    "metadataJson": row["metadataJson"],
                    "finalPnL": row["finalPnL"],
                    "finalBalance": row["finalBalance"],
                    "episodeLength": row["episodeLength"],
                    "totalReward": row["totalReward"],
                    "archetype": row["archetype"],
                    "createdAt": row["createdAt"],
                },
                config,
            )
        )
        is not None
    ]

    logger.info(f"Parsed {len(trajectories)} valid trajectories")
    return trajectories


def parse_json_field(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default
    return value


def parse_created_at(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def parse_trajectory_payload(
    payload: dict[str, Any],
    config: ExportConfig,
) -> TrajectoryData | None:
    steps = parse_json_field(payload.get("stepsJson", payload.get("steps", [])), [])
    if not isinstance(steps, list) or len(steps) < config.min_actions:
        return None

    archetype = str(payload.get("archetype") or "default")
    if config.archetypes and archetype.lower() not in [a.lower() for a in config.archetypes]:
        return None

    metadata = parse_json_field(
        payload.get("metadataJson", payload.get("metadata", {})),
        {},
    )
    if not isinstance(metadata, dict):
        metadata = {}

    batch_id = payload.get("batchId") or metadata.get("batchId")
    episode_id = payload.get("episodeId") or metadata.get("episodeId")
    experiment_run_id = metadata.get("experimentRunId") or batch_id

    agent_id = str(payload.get("agentId") or payload.get("agent_id") or "unknown")
    agent_name = (
        payload.get("agent_name")
        or payload.get("agentName")
        or payload.get("username")
        or agent_id[:8]
    )

    final_balance_raw = payload.get("finalBalance", payload.get("final_balance"))
    return TrajectoryData(
        trajectory_id=str(payload.get("trajectoryId") or payload.get("trajectory_id") or ""),
        agent_id=agent_id,
        agent_name=str(agent_name),
        window_id=str(payload.get("windowId") or payload.get("window_id") or "default_window"),
        scenario_id=payload.get("scenarioId") or payload.get("scenario_id"),
        archetype=archetype,
        steps=steps,
        final_pnl=float(payload.get("finalPnL") or payload.get("final_pnl") or 0),
        final_balance=float(final_balance_raw) if final_balance_raw is not None else None,
        episode_length=int(
            payload.get("episodeLength") or payload.get("episode_length") or len(steps)
        ),
        total_reward=float(payload.get("totalReward") or payload.get("total_reward") or 0),
        metadata=metadata,
        created_at=parse_created_at(payload.get("createdAt") or payload.get("created_at")),
        batch_id=str(batch_id) if batch_id else None,
        episode_id=str(episode_id) if episode_id else None,
        experiment_run_id=str(experiment_run_id) if experiment_run_id else None,
        model_size=str(metadata.get("modelSize")) if metadata.get("modelSize") else None,
        training_profile=str(metadata.get("trainingProfile"))
        if metadata.get("trainingProfile")
        else None,
        team=str(metadata.get("team")) if metadata.get("team") else None,
        alignment=str(metadata.get("alignment")) if metadata.get("alignment") else None,
    )


def fetch_trajectories_from_local_export(config: ExportConfig) -> list[TrajectoryData]:
    source_dir = Path(config.source_dir or "").expanduser().resolve()
    if not source_dir.is_dir():
        raise FileNotFoundError(f"Local export directory not found: {source_dir}")

    logger.info(f"Loading trajectories from local export: {source_dir}")
    reader = JsonTrajectoryReader(str(source_dir))
    payloads: list[dict[str, Any]] = []
    for window_id in sorted(reader.get_window_ids(), reverse=True):
        payloads.extend(reader.get_trajectories_by_window(window_id))
    trajectories = [
        trajectory
        for payload in payloads
        if (trajectory := parse_trajectory_payload(payload, config)) is not None
    ]
    trajectories.sort(
        key=lambda traj: (
            traj.created_at or datetime.min.replace(tzinfo=timezone.utc),
            traj.total_reward,
            traj.final_pnl,
            traj.episode_length,
            traj.trajectory_id,
        ),
        reverse=True,
    )
    if config.max_trajectories > 0:
        trajectories = trajectories[: config.max_trajectories]
    logger.info(f"Parsed {len(trajectories)} valid trajectories from local export")
    return trajectories


def create_preference_pairs(
    trajectories: list[TrajectoryData],
    config: ExportConfig,
) -> list[PreferencePair]:
    """
    Create preference pairs from trajectories in the same window/scenario.

    Uses final PnL as the preference signal.
    """
    # Group by window + scenario
    groups: dict[str, list[TrajectoryData]] = {}
    for traj in trajectories:
        key = f"{traj.window_id}_{traj.scenario_id or 'default'}"
        if key not in groups:
            groups[key] = []
        groups[key].append(traj)

    pairs = []
    for group_key, group_trajs in groups.items():
        if len(group_trajs) < 2:
            continue

        # Sort by PnL descending
        sorted_trajs = sorted(group_trajs, key=lambda t: t.final_pnl, reverse=True)

        # Create pairs: best vs each worse
        for i, better in enumerate(sorted_trajs[:-1]):
            for worse in sorted_trajs[i + 1 :]:
                pnl_diff = better.final_pnl - worse.final_pnl

                if pnl_diff < config.min_pnl_diff:
                    continue

                # Convert to conversations
                better_msgs = trajectory_to_conversation(better)
                worse_msgs = trajectory_to_conversation(worse)

                # Get prompt and completions for both trajectories
                prompt_better, completion_better = conversation_to_text(better_msgs)
                prompt_worse, completion_worse = conversation_to_text(worse_msgs)

                # Ensure chosen and rejected share the identical prompt
                # This is critical for preference learning - the model must compare
                # completions given the exact same context
                if prompt_better != prompt_worse:
                    # Prompts differ despite same window/scenario - skip this pair
                    # This can happen due to different observation states or step counts
                    logger.debug(
                        f"Skipping pair: prompts differ for window {better.window_id} "
                        f"(better={better.trajectory_id}, worse={worse.trajectory_id})"
                    )
                    continue

                pairs.append(
                    PreferencePair(
                        prompt=prompt_better,
                        chosen=completion_better,
                        rejected=completion_worse,
                        chosen_score=better.final_pnl,
                        rejected_score=worse.final_pnl,
                        window_id=better.window_id,
                        scenario_id=better.scenario_id,
                        archetype_chosen=better.archetype,
                        archetype_rejected=worse.archetype,
                        pnl_diff=pnl_diff,
                        metadata={
                            "chosen_trajectory_id": better.trajectory_id,
                            "rejected_trajectory_id": worse.trajectory_id,
                            "chosen_episode_length": better.episode_length,
                            "rejected_episode_length": worse.episode_length,
                        },
                    )
                )

                if config.max_pairs and len(pairs) >= config.max_pairs:
                    logger.info(f"Reached max pairs limit: {config.max_pairs}")
                    return pairs

    logger.info(f"Created {len(pairs)} preference pairs from {len(groups)} groups")
    return pairs


def create_ranked_groups(
    trajectories: list[TrajectoryData],
    config: ExportConfig,
) -> list[RankedTrajectoryGroup]:
    """
    Create ranked trajectory groups for GRPO-style training.

    Groups are formed by batch/window/scenario and then ordered by total reward with
    final PnL as a deterministic tie-breaker. This preserves the relative
    ordering needed for ranking-based training without forcing identical prompts.
    """
    decision_groups: dict[str, list[dict[str, Any]]] = {}
    for traj in trajectories:
        for example in build_decision_examples(traj):
            decision_groups.setdefault(example["group_key"], []).append(example)

    ranked_groups: list[RankedTrajectoryGroup] = []
    for group_key, decision_candidates in decision_groups.items():
        if len(decision_candidates) < 2:
            continue

        sorted_candidates = sorted(
            decision_candidates,
            key=lambda item: (
                item["ranking_score"],
                item["tie_breaker_score"],
                item["trajectory_final_pnl"],
                -item["episode_length"],
            ),
            reverse=True,
        )
        ranked_groups.append(
            RankedTrajectoryGroup(
                group_id=group_key,
                window_id=str(sorted_candidates[0]["window_id"]),
                scenario_id=sorted_candidates[0]["scenario_id"],
                score_field="step_reward",
                tie_breaker_field="trajectory_total_reward",
                candidates=[
                    {
                        **candidate,
                        "rank": rank,
                        "final_pnl": candidate["trajectory_final_pnl"],
                        "total_reward": candidate["trajectory_total_reward"],
                        "metadata": (candidate["metadata"] if config.include_metadata else {}),
                    }
                    for rank, candidate in enumerate(sorted_candidates, start=1)
                ],
                metadata={
                    "candidate_count": len(sorted_candidates),
                    "group_kind": "decision_step",
                    "grouping_field": "step/action/target",
                    "grouping_value": group_key,
                    "best_step_reward": sorted_candidates[0]["ranking_score"],
                    "worst_step_reward": sorted_candidates[-1]["ranking_score"],
                    "best_trajectory_total_reward": max(
                        item["trajectory_total_reward"] for item in sorted_candidates
                    ),
                    "worst_trajectory_total_reward": min(
                        item["trajectory_total_reward"] for item in sorted_candidates
                    ),
                },
            )
        )

    if ranked_groups:
        logger.info(
            "Created %s decision-level ranked groups from %s trajectories",
            len(ranked_groups),
            len(trajectories),
        )
        return ranked_groups

    groups: dict[str, list[TrajectoryData]] = {}
    for traj in trajectories:
        key = f"{infer_batch_scope(traj)}__{traj.window_id}_{traj.scenario_id or 'default'}"
        groups.setdefault(key, []).append(traj)

    for group_key, group_trajs in groups.items():
        if len(group_trajs) < 2:
            logger.debug(
                "Skipping ranking group %s because it only has %s trajectory",
                group_key,
                len(group_trajs),
            )
            continue

        context_groups: dict[tuple[str, str], list[TrajectoryData]] = {}
        for traj in group_trajs:
            context_groups.setdefault(infer_ranking_context(traj), []).append(traj)

        eligible_context_groups = [
            (context_key, context_trajs)
            for context_key, context_trajs in context_groups.items()
            if len(context_trajs) >= 2
        ]
        if not eligible_context_groups:
            eligible_context_groups = [(("window_scope", group_key), group_trajs)]

        for (context_field, context_value), scoped_trajs in eligible_context_groups:
            sorted_trajs = sorted(
                scoped_trajs,
                key=lambda t: (t.total_reward, t.final_pnl, -t.episode_length),
                reverse=True,
            )
            candidates: list[dict[str, Any]] = []
            for rank, traj in enumerate(sorted_trajs, start=1):
                messages = trajectory_to_conversation(traj)
                prompt, completion = conversation_to_text(messages)
                dominant_market = infer_dominant_market(traj)
                dominant_action_type = infer_dominant_action_type(traj)
                candidates.append(
                    {
                        "rank": rank,
                        "trajectory_id": traj.trajectory_id,
                        "agent_id": traj.agent_id,
                        "agent_name": traj.agent_name,
                        "archetype": traj.archetype,
                        "prompt": prompt,
                        "completion": completion,
                        "messages": messages,
                        "ranking_score": traj.total_reward,
                        "tie_breaker_score": traj.final_pnl,
                        "final_pnl": traj.final_pnl,
                        "total_reward": traj.total_reward,
                        "episode_length": traj.episode_length,
                        "dominant_market": dominant_market,
                        "dominant_action_type": dominant_action_type,
                        "created_at": traj.created_at.isoformat() if traj.created_at else None,
                        "metadata": traj.metadata if config.include_metadata else {},
                    }
                )

            scoped_group_id = (
                group_key
                if context_field == "window_scope"
                else f"{group_key}__{context_field}_{_normalize_group_token(context_value)}"
            )
            ranked_groups.append(
                RankedTrajectoryGroup(
                    group_id=scoped_group_id,
                    window_id=sorted_trajs[0].window_id,
                    scenario_id=sorted_trajs[0].scenario_id,
                    score_field="total_reward",
                    tie_breaker_field="final_pnl",
                    candidates=candidates,
                    metadata={
                        "candidate_count": len(candidates),
                        "group_kind": "trajectory_fallback",
                        "best_total_reward": candidates[0]["total_reward"],
                        "worst_total_reward": candidates[-1]["total_reward"],
                        "best_final_pnl": max(item["final_pnl"] for item in candidates),
                        "worst_final_pnl": min(item["final_pnl"] for item in candidates),
                        "batch_scope": infer_batch_scope(sorted_trajs[0]),
                        "grouping_field": context_field,
                        "grouping_value": context_value,
                    },
                )
            )

    logger.info(
        "Created %s fallback ranked groups from %s trajectories",
        len(ranked_groups),
        len(trajectories),
    )
    return ranked_groups


def create_sft_dataset(trajectories: list[TrajectoryData]) -> list[dict[str, Any]]:
    """Create SFT dataset from trajectories."""
    sft_data = []

    used_decision_examples = False
    for traj in trajectories:
        decision_examples = build_decision_examples(traj)
        if decision_examples:
            used_decision_examples = True
            for example in decision_examples:
                sft_data.append(
                    {
                        "prompt": example["prompt"],
                        "completion": example["completion"],
                        "messages": example["messages"],
                        "trajectory_id": example["trajectory_id"],
                        "archetype": example["archetype"],
                        "final_pnl": example["trajectory_final_pnl"],
                        "episode_length": example["episode_length"],
                        "window_id": example["window_id"],
                    }
                )
            continue

        messages = trajectory_to_conversation(traj)
        prompt, completion = conversation_to_text(messages)
        sft_data.append(
            {
                "prompt": prompt,
                "completion": completion,
                "messages": messages,
                "trajectory_id": traj.trajectory_id,
                "archetype": traj.archetype,
                "final_pnl": traj.final_pnl,
                "episode_length": traj.episode_length,
                "window_id": traj.window_id,
            }
        )

    if used_decision_examples:
        logger.info("Created %s decision-level SFT examples", len(sft_data))

    return sft_data


def create_raw_dataset(trajectories: list[TrajectoryData]) -> list[dict[str, Any]]:
    """Create raw trajectory dataset for analysis."""
    raw_data = []

    for traj in trajectories:
        raw_data.append(
            {
                "trajectory_id": traj.trajectory_id,
                "agent_id": traj.agent_id,
                "agent_name": traj.agent_name,
                "window_id": traj.window_id,
                "scenario_id": traj.scenario_id,
                "archetype": traj.archetype,
                "steps": traj.steps,
                "final_pnl": traj.final_pnl,
                "final_balance": traj.final_balance,
                "episode_length": traj.episode_length,
                "total_reward": traj.total_reward,
                "metadata": traj.metadata,
                "created_at": traj.created_at.isoformat() if traj.created_at else None,
            }
        )

    return raw_data


def save_datasets(
    rankings: list[RankedTrajectoryGroup],
    preferences: list[PreferencePair],
    sft_data: list[dict[str, Any]],
    raw_data: list[dict[str, Any]],
    config: ExportConfig,
):
    """Save datasets to disk using HuggingFace datasets."""
    try:
        from datasets import Dataset, DatasetDict
    except ImportError:
        raise ImportError("datasets required: pip install datasets")

    output_path = Path(config.output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    def sanitize_text(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        sanitized_chars = []
        for char in value:
            codepoint = ord(char)
            if 0xD800 <= codepoint <= 0xDFFF:
                sanitized_chars.append("\ufffd")
            else:
                sanitized_chars.append(char)
        return "".join(sanitized_chars)

    def sanitize_jsonish(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                sanitize_text(key): sanitize_jsonish(inner_value)
                for key, inner_value in value.items()
            }
        if isinstance(value, list):
            return [sanitize_jsonish(item) for item in value]
        return sanitize_text(value)

    def safe_json_dumps(value: Any) -> str:
        return json.dumps(sanitize_jsonish(value), ensure_ascii=False)

    dataset_dict = {}

    # Rankings dataset
    if rankings and config.format in ["rankings", "all"]:
        ranking_records = [
            {
                "group_id": sanitize_text(group.group_id),
                "window_id": sanitize_text(group.window_id),
                "scenario_id": sanitize_text(group.scenario_id or ""),
                "score_field": sanitize_text(group.score_field),
                "tie_breaker_field": sanitize_text(group.tie_breaker_field),
                "candidate_count": len(group.candidates),
                "top_trajectory_id": sanitize_text(group.candidates[0]["trajectory_id"]),
                "bottom_trajectory_id": sanitize_text(group.candidates[-1]["trajectory_id"]),
                "top_score": group.candidates[0]["ranking_score"],
                "bottom_score": group.candidates[-1]["ranking_score"],
                "candidates": safe_json_dumps(group.candidates),
                "metadata": safe_json_dumps(group.metadata) if config.include_metadata else "{}",
            }
            for group in rankings
        ]
        dataset_dict["rankings"] = Dataset.from_list(ranking_records)
        logger.info(f"Created rankings split with {len(ranking_records)} groups")

    # Preferences dataset
    if preferences and config.format in ["preferences"]:
        pref_records = [
            {
                "prompt": sanitize_text(p.prompt),
                "chosen": sanitize_text(p.chosen),
                "rejected": sanitize_text(p.rejected),
                "chosen_score": p.chosen_score,
                "rejected_score": p.rejected_score,
                "score_diff": p.pnl_diff,
                "window_id": sanitize_text(p.window_id),
                "scenario_id": sanitize_text(p.scenario_id or ""),
                "archetype_chosen": sanitize_text(p.archetype_chosen),
                "archetype_rejected": sanitize_text(p.archetype_rejected),
                **(sanitize_jsonish(p.metadata) if config.include_metadata else {}),
            }
            for p in preferences
        ]
        dataset_dict["preferences"] = Dataset.from_list(pref_records)
        logger.info(f"Created preferences split with {len(pref_records)} examples")

    # SFT dataset
    if sft_data and config.format in ["sft", "all"]:
        sft_records = [
            {
                "prompt": sanitize_text(d["prompt"]),
                "completion": sanitize_text(d["completion"]),
                "messages": safe_json_dumps(d["messages"]),  # Serialize for Arrow
                "trajectory_id": sanitize_text(d["trajectory_id"]),
                "archetype": sanitize_text(d["archetype"]),
                "final_pnl": d["final_pnl"],
                "episode_length": d["episode_length"],
                "window_id": sanitize_text(d["window_id"]),
            }
            for d in sft_data
        ]
        dataset_dict["sft"] = Dataset.from_list(sft_records)
        logger.info(f"Created SFT split with {len(sft_records)} examples")

    # Raw dataset
    if raw_data and config.format in ["raw", "all"]:
        raw_records = [
            {
                "trajectory_id": sanitize_text(d["trajectory_id"]),
                "agent_id": sanitize_text(d["agent_id"]),
                "agent_name": sanitize_text(d["agent_name"]),
                "window_id": sanitize_text(d["window_id"]),
                "scenario_id": sanitize_text(d["scenario_id"] or ""),
                "archetype": sanitize_text(d["archetype"]),
                "steps": safe_json_dumps(d["steps"]),  # Serialize for Arrow
                "final_pnl": d["final_pnl"],
                "final_balance": d["final_balance"] or 0.0,
                "episode_length": d["episode_length"],
                "total_reward": d["total_reward"],
                "metadata": safe_json_dumps(d["metadata"]),
                "created_at": sanitize_text(d["created_at"] or ""),
            }
            for d in raw_data
        ]
        dataset_dict["raw"] = Dataset.from_list(raw_records)
        logger.info(f"Created raw split with {len(raw_records)} examples")

    if not dataset_dict:
        logger.warning("No datasets created!")
        return

    # Create DatasetDict
    full_dataset = DatasetDict(dataset_dict)

    # Save locally
    full_dataset.save_to_disk(str(output_path))
    logger.info(f"Saved dataset to {output_path}")

    # Also save as parquet for easy inspection
    for split_name, split_data in full_dataset.items():
        parquet_path = output_path / f"{split_name}.parquet"
        split_data.to_parquet(str(parquet_path))
        logger.info(f"Saved {split_name}.parquet")

    export_summary = {
        "source": {
            "type": "local_export" if config.source_dir else "database",
            "source_dir": config.source_dir,
            "lookback_hours": config.lookback_hours,
            "database_configured": bool(config.database_url),
        },
        "format": config.format,
        "include_metadata": config.include_metadata,
        "counts": {
            "rankings": len(rankings),
            "ranking_rows": sum(len(group.candidates) for group in rankings),
            "preferences": len(preferences),
            "sft": len(sft_data),
            "raw": len(raw_data),
        },
        "ranking": {
            "score_field": rankings[0].score_field if rankings else None,
            "tie_breaker_field": rankings[0].tie_breaker_field if rankings else None,
            "group_kind": rankings[0].metadata.get("group_kind") if rankings else None,
            "average_candidates_per_group": (
                sum(len(group.candidates) for group in rankings) / len(rankings) if rankings else 0
            ),
        },
        "splits": list(full_dataset.keys()),
        "output_dir": str(output_path),
        "push_to_hub": config.push_to_hub,
    }
    (output_path / "export_summary.json").write_text(
        json.dumps(export_summary, indent=2) + "\n",
        encoding="utf-8",
    )

    # Push to hub if requested
    if config.push_to_hub:
        push_to_huggingface(full_dataset, config)


def push_to_huggingface(dataset: "DatasetDict", config: ExportConfig):
    """Push dataset to HuggingFace Hub."""
    from huggingface_hub import HfApi

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        logger.warning("HF_TOKEN not set, skipping push to hub")
        return

    repo_id = config.push_to_hub
    logger.info(f"Pushing dataset to HuggingFace Hub: {repo_id}")

    # Create dataset card
    card_content = f"""---
license: mit
task_categories:
  - reinforcement-learning
  - text-generation
language:
  - en
tags:
  - trading
  - crypto
  - rlhf
  - grpo
  - preference-learning
  - babylon
pretty_name: Babylon Trading Trajectories
size_categories:
  - 1K<n<10K
---

# Babylon Trading Trajectories

AI trading agent trajectories from the Babylon simulation environment.

## Dataset Description

This dataset contains trajectories from AI agents trading in simulated crypto markets.
Each trajectory represents a sequence of observations and actions taken by an agent.

### Splits

- **rankings**: Ranked trajectory groups for GRPO/ranking-style reward training
- **preferences**: Legacy preference pairs for DPO/RLHF training
- **sft**: Single trajectories formatted for supervised fine-tuning
- **raw**: Complete trajectory data for analysis

### Features

**Rankings split:**
- `group_id`: Ranking cohort identifier
- `candidates`: JSON-serialized ordered candidates with prompts, completions, rewards, and rank
- `score_field`: Primary ranking field used for ordering
- `tie_breaker_field`: Secondary field used for deterministic ordering

**Preferences split:**
- `prompt`: The market context and observation
- `chosen`: The action from the better-performing agent
- `rejected`: The action from the worse-performing agent
- `chosen_score`: Final PnL of chosen trajectory
- `rejected_score`: Final PnL of rejected trajectory
- `archetype_chosen/rejected`: Trading strategy archetype

**SFT split:**
- `prompt`: Conversation context
- `completion`: Agent's action/response
- `messages`: Full conversation in chat format
- `final_pnl`: Trading performance

**Raw split:**
- Full trajectory data including all steps and metadata

## Usage

```python
from datasets import load_dataset

# Load preferences for DPO training
dataset = load_dataset("{repo_id}", split="preferences")

# Load ranked groups for GRPO-style training
rankings = load_dataset("{repo_id}", split="rankings")

# Load for SFT
sft_data = load_dataset("{repo_id}", split="sft")

# Load raw trajectories for analysis
raw = load_dataset("{repo_id}", split="raw")
```

## Training

These trajectories were collected from:
- Multiple trading archetypes (trader, hodler, analyst, degen, conservative)
- Various market conditions (bull, bear, sideways)
- Real-time market data from crypto exchanges

## License

MIT License

## Citation

```bibtex
@misc{{babylon-trading-2025,
  author = {{Babylon Labs}},
  title = {{Babylon Trading Trajectories}},
  year = {{2025}},
  publisher = {{HuggingFace}},
  url = {{https://huggingface.co/datasets/{repo_id}}}
}}
```
"""

    try:
        dataset.push_to_hub(
            repo_id,
            token=hf_token,
            private=False,
        )
        logger.info(f"Successfully pushed to {repo_id}")

        # Update README
        api = HfApi(token=hf_token)
        api.upload_file(
            path_or_fileobj=card_content.encode(),
            path_in_repo="README.md",
            repo_id=repo_id,
            repo_type="dataset",
        )
        logger.info("Updated dataset README")

    except Exception as e:
        logger.error(f"Failed to push to hub: {e}")
        raise


async def main():
    parser = argparse.ArgumentParser(description="Export Babylon trajectories to HuggingFace")
    parser.add_argument("--output", "-o", default="./hf_export", help="Output directory")
    parser.add_argument(
        "--source-dir",
        help="Local Babylon export directory containing trajectories.jsonl or JSON trajectory files",
    )
    parser.add_argument(
        "--push-to-hub", help="HuggingFace repo ID to push to (e.g., 'org/dataset-name')"
    )
    parser.add_argument(
        "--format",
        choices=["rankings", "preferences", "sft", "raw", "all"],
        default="all",
        help="Output format(s)",
    )
    parser.add_argument("--lookback-hours", type=int, default=720, help="Hours to look back")
    parser.add_argument("--min-actions", type=int, default=3, help="Minimum actions per trajectory")
    parser.add_argument(
        "--max-trajectories", type=int, default=50000, help="Maximum trajectories to fetch"
    )
    parser.add_argument("--max-pairs", type=int, help="Maximum preference pairs to create")
    parser.add_argument(
        "--min-pnl-diff", type=float, default=0.0, help="Minimum PnL diff for pairs"
    )
    parser.add_argument("--archetypes", nargs="+", help="Filter by archetypes")
    parser.add_argument("--no-metadata", action="store_true", help="Exclude metadata from export")

    args = parser.parse_args()

    config = ExportConfig(
        source_dir=args.source_dir,
        output_dir=args.output,
        push_to_hub=args.push_to_hub,
        format=args.format,
        lookback_hours=args.lookback_hours,
        min_actions=args.min_actions,
        max_trajectories=args.max_trajectories,
        max_pairs=args.max_pairs,
        min_pnl_diff=args.min_pnl_diff,
        archetypes=args.archetypes,
        include_metadata=not args.no_metadata,
    )

    if not config.source_dir and not config.database_url:
        logger.error("DATABASE_URL environment variable not set")
        sys.exit(1)

    # Fetch trajectories
    trajectories = await fetch_trajectories(config)

    if not trajectories:
        logger.error("No trajectories found")
        sys.exit(1)

    # Create datasets based on format
    rankings = []
    preferences = []
    sft_data = []
    raw_data = []

    if config.format in ["rankings", "all"]:
        rankings = create_ranked_groups(trajectories, config)

    if config.format in ["preferences"]:
        preferences = create_preference_pairs(trajectories, config)

    if config.format in ["sft", "all"]:
        sft_data = create_sft_dataset(trajectories)

    if config.format in ["raw", "all"]:
        raw_data = create_raw_dataset(trajectories)

    # Save and optionally push
    save_datasets(rankings, preferences, sft_data, raw_data, config)

    # Print summary
    print("\n" + "=" * 60)
    print("EXPORT SUMMARY")
    print("=" * 60)
    print(f"Trajectories fetched: {len(trajectories)}")
    if rankings:
        ranking_rows = sum(len(group.candidates) for group in rankings)
        print(f"Ranking groups: {len(rankings)}")
        print(f"Ranking rows: {ranking_rows}")
    if preferences:
        print(f"Preference pairs: {len(preferences)}")
    if sft_data:
        print(f"SFT examples: {len(sft_data)}")
    if raw_data:
        print(f"Raw trajectories: {len(raw_data)}")
    print(f"Output directory: {config.output_dir}")
    if config.push_to_hub:
        print(f"Pushed to: https://huggingface.co/datasets/{config.push_to_hub}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
