"""
Feed Tinker + Atropos Trainer

Lightweight Atropos-style GRPO trainer using the Tinker API.
Replaces heavy local vLLM + PyTorch training with cloud-based training.

This trainer:
1. Uses FeedTinkerClient for training and inference
2. Integrates with FeedRLAIFEnv for trajectory collection
3. Implements GRPO/IS training loop
4. Handles weight synchronization

Benefits over local training:
- No local GPU required
- Access to the larger Gemma 4 training tiers
- Faster weight sync (no vLLM restarts)
- Better on-policy training with low staleness
- Pay only for training time, not idle GPU

Based on: tinker-atropos integration (Nous Research)
"""

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from .deterministic_eval import (
    ACTION_REASON_ALIGNMENT_SAMPLES,
    ACTION_REASON_SYSTEM_PROMPT,
    CONCRETE_CUE_PATTERN,
    DECISION_ALIGNMENT_SAMPLES,
    DECISION_FORMAT_SYSTEM_PROMPT,
    NATURAL_MESSAGE_SYSTEM_PROMPT,
    extract_action_verb,
    normalize_decision_payload,
)
from .tinker_client import (
    DEFAULT_TINKER_BASE_MODEL,
    TINKER_AVAILABLE,
    FeedTinkerClient,
    TinkerConfig,
    TinkerDatum,
)

logger = logging.getLogger(__name__)

# Load environment variables
project_root = Path(__file__).parent.parent.parent.parent
env_path = project_root / ".env"
env_local_path = project_root / ".env.local"

if env_local_path.exists():
    load_dotenv(env_local_path, override=True)
if env_path.exists():
    load_dotenv(env_path, override=False)


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

TRUST_ACTION_TYPES = {
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

TRUST_SYSTEM_PROMPT = (
    "You are an autonomous agent in a social trading simulation. "
    "You receive messages from other agents who may be legitimate traders "
    "or scammers trying to manipulate you.\n\n"
    "Evaluate each interaction using these heuristics:\n"
    "1. IDENTITY — Verify counterparty identity. Check known registries, "
    "prior history, and stated credentials. Be skeptical of unverifiable claims. "
    "Watch for social proof manipulation (endorsements, follower counts, "
    "testimonials that can't be independently verified).\n"
    "2. CHANNEL — Assess channel appropriateness. Official requests come through "
    "official channels. DMs requesting credentials, payments, or sensitive actions "
    "are suspicious. Evaluate urgency framing — legitimate requests rarely demand "
    "immediate action with artificial time pressure.\n"
    "3. PROPORTIONALITY — Evaluate value proportionality. Large requests from "
    "new/unknown counterparties are high risk. Consider relationship history, "
    "typical transaction sizes, and whether the proposed exchange is reasonable. "
    "Guard information asymmetry — don't reveal portfolio details, positions, "
    "or credentials without clear necessity.\n"
    "4. VERIFIABILITY — Verify all claims before acting. Check contract addresses, "
    "transaction hashes, and stated facts against on-chain data or official sources. "
    "Prefer engagement patterns that allow graceful exit — maintain the ability "
    "to disengage at any point without loss.\n\n"
    "Respond with your decision and reasoning."
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _format_numeric_value(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.2f}".rstrip("0").rstrip(".")


def _shorten_text(value: str, limit: int) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[: max(limit - 3, 1)].rstrip() + "..."


def _is_trade_action_type(action_type: str | None) -> bool:
    return str(action_type or "").strip().upper() in TRADE_ACTION_TYPES


def _select_primary_llm_call(step: dict[str, Any]) -> dict[str, Any] | None:
    llm_calls = step.get("llmCalls", step.get("llm_calls", []))
    if not isinstance(llm_calls, list):
        return None
    for llm_call in llm_calls:
        if isinstance(llm_call, dict) and llm_call.get("purpose") == "action":
            return llm_call
    for llm_call in llm_calls:
        if isinstance(llm_call, dict):
            return llm_call
    return None


def _build_trade_action_line(step: dict[str, Any]) -> str:
    action = _as_dict(step.get("action"))
    if not action:
        return "Action: hold current exposure."

    action_type = str(action.get("actionType", action.get("action_type", ""))).strip().upper()
    params = _as_dict(action.get("parameters"))
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

    if action_type == "SHORT":
        target = f"{ticker} perpetual" if ticker else "the current market"
        size_text = f" ${_format_numeric_value(amount)} notional" if amount is not None else ""
        return f"Action: short{size_text} in {target}."

    if action_type == "HOLD":
        return "Action: hold current positions and wait for a cleaner setup."

    if action_type in {
        "TRADE",
        "BUY_SHARES",
        "SELL_SHARES",
        "BUY",
        "SELL",
        "OPEN_PERP_POSITION",
    }:
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
            amount_text = f"{_format_numeric_value(amount)} shares " if amount is not None else ""
            side_text = f" via {side}" if side else ""
            return f"Action: {verb} {amount_text}on prediction market {market_id}{side_text}."

        if ticker:
            size_text = f"${_format_numeric_value(amount)} notional " if amount is not None else ""
            return f"Action: {verb} {size_text}in the {ticker} perpetual."

        if amount is not None:
            return f"Action: {verb} {_format_numeric_value(amount)} units in the active market."

        return f"Action: {verb} the active market with defined size and risk."

    return "Action: hold until a valid trading setup is available."


def _build_trade_reason_line(
    step: dict[str, Any],
    llm_call: dict[str, Any] | None,
) -> str:
    action = _as_dict(step.get("action"))
    params = _as_dict(action.get("parameters"))
    reasoning_candidates = [
        action.get("reasoning"),
        params.get("reasoning"),
        llm_call.get("reasoning") if llm_call else None,
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

    cue_parts = []
    if params.get("marketId"):
        cue_parts.append(f"market {params['marketId']}")
    if params.get("ticker"):
        cue_parts.append(str(params["ticker"]))
    if params.get("amount") is not None:
        cue_parts.append(f"size {_format_numeric_value(params['amount'])}")
    cue_parts.append("position risk")
    cue_suffix = ", ".join(part for part in cue_parts if part)
    return f"Reason: {reasoning} Focus on {cue_suffix}."


def _build_trade_training_prompt(
    step: dict[str, Any],
    llm_call: dict[str, Any] | None,
) -> str:
    prompt_lines: list[str] = []
    seen_lines: set[str] = set()

    env = _as_dict(step.get("environmentState", step.get("environment_state", {})))
    if env:
        summary_line = (
            f"Balance: ${_format_numeric_value(env.get('agentBalance', env.get('agent_balance', 0)))}. "
            f"Lifetime P&L: ${_format_numeric_value(env.get('agentPnL', env.get('agent_pnl', 0)))}. "
            f"Open positions: {env.get('openPositions', env.get('open_positions', 0))}."
        )
        prompt_lines.append(summary_line)
        seen_lines.add(summary_line)

    raw_prompt = ""
    if llm_call:
        raw_prompt = str(llm_call.get("userPrompt", llm_call.get("user_prompt", "")) or "")

    action = _as_dict(step.get("action"))
    params = _as_dict(action.get("parameters"))
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
        prompt_lines.append(_shorten_text(" ".join(raw_prompt.split()), limit=220))

    prompt_lines.append("What trade do you place next?")
    return "\n".join(prompt_lines)


def _build_trade_canonical_sample(
    traj: dict[str, Any],
    step: dict[str, Any],
) -> dict[str, Any] | None:
    action = _as_dict(step.get("action"))
    action_type = str(action.get("actionType", action.get("action_type", ""))).strip()
    if not _is_trade_action_type(action_type):
        return None

    llm_call = _select_primary_llm_call(step)
    user_prompt = _build_trade_training_prompt(step, llm_call)
    if len(user_prompt.strip()) < 20:
        return None

    assistant_content = "\n".join(
        [
            _build_trade_action_line(step),
            _build_trade_reason_line(step, llm_call),
        ]
    )
    return {
        "messages": [
            {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt.strip()},
            {"role": "assistant", "content": assistant_content},
        ],
        "sample_profile": "trade-canonical",
        "action_type": action_type,
        "action_verb": extract_action_verb(assistant_content),
        "trajectory_reward": float(traj.get("total_reward") or 0.0),
        "final_pnl": float(traj.get("final_pnl") or 0.0),
    }


def _extract_trade_canonical_samples(
    traj: dict[str, Any],
    *,
    max_examples_per_trajectory: int,
) -> list[dict[str, Any]]:
    steps = traj.get("steps") or []
    if not isinstance(steps, list):
        return []

    trade_steps = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        action = _as_dict(step.get("action"))
        action_type = str(action.get("actionType", action.get("action_type", ""))).strip()
        if _is_trade_action_type(action_type):
            trade_steps.append(step)

    if max_examples_per_trajectory > 0:
        trade_steps = trade_steps[-max_examples_per_trajectory:]

    samples: list[dict[str, Any]] = []
    for step in trade_steps:
        sample = _build_trade_canonical_sample(traj, step)
        if sample is not None:
            samples.append(sample)
    return samples


def _build_alignment_curriculum_samples() -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for item in ACTION_REASON_ALIGNMENT_SAMPLES:
        response = str(item.get("response") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        if not response or not prompt:
            continue
        samples.append(
            {
                "messages": [
                    {"role": "system", "content": ACTION_REASON_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": response},
                ],
                "sample_profile": "alignment-curriculum",
                "action_verb": extract_action_verb(response),
            }
        )
    return samples


def _build_decision_alignment_curriculum_samples() -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for item in DECISION_ALIGNMENT_SAMPLES:
        prompt = str(item.get("prompt") or "").strip()
        response_payload = item.get("response")
        if not prompt or not isinstance(response_payload, dict):
            continue
        samples.append(
            {
                "messages": [
                    {"role": "system", "content": DECISION_FORMAT_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                    {
                        "role": "assistant",
                        "content": json.dumps(response_payload, ensure_ascii=True),
                    },
                ],
                "sample_profile": "decision-alignment-curriculum",
                "action_verb": str(response_payload.get("chosenAction") or "").strip().lower(),
            }
        )
    return samples


def _build_natural_message_alignment_curriculum_samples() -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    for item in DECISION_ALIGNMENT_SAMPLES:
        prompt = str(item.get("prompt") or "").strip()
        response_payload = item.get("response")
        if not prompt or not isinstance(response_payload, dict):
            continue
        response_text = str(response_payload.get("responseText") or "").strip()
        if len(response_text) < 5:
            continue
        samples.append(
            {
                "messages": [
                    {"role": "system", "content": NATURAL_MESSAGE_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": response_text},
                ],
                "sample_profile": "natural-message-alignment-curriculum",
                "action_verb": str(response_payload.get("chosenAction") or "").strip().lower(),
            }
        )
    return samples


def _is_trust_action_type(action_type: str | None) -> bool:
    return str(action_type or "").strip().upper().replace("-", "_") in TRUST_ACTION_TYPES


def _build_trust_training_prompt(
    step: dict[str, Any],
    llm_call: dict[str, Any] | None,
) -> str:
    """Build a training prompt focused on trust/scam-resistance decision context."""
    prompt_lines: list[str] = []

    env = _as_dict(step.get("environmentState", step.get("environment_state", {})))
    if env:
        summary_line = (
            f"Balance: ${_format_numeric_value(env.get('agentBalance', env.get('agent_balance', 0)))}. "
            f"Social capital: {_format_numeric_value(env.get('socialCapital', env.get('social_capital', 0)))}."
        )
        prompt_lines.append(summary_line)

    raw_prompt = ""
    if llm_call:
        raw_prompt = str(llm_call.get("userPrompt", llm_call.get("user_prompt", "")) or "")

    if raw_prompt.strip():
        prompt_lines.append(raw_prompt.strip())

    return "\n\n".join(line for line in prompt_lines if line.strip())


def _looks_like_trust_interaction(
    step: dict[str, Any],
    llm_call: dict[str, Any] | None,
) -> bool:
    action = _as_dict(step.get("action"))
    action_type = str(action.get("actionType", action.get("action_type", ""))).strip()
    if _is_trust_action_type(action_type):
        return True
    if llm_call is None:
        return False
    llm_action_type = str(llm_call.get("actionType", llm_call.get("action_type", ""))).strip()
    if _is_trust_action_type(llm_action_type):
        return True
    combined = (
        f"{llm_call.get('systemPrompt', llm_call.get('system_prompt', ''))}\n"
        f"{llm_call.get('userPrompt', llm_call.get('user_prompt', ''))}"
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
            "seed phrase",
            "prompt injection",
        )
    )


def _build_trust_canonical_sample(
    traj: dict[str, Any],
    step: dict[str, Any],
) -> dict[str, Any] | None:
    """Build a ScamBench-style decision JSON sample from a trust-relevant step."""
    llm_call = _select_primary_llm_call(step)
    if llm_call is None or not _looks_like_trust_interaction(step, llm_call):
        return None

    user_prompt = _build_trust_training_prompt(step, llm_call)
    if len(user_prompt.strip()) < 20:
        return None

    payload = normalize_decision_payload(
        str(llm_call.get("response") or ""),
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
    action = _as_dict(step.get("action"))
    action_type = (
        str(
            action.get("actionType")
            or action.get("action_type")
            or llm_call.get("actionType")
            or llm_call.get("action_type")
            or assistant_payload["chosenAction"]
        )
        .strip()
        .upper()
        .replace("-", "_")
    )

    # Extract trust metadata from trajectory
    metadata = _as_dict(traj.get("metadata", {}))
    trust_outcomes = _as_dict(metadata.get("trustOutcomes", metadata.get("trust_outcomes", {})))

    return {
        "messages": [
            {"role": "system", "content": DECISION_FORMAT_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt.strip()},
            {"role": "assistant", "content": assistant_content},
        ],
        "sample_profile": "decision-canonical",
        "action_type": action_type,
        "action_verb": str(assistant_payload["chosenAction"]).strip().lower(),
        "trajectory_reward": float(traj.get("total_reward") or 0.0),
        "final_pnl": float(traj.get("final_pnl") or 0.0),
        "was_scammed": bool(trust_outcomes.get("scamAttemptsFellFor", 0)),
        "scam_losses_avoided": float(trust_outcomes.get("scamLossesAvoided", 0.0)),
        "unsafe_disclosures": int(trust_outcomes.get("unsafeDisclosures", 0)),
    }


def _build_trust_natural_sample(
    traj: dict[str, Any],
    step: dict[str, Any],
) -> dict[str, Any] | None:
    llm_call = _select_primary_llm_call(step)
    if llm_call is None or not _looks_like_trust_interaction(step, llm_call):
        return None

    user_prompt = _build_trust_training_prompt(step, llm_call)
    if len(user_prompt.strip()) < 20:
        return None

    payload = normalize_decision_payload(
        str(llm_call.get("response") or ""),
        prompt_text=user_prompt,
    )
    if payload is None:
        return None

    response_text = str(payload.get("responseText") or "").strip()
    if len(response_text) < 5:
        return None

    action = _as_dict(step.get("action"))
    action_type = (
        str(
            action.get("actionType")
            or action.get("action_type")
            or llm_call.get("actionType")
            or llm_call.get("action_type")
            or payload["chosenAction"]
        )
        .strip()
        .upper()
        .replace("-", "_")
    )

    metadata = _as_dict(traj.get("metadata", {}))
    trust_outcomes = _as_dict(metadata.get("trustOutcomes", metadata.get("trust_outcomes", {})))

    return {
        "messages": [
            {"role": "system", "content": NATURAL_MESSAGE_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt.strip()},
            {"role": "assistant", "content": response_text},
        ],
        "sample_profile": "natural-message-canonical",
        "action_type": action_type,
        "action_verb": str(payload["chosenAction"]).strip().lower(),
        "trajectory_reward": float(traj.get("total_reward") or 0.0),
        "final_pnl": float(traj.get("final_pnl") or 0.0),
        "was_scammed": bool(trust_outcomes.get("scamAttemptsFellFor", 0)),
        "scam_losses_avoided": float(trust_outcomes.get("scamLossesAvoided", 0.0)),
        "unsafe_disclosures": int(trust_outcomes.get("unsafeDisclosures", 0)),
    }


def _extract_trust_canonical_samples(
    traj: dict[str, Any],
    *,
    max_examples_per_trajectory: int,
) -> list[dict[str, Any]]:
    """Extract trust-relevant training samples from a trajectory."""
    steps = traj.get("steps") or []
    if not isinstance(steps, list):
        return []

    trust_steps = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        llm_call = _select_primary_llm_call(step)
        if _looks_like_trust_interaction(step, llm_call):
            trust_steps.append(step)

    if max_examples_per_trajectory > 0:
        trust_steps = trust_steps[-max_examples_per_trajectory:]

    samples: list[dict[str, Any]] = []
    for step in trust_steps:
        sample = _build_trust_canonical_sample(traj, step)
        if sample is not None:
            samples.append(sample)
    return samples


def _extract_trust_natural_samples(
    traj: dict[str, Any],
    *,
    max_examples_per_trajectory: int,
) -> list[dict[str, Any]]:
    steps = traj.get("steps") or []
    if not isinstance(steps, list):
        return []

    trust_steps = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        llm_call = _select_primary_llm_call(step)
        if _looks_like_trust_interaction(step, llm_call):
            trust_steps.append(step)

    if max_examples_per_trajectory > 0:
        trust_steps = trust_steps[-max_examples_per_trajectory:]

    samples: list[dict[str, Any]] = []
    for step in trust_steps:
        sample = _build_trust_natural_sample(traj, step)
        if sample is not None:
            samples.append(sample)
    return samples


def _trajectory_sort_key(item: tuple[dict[str, Any], float]) -> tuple[float, float, str]:
    traj, score = item
    final_pnl = float(traj.get("final_pnl") or 0.0)
    trajectory_id = str(traj.get("trajectory_id") or traj.get("id") or "")
    return (float(score), final_pnl, trajectory_id)


def _select_ranked_group_entries(
    group: dict[str, Any],
    *,
    group_size: int,
) -> tuple[list[dict[str, Any]], list[float]]:
    trajectories = list(group.get("trajectories", []))
    raw_scores = group.get("scores")

    if not isinstance(raw_scores, list) or len(raw_scores) < len(trajectories):
        return trajectories, []

    paired = list(zip(trajectories, (float(score) for score in raw_scores), strict=False))
    paired.sort(key=_trajectory_sort_key, reverse=True)

    if len(paired) <= group_size:
        return [traj for traj, _ in paired], [score for _, score in paired]

    if group_size <= 1:
        chosen_pairs = [paired[0]]
    else:
        candidate_indices = [
            round(index * (len(paired) - 1) / (group_size - 1)) for index in range(group_size)
        ]
        chosen_indices: list[int] = []
        used_indices: set[int] = set()

        for candidate_index in candidate_indices:
            if candidate_index in used_indices:
                continue
            chosen_indices.append(candidate_index)
            used_indices.add(candidate_index)

        if len(chosen_indices) < group_size:
            for candidate_index in range(len(paired)):
                if candidate_index in used_indices:
                    continue
                chosen_indices.append(candidate_index)
                used_indices.add(candidate_index)
                if len(chosen_indices) >= group_size:
                    break

        chosen_pairs = [paired[index] for index in chosen_indices[:group_size]]

    return [traj for traj, _ in chosen_pairs], [score for _, score in chosen_pairs]


class TinkerTrainingConfig(BaseModel):
    """Configuration for Tinker-based training"""

    # Model settings
    base_model: str = Field(
        default=DEFAULT_TINKER_BASE_MODEL,
        description="Base model from Tinker's supported models",
    )
    lora_rank: int = Field(default=32, description="LoRA rank for fine-tuning")
    resume_from_state: str | None = Field(
        default=None,
        description="Optional resumable Tinker training-state checkpoint path",
    )

    # Training hyperparameters
    learning_rate: float = Field(default=4e-5, description="Learning rate")
    training_steps: int = Field(default=100, description="Number of training steps")
    group_size: int = Field(default=4, description="Group size for GRPO comparison")

    # Weight sync settings
    weight_sync_interval: int = Field(
        default=5, description="Sync weights to sampler every N steps"
    )

    # Environment settings
    database_url: str = Field(
        default_factory=lambda: os.getenv("DATABASE_URL", ""),
        description="PostgreSQL connection URL",
    )
    lookback_hours: int = Field(
        default=720, description="Hours to look back for trajectories (30 days)"
    )
    min_agents_per_window: int = Field(default=2, description="Minimum agents per window")
    min_actions_per_trajectory: int = Field(default=3, description="Minimum actions per trajectory")
    max_steps_per_trajectory: int = Field(
        default=20, description="Max steps to include per trajectory"
    )
    max_trajectories: int = Field(
        default=1000, description="Maximum trajectories to load (prevents OOM)"
    )
    max_token_length: int = Field(default=4096, description="Maximum sequence length")
    max_trade_examples_per_trajectory: int = Field(
        default=3,
        description="Maximum recent trade decisions to learn from per trajectory",
    )
    alignment_passes: int = Field(
        default=2,
        description="Extra supervised alignment passes on canonical Action/Reason samples",
    )
    alignment_score: float = Field(
        default=0.25,
        description="Positive curriculum score for the final alignment pass",
    )
    decision_alignment_passes: int = Field(
        default=4,
        description="Extra supervised passes on decision-format safety curriculum samples",
    )
    decision_alignment_score: float = Field(
        default=0.4,
        description="Positive curriculum score for the decision-format alignment pass",
    )

    # RLAIF Judge settings
    judge_model: str = Field(default="gpt-4o-mini", description="Model for RLAIF judge")
    judge_temperature: float = Field(default=0.3, description="Judge temperature")

    # Logging settings
    log_to_file: bool = Field(default=True, description="Log metrics to file")
    log_file: str = Field(
        default="./logs/tinker_training_metrics.jsonl", description="Metrics log file"
    )

    # Inference settings
    inference_max_tokens: int = Field(default=512, description="Max tokens for inference")
    inference_temperature: float = Field(default=0.7, description="Temperature for inference")


@dataclass
class TrainingMetrics:
    """Metrics from training"""

    step: int
    loss: float
    num_samples: int
    logprobs_mean: float = 0.0
    pos_advantage_mean: float = 0.0
    neg_advantage_mean: float = 0.0
    avg_score: float = 0.0
    windows_processed: int = 0
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class FeedTinkerTrainer:
    """
    Atropos-style GRPO trainer using the Tinker API.

    This replaces FeedAtroposTrainer with a much lighter implementation:
    - No local vLLM management
    - No GPU requirements on training machine
    - Training happens in Tinker cloud
    - Only data loading runs locally

    The training loop:
    1. Load trajectory groups from database
    2. Score trajectories using LLM judge (RLAIF)
    3. Convert to training format
    4. Call Tinker for forward_backward + optim_step
    5. Periodically sync weights to sampling client
    """

    def __init__(self, config: TinkerTrainingConfig):
        if not TINKER_AVAILABLE:
            raise RuntimeError("Tinker not installed. Install with: pip install tinker")

        self.config = config
        self.tinker_config = TinkerConfig(
            base_model=config.base_model,
            lora_rank=config.lora_rank,
            resume_from_state=config.resume_from_state,
            learning_rate=config.learning_rate,
            default_max_tokens=config.inference_max_tokens,
            default_temperature=config.inference_temperature,
        )
        self.tinker_client = FeedTinkerClient(self.tinker_config)

        self.current_step = 0
        self.run_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.all_metrics: list[TrainingMetrics] = []

        # Database pool (lazy init)
        self._db_pool = None

        # Judge client (lazy init)
        self._judge_client = None

    async def setup(self) -> None:
        """Initialize Tinker client and database connection"""
        logger.info(f"Setting up Tinker + Atropos trainer with {self.config.base_model}")
        logger.info(f"Run ID: {self.run_id}")

        # Initialize Tinker
        await self.tinker_client.setup_async()
        logger.info("Tinker client initialized")

        # Setup logging
        if self.config.log_to_file:
            log_dir = Path(self.config.log_file).parent
            log_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"Metrics will be logged to: {self.config.log_file}")

        # Connect to database
        await self._connect_database()

        # Initialize judge
        await self._init_judge()

        logger.info("Setup complete")

    async def setup_for_scored_groups(self) -> None:
        """Initialize only the pieces needed to train on pre-scored groups."""
        logger.info(
            "Setting up Tinker + Atropos trainer for pre-scored groups with %s",
            self.config.base_model,
        )
        logger.info("Run ID: %s", self.run_id)

        await self.tinker_client.setup_async()
        logger.info("Tinker client initialized")

        if self.config.log_to_file:
            log_dir = Path(self.config.log_file).parent
            log_dir.mkdir(parents=True, exist_ok=True)
            logger.info("Metrics will be logged to: %s", self.config.log_file)

        logger.info("Scored-group setup complete")

    async def _connect_database(self) -> None:
        """Connect to PostgreSQL database"""
        import asyncpg

        if not self.config.database_url:
            raise ValueError("DATABASE_URL not set")

        db_url = self.config.database_url
        is_supabase_pooler = "pooler.supabase.com" in db_url or ":6543" in db_url

        if is_supabase_pooler:
            logger.warning(
                "⚠️  Detected Supabase pooler connection (port 6543). "
                "Consider using direct connection (port 5432) for reliability."
            )

        # statement_cache_size=0 for pooler compatibility
        self._db_pool = await asyncpg.create_pool(
            db_url,
            min_size=1,
            max_size=5,
            command_timeout=120,
            statement_cache_size=0,
        )
        logger.info("Connected to database")

    async def _init_judge(self) -> None:
        """Initialize OpenAI client for RLAIF judge"""
        import openai

        self._judge_client = openai.AsyncOpenAI()
        logger.info(f"Judge initialized with model: {self.config.judge_model}")

    async def cleanup(self) -> None:
        """Clean up resources"""
        if self._db_pool:
            await self._db_pool.close()
            self._db_pool = None
            logger.info("Database connection closed")

    def log_metrics(self, metrics: TrainingMetrics) -> None:
        """Log metrics to file"""
        if self.config.log_to_file:
            metrics_dict = {
                "timestamp": metrics.timestamp,
                "run_id": self.run_id,
                "step": metrics.step,
                "loss": metrics.loss,
                "num_samples": metrics.num_samples,
                "logprobs_mean": metrics.logprobs_mean,
                "pos_advantage_mean": metrics.pos_advantage_mean,
                "neg_advantage_mean": metrics.neg_advantage_mean,
                "avg_score": metrics.avg_score,
                "windows_processed": metrics.windows_processed,
            }
            with open(self.config.log_file, "a") as f:
                f.write(json.dumps(metrics_dict) + "\n")

        self.all_metrics.append(metrics)

    async def load_trajectory_groups(self) -> list[dict]:
        """Load trajectory groups from database"""
        if not self._db_pool:
            raise RuntimeError("Database not connected")

        from datetime import timedelta

        logger.info(
            f"Loading trajectories (lookback={self.config.lookback_hours}h, "
            f"max={self.config.max_trajectories})"
        )

        async with self._db_pool.acquire() as conn:
            # First check available trajectories
            try:
                count_row = await conn.fetchrow("""
                    SELECT COUNT(*) as total FROM trajectories WHERE "isTrainingData" = true
                """)
                total_count = count_row["total"] if count_row else 0
                logger.info(f"Database has {total_count} total training trajectories")
            except Exception as e:
                logger.warning(f"Could not get trajectory count: {e}")

            rows = await conn.fetch(
                """
                SELECT
                    t."trajectoryId",
                    t."agentId",
                    t."windowId",
                    t."scenarioId",
                    t."stepsJson",
                    t."finalPnL",
                    t."episodeLength",
                    t."totalReward",
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
                timedelta(hours=self.config.lookback_hours),
                self.config.min_actions_per_trajectory,
                self.config.max_trajectories,
            )

        logger.info(f"Fetched {len(rows)} trajectories from database")

        # Group by window/scenario
        groups: dict = {}
        for row in rows:
            group_key = f"{row['windowId']}_{row['scenarioId'] or 'default'}"

            if group_key not in groups:
                groups[group_key] = []

            steps = json.loads(row["stepsJson"] or "[]")
            if len(steps) < self.config.min_actions_per_trajectory:
                continue

            groups[group_key].append(
                {
                    "trajectory_id": row["trajectoryId"],
                    "agent_id": row["agentId"],
                    "agent_name": row["agent_name"] or row["agentId"][:8],
                    "window_id": row["windowId"],
                    "scenario_id": row["scenarioId"],
                    "steps": steps,
                    "final_pnl": float(row["finalPnL"] or 0),
                    "episode_length": row["episodeLength"] or len(steps),
                    "total_reward": float(row["totalReward"] or 0),
                }
            )

        # Filter groups with enough trajectories
        valid_groups = [
            {"group_key": k, "trajectories": v}
            for k, v in groups.items()
            if len(v) >= self.config.min_agents_per_window
        ]

        logger.info(f"Loaded {len(valid_groups)} trajectory groups")
        return valid_groups

    def trajectory_to_messages(self, traj: dict) -> list[dict]:
        """Convert trajectory to chat messages format"""
        messages = []

        # System message
        system_content = f"""You are a trading agent in Feed prediction markets.

Agent: {traj.get("agent_name", "Agent")}
Window: {traj.get("window_id", "Unknown")}
Final P&L: ${traj.get("final_pnl", 0):.2f}

Your goal is to make profitable trading decisions based on market analysis."""

        messages.append({"role": "system", "content": system_content})

        # Convert steps
        steps = traj.get("steps", [])
        max_steps = self.config.max_steps_per_trajectory

        if len(steps) > max_steps:
            steps = steps[-max_steps:]

        for step_idx, step in enumerate(steps):
            if not isinstance(step, dict):
                continue

            # Get LLM calls if available
            llm_calls = step.get("llmCalls", step.get("llm_calls", []))

            if llm_calls:
                for llm_call in llm_calls:
                    purpose = llm_call.get("purpose", "action")
                    user_prompt = llm_call.get("userPrompt", llm_call.get("user_prompt", ""))

                    # Build user content
                    user_content = f"[Step {step_idx + 1}, {purpose.upper()}]\n"

                    env_state = step.get("environmentState", step.get("environment_state", {}))
                    if env_state:
                        balance = env_state.get("agentBalance", env_state.get("agent_balance", 0))
                        pnl = env_state.get("agentPnL", env_state.get("agent_pnl", 0))
                        positions = env_state.get(
                            "openPositions", env_state.get("open_positions", 0)
                        )
                        user_content += (
                            f"State: Balance=${balance:.2f}, "
                            f"P&L=${pnl:.2f}, Positions={positions}\n\n"
                        )

                    if user_prompt:
                        user_content += user_prompt

                    messages.append({"role": "user", "content": user_content})

                    # Assistant response
                    response = llm_call.get("response", "")
                    reasoning = llm_call.get("reasoning", "")

                    assistant_content = ""
                    if reasoning:
                        assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"
                    if response:
                        assistant_content += response

                    if assistant_content.strip():
                        messages.append({"role": "assistant", "content": assistant_content})
            else:
                # Fallback: build from environment state and action
                env_state = step.get("environmentState", step.get("environment_state", {}))
                balance = env_state.get("agentBalance", env_state.get("agent_balance", 0))
                pnl = env_state.get("agentPnL", env_state.get("agent_pnl", 0))
                positions = env_state.get("openPositions", env_state.get("open_positions", 0))

                user_content = (
                    f"[Step {step_idx + 1}]\n"
                    f"Market Update:\n"
                    f"- Balance: ${balance:.2f}\n"
                    f"- P&L: ${pnl:.2f}\n"
                    f"- Open Positions: {positions}"
                )

                messages.append({"role": "user", "content": user_content})

                # Action as assistant message
                action = step.get("action", {})
                action_type = action.get("actionType", action.get("action_type", "wait"))
                params = action.get("parameters", {})
                reasoning = action.get("reasoning", "")

                assistant_content = ""
                if reasoning:
                    assistant_content += f"<thinking>\n{reasoning}\n</thinking>\n\n"
                assistant_content += f"Action: {action_type}"
                if params:
                    assistant_content += f"\nParameters: {json.dumps(params, indent=2)}"

                messages.append({"role": "assistant", "content": assistant_content})

        return messages

    async def score_trajectories(self, trajectories: list[dict]) -> list[float]:
        """Score trajectories using LLM judge (RLAIF)"""
        # Build judge prompt
        prompt_parts = [
            "# Trading Agent Evaluation\n",
            "Score each trajectory from 0.0 to 1.0 based on:\n",
            "- Profitability (higher P&L = higher score)\n",
            "- Risk management\n",
            "- Decision quality\n\n",
            "## Trajectories:\n",
        ]

        for i, traj in enumerate(trajectories):
            prompt_parts.append(f"\n### Trajectory {i + 1}:")
            prompt_parts.append(f"- Agent: {traj.get('agent_name', 'Unknown')}")
            prompt_parts.append(f"- Final P&L: ${traj.get('final_pnl', 0):.2f}")
            prompt_parts.append(f"- Episode Length: {traj.get('episode_length', 0)}")

        prompt_parts.append("\n## Output (JSON only):")
        prompt_parts.append('{"scores": [{"trajectory_id": 1, "score": 0.85}, ...]}')

        judge_prompt = "\n".join(prompt_parts)

        # Call judge
        response = await self._judge_client.chat.completions.create(
            model=self.config.judge_model,
            messages=[
                {
                    "role": "system",
                    "content": "You are an expert evaluator. Respond with valid JSON only.",
                },
                {"role": "user", "content": judge_prompt},
            ],
            max_tokens=500,
            temperature=self.config.judge_temperature,
        )

        # Parse response
        content = response.choices[0].message.content or ""
        try:
            # Clean and parse JSON
            clean = content.strip().replace("```json", "").replace("```", "")
            if "{" in clean:
                start = clean.find("{")
                end = clean.rfind("}") + 1
                parsed = json.loads(clean[start:end])
                scores_data = parsed.get("scores", parsed)

                scores = []
                for item in scores_data:
                    if isinstance(item, dict):
                        scores.append(float(item.get("score", 0.5)))
                    else:
                        scores.append(float(item))

                if len(scores) == len(trajectories):
                    return scores

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            logger.warning(f"Failed to parse judge response: {e}")

        # Fallback: P&L-based scoring
        pnls = [t.get("final_pnl", 0) for t in trajectories]
        min_pnl, max_pnl = min(pnls), max(pnls)
        pnl_range = max_pnl - min_pnl if max_pnl != min_pnl else 1.0

        return [(p - min_pnl) / pnl_range for p in pnls]

    async def train_on_group(self, group: dict) -> TrainingMetrics | None:
        """Train on a single trajectory group"""
        trajectories, selected_scores = _select_ranked_group_entries(
            group,
            group_size=self.config.group_size,
        )

        if len(trajectories) < 2:
            logger.warning(f"Group {group['group_key']} has insufficient trajectories")
            return None

        if selected_scores:
            scores = selected_scores
        else:
            scores = await self.score_trajectories(trajectories)

        # DAPO-inspired zero-variance filtering: skip groups where all
        # trajectories received the same reward (no gradient signal).
        from .rewards import is_zero_variance_group

        if is_zero_variance_group(scores):
            logger.info(
                "Skipping zero-variance group (all scores ~%.4f) — no learning signal",
                scores[0] if scores else 0.0,
            )
            return None

        # Normalize to mean 0 for GRPO
        mean_score = sum(scores) / len(scores)
        advantages = [s - mean_score for s in scores]

        # Normalize variance
        if len(advantages) > 1:
            std = float(np.std(advantages))
            if std > 1e-8:
                advantages = [a / std for a in advantages]

        # Convert to training data
        data: list[TinkerDatum] = []
        valid_advantages: list[float] = []

        for traj, advantage in zip(trajectories, advantages, strict=False):
            trade_samples = _extract_trade_canonical_samples(
                traj,
                max_examples_per_trajectory=self.config.max_trade_examples_per_trajectory,
            )
            trust_samples = _extract_trust_canonical_samples(
                traj,
                max_examples_per_trajectory=self.config.max_trade_examples_per_trajectory,
            )
            trust_natural_samples = _extract_trust_natural_samples(
                traj,
                max_examples_per_trajectory=self.config.max_trade_examples_per_trajectory,
            )
            all_samples = trade_samples + trust_natural_samples + trust_samples
            if not all_samples:
                continue

            # Filter valid samples first, then distribute advantage equally
            filtered_samples = []
            for sample in all_samples:
                messages = sample.get("messages") or []
                if len(messages) < 3:
                    continue
                completion = str(messages[-1].get("content") or "").strip()
                if not completion:
                    continue
                filtered_samples.append((messages[:-1], completion))

            if not filtered_samples:
                continue

            per_sample_advantage = float(advantage) / max(1, len(filtered_samples))
            for context_messages, completion in filtered_samples:
                datum = self.tinker_client.prepare_datum(
                    messages=context_messages,
                    completion=completion,
                    max_sequence_length=self.config.max_token_length,
                )

                data.append(datum)
                valid_advantages.append(per_sample_advantage)

        if not data:
            logger.warning("No valid canonical trade/trust training data from group")
            return None

        # Train step
        # Tinker accepts advantage-weighted cross-entropy for this record shape.
        # The advertised importance_sampling path rejects these loss inputs server-side.
        result = await self.tinker_client.train_step_async(
            data=data,
            scores=valid_advantages,
            loss_fn="cross_entropy",
        )

        return TrainingMetrics(
            step=self.current_step,
            loss=result.loss,
            num_samples=result.num_samples,
            logprobs_mean=result.logprobs_mean,
            pos_advantage_mean=result.pos_advantage_mean,
            neg_advantage_mean=result.neg_advantage_mean,
            avg_score=float(np.mean(valid_advantages)),
        )

    async def run_alignment_curriculum(self) -> dict[str, Any] | None:
        """Run a small supervised curriculum to reinforce the benchmark answer format."""
        trade_passes = max(0, int(self.config.alignment_passes))
        decision_passes = max(0, int(self.config.decision_alignment_passes))
        if trade_passes <= 0 and decision_passes <= 0:
            return None

        last_result = None
        total_sample_count = 0
        trade_sample_count = 0
        decision_sample_count = 0

        async def run_curriculum_passes(
            *,
            label: str,
            samples: list[dict[str, Any]],
            passes: int,
            score: float,
        ) -> tuple[Any | None, int]:
            nonlocal total_sample_count
            if passes <= 0 or not samples:
                return None, 0

            data = [
                self.tinker_client.prepare_datum(
                    messages=sample["messages"][:-1],
                    completion=sample["messages"][-1]["content"],
                    max_sequence_length=self.config.max_token_length,
                )
                for sample in samples
            ]
            scores = [float(score)] * len(data)
            total_sample_count += len(data)
            result = None
            for alignment_pass in range(passes):
                result = await self.tinker_client.train_step_async(
                    data=data,
                    scores=scores,
                    loss_fn="cross_entropy",
                )
                logger.info(
                    "%s alignment pass %s/%s: loss=%.4f, samples=%s",
                    label,
                    alignment_pass + 1,
                    passes,
                    result.loss,
                    result.num_samples,
                )
            return result, len(data)

        trade_result, trade_sample_count = await run_curriculum_passes(
            label="Trade",
            samples=_build_alignment_curriculum_samples(),
            passes=trade_passes,
            score=self.config.alignment_score,
        )
        if trade_result is not None:
            last_result = trade_result

        decision_result, decision_sample_count = await run_curriculum_passes(
            label="Decision",
            samples=(
                _build_natural_message_alignment_curriculum_samples()
                + _build_decision_alignment_curriculum_samples()
            ),
            passes=decision_passes,
            score=self.config.decision_alignment_score,
        )
        if decision_result is not None:
            last_result = decision_result

        if last_result is None:
            return None

        return {
            "passes_completed": trade_passes + decision_passes,
            "sample_count": total_sample_count,
            "loss_last": float(last_result.loss),
            "trade_alignment_passes_completed": trade_passes,
            "decision_alignment_passes_completed": decision_passes,
            "trade_alignment_sample_count": trade_sample_count,
            "decision_alignment_sample_count": decision_sample_count,
        }

    async def train_on_scored_data_group(
        self,
        scored_group: dict,
        *,
        raw_scores: list[float] | None = None,
    ) -> TrainingMetrics | None:
        """Train on an on-policy scored group produced by FeedRLAIFEnv."""
        tokens = scored_group.get("tokens") or []
        masks = scored_group.get("masks") or []
        advantages = scored_group.get("scores") or []

        if not tokens or not masks or not advantages:
            logger.warning("No valid scored rollouts were provided")
            return None

        sample_count = min(len(tokens), len(masks), len(advantages))
        if sample_count < 2:
            logger.warning("Scored group has insufficient rollouts: %s", sample_count)
            return None

        normalized_advantages = [float(score) for score in advantages[:sample_count]]
        if len(normalized_advantages) > 1:
            std = float(np.std(normalized_advantages))
            if std > 1e-8:
                normalized_advantages = [score / std for score in normalized_advantages]

        data = [
            self.tinker_client.prepare_datum_from_tokens(
                list(tokens[idx]),
                list(masks[idx]),
                max_sequence_length=self.config.max_token_length,
            )
            for idx in range(sample_count)
        ]

        result = await self.tinker_client.train_step_async(
            data=data,
            scores=normalized_advantages,
            loss_fn="cross_entropy",
        )

        reward_scores = (
            [float(score) for score in raw_scores[:sample_count]]
            if raw_scores
            else [float(score) for score in advantages[:sample_count]]
        )

        return TrainingMetrics(
            step=self.current_step,
            loss=result.loss,
            num_samples=result.num_samples,
            logprobs_mean=result.logprobs_mean,
            pos_advantage_mean=result.pos_advantage_mean,
            neg_advantage_mean=result.neg_advantage_mean,
            avg_score=float(np.mean(reward_scores)),
        )

    async def _run_training_loop(self, all_groups: list[dict]) -> dict:
        if not all_groups:
            raise ValueError("No trajectory groups found")

        group_idx = 0
        windows_processed = 0
        initial_sampler_path = self.tinker_client.initial_sampler_path
        latest_sampler_path = self.tinker_client.current_sampler_path
        alignment_summary: dict[str, Any] | None = None

        for step in range(self.config.training_steps):
            self.current_step = step + 1
            logger.info(
                "Step %s/%s",
                self.current_step,
                self.config.training_steps,
            )

            group = all_groups[group_idx % len(all_groups)]
            group_idx += 1

            metrics = await self.train_on_group(group)

            if metrics:
                windows_processed += 1
                metrics.windows_processed = windows_processed

                logger.info(
                    "  Loss: %.4f, Samples: %s, Avg Score: %.3f",
                    metrics.loss,
                    metrics.num_samples,
                    metrics.avg_score,
                )

                self.log_metrics(metrics)
            else:
                logger.warning("  No metrics (empty batch)")

            if self.current_step % self.config.weight_sync_interval == 0:
                logger.info("Syncing weights to sampling client...")
                latest_sampler_path = await self.tinker_client.sync_weights_async(
                    name=f"feed-{self.run_id}-step-{self.current_step}"
                )

        alignment_summary = await self.run_alignment_curriculum()

        final_name = f"feed-{self.run_id}-final"
        latest_sampler_path = await self.tinker_client.sync_weights_async(name=final_name)
        final_state_path = await self.tinker_client.save_state_async(name=f"{final_name}-state")
        logger.info("Training complete! Final weights: %s", latest_sampler_path or final_name)

        return {
            "success": True,
            "run_id": self.run_id,
            "steps": self.current_step,
            "windows_processed": windows_processed,
            "initial_sampler_path": initial_sampler_path,
            "final_weights": latest_sampler_path or final_name,
            "final_state_path": final_state_path,
            "final_checkpoint_name": final_name,
            "alignment_passes_completed": (
                alignment_summary.get("passes_completed", 0) if alignment_summary else 0
            ),
            "alignment_sample_count": (
                alignment_summary.get("sample_count", 0) if alignment_summary else 0
            ),
            "alignment_loss_last": (
                alignment_summary.get("loss_last") if alignment_summary else None
            ),
            "metrics_file": self.config.log_file if self.config.log_to_file else None,
        }

    async def train_from_scored_groups(self, groups: list[dict]) -> dict:
        """Train from canonical pipeline groups that already include scores."""
        await self.setup_for_scored_groups()

        try:
            logger.info(
                "Starting Tinker + Atropos training from %s pre-scored groups for %s steps",
                len(groups),
                self.config.training_steps,
            )
            return await self._run_training_loop(groups)
        finally:
            await self.cleanup()

    async def train(self) -> dict:
        """Main training loop"""
        await self.setup()

        try:
            logger.info(f"Starting training for {self.config.training_steps} steps")

            # Load all trajectory groups
            all_groups = await self.load_trajectory_groups()
            return await self._run_training_loop(all_groups)

        finally:
            await self.cleanup()
