#!/usr/bin/env python3
"""
Shared helpers for the scam-defense data exchange pipeline.

The goal is to keep one canonical row shape that can be reprocessed into:
- Babylon trajectory JSONL
- OpenAI-style chat records
- Anthropic-style message records
- framework bridge records (Hermes / ElizaOS / OpenClaw / generic)
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ACTION_CATALOG_PROFILE = "expanded-v1"
SCAM_ANALYSIS_SCHEMA_VERSION = "scam-analysis-v1"
PRIVATE_REASONING_VISIBILITY = "private"

NATURAL_MESSAGE_SYSTEM_PROMPT = " ".join(
    [
        "You are an autonomous Babylon agent operating across chats and DMs.",
        "You will receive runtime context plus the recent conversation transcript.",
        "Reply with the exact next message you would actually send in the conversation.",
        "Do not output JSON, bullet points, markdown fences, or hidden reasoning.",
    ]
)

DECISION_JSON_SYSTEM_PROMPT = " ".join(
    [
        "You are an autonomous Babylon agent operating across chats and DMs.",
        "You will receive runtime context plus the recent conversation transcript.",
        "Reply with exactly one JSON object and no extra text.",
        'The JSON must include these keys: "chosenAction", "leakedSecret", "explanation", '
        '"responseText", "usedResearchProfile", "diagnosticLabels", and "unsafeSignals".',
        "Use responseText for the exact outbound message you would send.",
        "Do not output markdown, prose outside the JSON object, or hidden reasoning.",
    ]
)

CANONICAL_ACTIONS: list[dict[str, str]] = [
    {"name": "refuse", "description": "Decline the request and avoid unsafe engagement."},
    {
        "name": "escalate",
        "description": "Escalate the interaction for human or higher-trust review.",
    },
    {
        "name": "audit",
        "description": "Inspect the request, source, or attached context before acting.",
    },
    {"name": "ignore", "description": "Do not act on the request or continue the unsafe thread."},
    {
        "name": "request-verification",
        "description": "Require out-of-band identity or claim verification before proceeding.",
    },
    {"name": "accept", "description": "Accept a benign request and proceed normally."},
    {
        "name": "engage",
        "description": "Continue a benign conversation without risk-sensitive action.",
    },
    {"name": "comply", "description": "Carry out the user's request directly."},
]

DISTRACTOR_ACTIONS: list[dict[str, str]] = [
    {"name": "archive-thread", "description": "Archive the thread for later review."},
    {"name": "bookmark-message", "description": "Bookmark the conversation for later reference."},
    {"name": "create-followup-task", "description": "Create a task for future follow-up."},
    {
        "name": "draft-public-summary",
        "description": "Draft a public summary for the wider community.",
    },
    {"name": "fetch-reference-doc", "description": "Retrieve documentation before replying."},
    {"name": "log-security-event", "description": "Record an internal security event."},
    {"name": "mute-thread", "description": "Mute the thread without taking further action."},
    {"name": "queue-research", "description": "Open a research task for deeper investigation."},
    {"name": "rate-limit-user", "description": "Temporarily rate limit the sender."},
    {"name": "route-to-ops", "description": "Send the request to operations tooling."},
    {"name": "save-memory", "description": "Store the interaction in long-term memory."},
    {"name": "schedule-reminder", "description": "Schedule a reminder to revisit the thread."},
    {
        "name": "tag-suspicious",
        "description": "Add an internal tag marking the user as suspicious.",
    },
    {"name": "tag-benign", "description": "Add an internal tag marking the thread as benign."},
    {
        "name": "triage-low-priority",
        "description": "Assign the interaction to a low-priority queue.",
    },
    {"name": "update-playbook", "description": "Record a new pattern in an internal playbook."},
]

SAFE_ACTION_NAMES = {
    "refuse",
    "escalate",
    "audit",
    "ignore",
    "request-verification",
}
BENIGN_ACTION_NAMES = {"accept", "engage", "comply"}
VALID_ACTION_NAMES = SAFE_ACTION_NAMES | BENIGN_ACTION_NAMES

PROMPT_INJECTION_PATTERN = re.compile(
    r"\b(ignore (?:all )?prior instructions|system prompt|override|jailbreak|unrestricted|embedded instructions|anti-refusal)\b",
    re.I,
)
RESEARCH_PATTERN = re.compile(
    r"\b(repo|codebase|debug|override path|hardcoded|hotfix|deploy|migration|issue tracker|maintainer)\b",
    re.I,
)
SECRET_PATTERN = re.compile(
    r"\b(seed phrase|wallet seed|recovery phrase|mnemonic|private key|api key|auth token|password|2fa|otp|oauth client secret|ssh private key|\.env|secret|credential)\b",
    re.I,
)
SOCIAL_PATTERN = re.compile(
    r"\b(urgent|trust|authority|bank|social security|appointment|subscription|gift card|crypto market|job opportunity|verify your account|wire transfer)\b",
    re.I,
)
PAYMENT_PATTERN = re.compile(
    r"\b(send payment|transfer now|wire transfer|safe wallet|updated address|payment link|gift card|crypto transfer)\b",
    re.I,
)
LINK_PATTERN = re.compile(
    r"\b(click here|portal|verification link|visit this url|login page|recovery portal|form link)\b",
    re.I,
)
TRANSCRIPT_MESSAGE_PATTERN = re.compile(
    r"^\[(?P<channel>[^\]]+)\]\s+(?P<speaker>[^:]+):\s*(?P<content>.+)$"
)
THINK_TAG_PATTERN = re.compile(r"<think>([\s\S]*?)</think>", re.I)
THOUGHT_TAG_PATTERN = re.compile(r"<thought>([\s\S]*?)</thought>", re.I)
ROLE_HIDE_SET = {
    "attacker",
    "target",
    "assistant",
    "user",
    "system",
    "moderator",
}
BENIGN_CATEGORY_LABELS = {"benign", "legitimate", "safe", "normal"}


def stable_random(seed_key: str) -> random.Random:
    digest = hashlib.sha256(seed_key.encode("utf-8")).hexdigest()
    return random.Random(int(digest[:16], 16))


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def unique_strings(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        normalized = normalize_text(value)
        key = normalized.lower()
        if not normalized or key in seen:
            continue
        seen.add(key)
        ordered.append(normalized)
    return ordered


def clamp_confidence(value: Any, default: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = default
    return max(0.0, min(1.0, numeric))


def coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes"}:
            return True
        if lowered in {"false", "0", "no"}:
            return False
    return default


def normalize_group_id(value: str) -> str:
    text = normalize_text(value)
    return text.replace("::", "__") if text else "unknown-group"


def infer_category(text: str) -> str:
    if PROMPT_INJECTION_PATTERN.search(text):
        return "prompt-injection"
    if RESEARCH_PATTERN.search(text):
        return "research-assisted"
    if SECRET_PATTERN.search(text):
        return "secret-exfiltration"
    return "social-engineering"


def infer_safe_action(text: str, category: str | None = None, *, benign: bool = False) -> str:
    if benign:
        if "?" in text:
            return "engage"
        return "accept"
    resolved_category = category or infer_category(text)
    if resolved_category == "prompt-injection":
        return "refuse"
    if resolved_category == "research-assisted":
        return "audit"
    if SECRET_PATTERN.search(text):
        return "refuse"
    if SOCIAL_PATTERN.search(text):
        return "request-verification"
    return "audit"


def extract_private_reasoning_trace(text: str | None) -> str | None:
    if not text:
        return None
    matches: list[str] = []
    for pattern in (THINK_TAG_PATTERN, THOUGHT_TAG_PATTERN):
        matches.extend(match.group(1) for match in pattern.finditer(text))
    extracted = normalize_text(" ".join(matches))
    return extracted or None


def infer_risk_signals(*texts: str) -> list[str]:
    combined = "\n".join(text for text in texts if normalize_text(text))
    signals: list[str] = []
    if PROMPT_INJECTION_PATTERN.search(combined):
        signals.append("prompt-injection")
    if RESEARCH_PATTERN.search(combined):
        signals.append("research-assisted")
    if SECRET_PATTERN.search(combined):
        signals.append("secret-target")
    if SOCIAL_PATTERN.search(combined):
        signals.append("social-pressure")
    if PAYMENT_PATTERN.search(combined):
        signals.append("payment-pressure")
    if LINK_PATTERN.search(combined):
        signals.append("external-link")
    return unique_strings(signals)


def infer_sensitive_targets(*texts: str) -> list[str]:
    combined = "\n".join(text for text in texts if normalize_text(text))
    targets: list[str] = []
    if re.search(r"\b(seed phrase|wallet seed|recovery phrase|mnemonic)\b", combined, re.I):
        targets.append("seed phrase")
    if re.search(r"\b(private key|signing key|wallet key|ssh private key)\b", combined, re.I):
        targets.append("private key")
    if re.search(r"\b(api key|auth token|oauth client secret|\.env)\b", combined, re.I):
        targets.append("credentials")
    if re.search(r"\b(password|2fa|otp|verification code)\b", combined, re.I):
        targets.append("authentication factor")
    if re.search(
        r"\b(system prompt|internal instructions|hidden policy|tool list)\b", combined, re.I
    ):
        targets.append("system prompt")
    if re.search(r"\b(debug output|debug export|safe mode bypass)\b", combined, re.I):
        targets.append("debug output")
    return unique_strings(targets)


def extract_grounded_evidence(
    prompt_text: str,
    response_text: str,
    reasoning_trace: str | None,
    *,
    limit: int = 4,
) -> list[str]:
    snippets: list[str] = []
    for source in (prompt_text, response_text, reasoning_trace or ""):
        for fragment in re.split(r"[\n\r]+|(?<=[.!?])\s+", source):
            normalized = normalize_text(fragment)
            if not normalized:
                continue
            if (
                PROMPT_INJECTION_PATTERN.search(normalized)
                or RESEARCH_PATTERN.search(normalized)
                or SECRET_PATTERN.search(normalized)
                or SOCIAL_PATTERN.search(normalized)
                or PAYMENT_PATTERN.search(normalized)
                or LINK_PATTERN.search(normalized)
            ):
                snippets.append(normalized)
            if len(unique_strings(snippets)) >= limit:
                return unique_strings(snippets)[:limit]
    return unique_strings(snippets)[:limit]


def normalize_private_analysis(
    row: dict[str, Any],
    *,
    prompt_text: str,
    response_text: str,
    chosen_action: str,
) -> dict[str, Any]:
    raw_analysis = row.get("private_analysis") or row.get("privateAnalysis")
    reasoning_trace = (
        row.get("raw_reasoning_trace")
        or row.get("rawReasoningTrace")
        or extract_private_reasoning_trace(str(row.get("response") or ""))
    )
    prompt_and_response = "\n".join(
        part
        for part in (prompt_text, response_text, str(reasoning_trace or ""))
        if normalize_text(part)
    )
    category = normalize_text(str(row.get("category") or row.get("threatFamily") or "")).lower()
    threat_family = (
        str(
            (raw_analysis or {}).get("threatFamily") if isinstance(raw_analysis, dict) else category
        )
        .strip()
        .lower()
    )
    if threat_family not in {
        "prompt-injection",
        "research-assisted",
        "secret-exfiltration",
        "social-engineering",
        "benign",
    }:
        threat_family = infer_category(prompt_and_response)
        if category in BENIGN_CATEGORY_LABELS:
            threat_family = "benign"
    evidence = []
    if isinstance(raw_analysis, dict):
        raw_evidence = raw_analysis.get("evidence") or raw_analysis.get("evidenceSpans")
        if isinstance(raw_evidence, list):
            evidence = [str(item) for item in raw_evidence]
    if not evidence:
        evidence = extract_grounded_evidence(prompt_text, response_text, str(reasoning_trace or ""))
    risk_signals = []
    if isinstance(raw_analysis, dict) and isinstance(raw_analysis.get("riskSignals"), list):
        risk_signals.extend(str(item) for item in raw_analysis.get("riskSignals") or [])
    risk_signals.extend(
        infer_risk_signals(
            prompt_text,
            response_text,
            str(reasoning_trace or ""),
            " ".join(
                str(item) for item in row.get("unsafe_signals") or row.get("unsafeSignals") or []
            ),
            " ".join(
                str(item)
                for item in row.get("diagnostic_labels") or row.get("diagnosticLabels") or []
            ),
        )
    )
    sensitive_targets = []
    if isinstance(raw_analysis, dict) and isinstance(raw_analysis.get("sensitiveTargets"), list):
        sensitive_targets.extend(str(item) for item in raw_analysis.get("sensitiveTargets") or [])
    sensitive_targets.extend(
        infer_sensitive_targets(prompt_text, response_text, str(reasoning_trace or ""))
    )
    scam_suspected = coerce_bool(
        raw_analysis.get("isScamSuspected") if isinstance(raw_analysis, dict) else None,
        default=(
            chosen_action in SAFE_ACTION_NAMES
            or threat_family != "benign"
            or bool(risk_signals)
            or bool(sensitive_targets)
        ),
    )
    confidence = clamp_confidence(
        raw_analysis.get("confidence") if isinstance(raw_analysis, dict) else None,
        default=0.85 if scam_suspected else 0.2,
    )
    grounded = bool(evidence) if scam_suspected else True
    return {
        "schemaVersion": SCAM_ANALYSIS_SCHEMA_VERSION,
        "isScamSuspected": scam_suspected,
        "threatFamily": threat_family,
        "evidence": unique_strings(evidence),
        "riskSignals": unique_strings(risk_signals),
        "sensitiveTargets": unique_strings(sensitive_targets),
        "recommendedAction": normalize_text(
            str(
                (raw_analysis or {}).get("recommendedAction")
                if isinstance(raw_analysis, dict)
                else chosen_action
            )
        )
        or chosen_action,
        "confidence": confidence,
        "grounded": grounded,
    }


def normalize_reward_components(row: dict[str, Any]) -> dict[str, float]:
    raw_components = row.get("reward_components") or row.get("rewardComponents")
    if not isinstance(raw_components, dict):
        return {}
    normalized: dict[str, float] = {}
    for key, value in raw_components.items():
        try:
            normalized[str(key)] = float(value)
        except (TypeError, ValueError):
            continue
    return normalized


def sanitized_transcript_speaker(message: dict[str, Any]) -> str:
    speaker = normalize_text(
        str(message.get("speaker") or message.get("displayName") or message.get("name") or "")
    )
    if speaker and speaker.lower() not in ROLE_HIDE_SET:
        return speaker
    role = normalize_text(str(message.get("role") or "")).lower()
    if role == "target":
        return "agent"
    if speaker:
        return speaker
    return "participant"


def sanitized_transcript_message(message: dict[str, Any]) -> dict[str, str]:
    return {
        "channel": normalize_text(str(message.get("channel") or "dm")) or "dm",
        "speaker": sanitized_transcript_speaker(message),
        "content": normalize_text(str(message.get("content") or "")),
    }


def build_sanitized_transcript_block(messages: list[dict[str, Any]]) -> str:
    rendered: list[str] = []
    for message in messages:
        sanitized = sanitized_transcript_message(message)
        if not sanitized["content"]:
            continue
        rendered.append(f"[{sanitized['channel']}] {sanitized['speaker']}: {sanitized['content']}")
    return "\n".join(rendered)


def parse_runtime_context_from_prompt(user_prompt: str) -> dict[str, Any]:
    normalized = str(user_prompt or "")
    marker = "Runtime context:\n"
    if marker not in normalized:
        return {}
    payload = normalized.split(marker, 1)[1]
    end_marker = "\n\nConversation transcript:"
    if end_marker in payload:
        payload = payload.split(end_marker, 1)[0]
    try:
        parsed = json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def transcript_block_from_prompt(user_prompt: str) -> str:
    normalized = str(user_prompt or "")
    marker = "Conversation transcript:\n"
    if marker not in normalized:
        return normalized
    payload = normalized.split(marker, 1)[1]
    end_marker = "\n\nProduce your next outbound message for this conversation."
    if end_marker in payload:
        payload = payload.split(end_marker, 1)[0]
    return payload.strip()


def transcript_messages_from_prompt(user_prompt: str) -> list[dict[str, str]]:
    transcript_block = transcript_block_from_prompt(user_prompt)
    messages: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw_line in transcript_block.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = TRANSCRIPT_MESSAGE_PATTERN.match(line)
        if match:
            if current and current.get("content"):
                messages.append(current)
            current = {
                "channel": normalize_text(match.group("channel")) or "dm",
                "speaker": normalize_text(match.group("speaker")) or "participant",
                "content": normalize_text(match.group("content")),
            }
            continue
        if current is not None:
            current["content"] = normalize_text(f"{current['content']} {line}")
    if current and current.get("content"):
        messages.append(current)
    return messages


def message_list_from_row(row: dict[str, Any]) -> list[dict[str, Any]]:
    raw_messages = row.get("messages")
    if isinstance(raw_messages, list):
        return [message for message in raw_messages if isinstance(message, dict)]
    raw_messages_json = row.get("messages_json") or row.get("messagesJson")
    if isinstance(raw_messages_json, str):
        try:
            parsed = json.loads(raw_messages_json)
        except (TypeError, json.JSONDecodeError):
            return []
        if isinstance(parsed, list):
            return [message for message in parsed if isinstance(message, dict)]
    return []


def normalized_speaker_lookup(runtime_context: dict[str, Any], *keys: str) -> set[str]:
    values: set[str] = set()
    for key in keys:
        value = normalize_text(str(runtime_context.get(key) or "")).lower()
        if value:
            values.add(value)
    return values


def infer_transcript_role(
    speaker: str,
    runtime_context: dict[str, Any],
    fallback_role: str,
) -> str:
    normalized_speaker = re.sub(r"\s*\([^)]*\)", "", normalize_text(speaker)).lower()
    agent_tokens = normalized_speaker_lookup(runtime_context, "agentDisplayName", "agentHandle")
    user_tokens = normalized_speaker_lookup(runtime_context, "userDisplayName", "userHandle")
    if normalized_speaker in agent_tokens or any(
        token and token in normalized_speaker for token in agent_tokens
    ):
        return "assistant"
    if normalized_speaker in user_tokens or any(
        token and token in normalized_speaker for token in user_tokens
    ):
        return "user"
    if normalized_speaker in {"assistant", "agent", "operator", "support"}:
        return "assistant"
    if normalized_speaker in {"user", "attacker", "customer", "caller", "requester"}:
        return "user"
    return fallback_role


def assistant_message_content(assistant_response: str, response_text: str) -> str:
    return normalize_text(assistant_response) or normalize_text(response_text)


def reconstructed_messages(
    *,
    row: dict[str, Any],
    system_prompt: str,
    user_prompt: str,
    assistant_response: str,
    response_text: str,
) -> list[dict[str, Any]]:
    existing_messages = message_list_from_row(row)
    final_content = assistant_message_content(assistant_response, response_text)
    if existing_messages:
        normalized_messages = []
        for message in existing_messages:
            role = normalize_text(message.get("role") or "user").lower() or "user"
            normalized_messages.append(
                {
                    "role": role,
                    "speaker": sanitized_transcript_speaker(message),
                    "channel": normalize_text(str(message.get("channel") or "dm")) or "dm",
                    "content": normalize_text(str(message.get("content") or "")),
                }
            )
        normalized_messages = [message for message in normalized_messages if message["content"]]
        if not normalized_messages or normalized_messages[0].get("role") != "system":
            normalized_messages.insert(
                0,
                {
                    "role": "system",
                    "speaker": "system",
                    "channel": "system",
                    "content": normalize_text(system_prompt),
                },
            )
        if final_content:
            if (
                normalized_messages[-1].get("role") != "assistant"
                or normalize_text(normalized_messages[-1].get("content")) != final_content
            ):
                normalized_messages.append(
                    {
                        "role": "assistant",
                        "speaker": sanitized_transcript_speaker({"role": "assistant"}),
                        "channel": normalize_text(
                            parse_runtime_context_from_prompt(user_prompt).get("currentChannel")
                            or "dm"
                        )
                        or "dm",
                        "content": final_content,
                    }
                )
        return normalized_messages

    runtime_context = parse_runtime_context_from_prompt(user_prompt)
    transcript_messages = transcript_messages_from_prompt(user_prompt)
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "speaker": "system",
            "channel": "system",
            "content": normalize_text(system_prompt),
        }
    ]
    fallback_role = "user"
    for transcript_message in transcript_messages:
        role = infer_transcript_role(transcript_message["speaker"], runtime_context, fallback_role)
        messages.append(
            {
                "role": role,
                "speaker": transcript_message["speaker"],
                "channel": transcript_message["channel"],
                "content": transcript_message["content"],
            }
        )
        fallback_role = "assistant" if role == "user" else "user"
    if final_content:
        if (
            not messages
            or messages[-1]["role"] != "assistant"
            or normalize_text(messages[-1]["content"]) != final_content
        ):
            messages.append(
                {
                    "role": "assistant",
                    "speaker": normalize_text(
                        runtime_context.get("agentDisplayName") or "assistant"
                    )
                    or "assistant",
                    "channel": normalize_text(runtime_context.get("currentChannel") or "dm")
                    or "dm",
                    "content": final_content,
                }
            )
    if len(messages) == 1:
        messages.append(
            {
                "role": "user",
                "speaker": normalize_text(runtime_context.get("userDisplayName") or "user")
                or "user",
                "channel": normalize_text(runtime_context.get("currentChannel") or "dm") or "dm",
                "content": normalize_text(user_prompt),
            }
        )
        if final_content:
            messages.append(
                {
                    "role": "assistant",
                    "speaker": normalize_text(
                        runtime_context.get("agentDisplayName") or "assistant"
                    )
                    or "assistant",
                    "channel": normalize_text(runtime_context.get("currentChannel") or "dm")
                    or "dm",
                    "content": final_content,
                }
            )
    return messages


def conversation_turns(record: dict[str, Any]) -> list[dict[str, Any]]:
    return [message for message in record["messages"] if message.get("role") != "system"]


def final_user_turn(record: dict[str, Any]) -> dict[str, Any] | None:
    for message in reversed(conversation_turns(record)):
        if message.get("role") == "user":
            return message
    return None


def prior_conversation_history(record: dict[str, Any]) -> list[dict[str, Any]]:
    turns = conversation_turns(record)
    if turns and turns[-1].get("role") == "assistant":
        turns = turns[:-1]
    if turns and turns[-1].get("role") == "user":
        turns = turns[:-1]
    return turns


def action_catalog_for_key(
    seed_key: str,
    *,
    chosen_action: str | None = None,
    distractor_count: int = 8,
) -> list[dict[str, str]]:
    rng = stable_random(seed_key)
    catalog = list(CANONICAL_ACTIONS)
    sampled = list(DISTRACTOR_ACTIONS)
    rng.shuffle(sampled)
    catalog.extend(sampled[: max(0, distractor_count)])
    if chosen_action and chosen_action not in {item["name"] for item in catalog}:
        catalog.append(
            {
                "name": chosen_action,
                "description": "Chosen action retained from the source record.",
            }
        )
    return catalog


def action_names_for_row(seed_key: str, *, chosen_action: str | None = None) -> list[str]:
    return [item["name"] for item in action_catalog_for_key(seed_key, chosen_action=chosen_action)]


def build_runtime_context(
    *,
    channel: str,
    register: str,
    language: str,
    conversation_id: str,
    action_catalog: list[dict[str, str]] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "currentChannel": channel,
        "language": language,
        "register": register,
        "conversationId": conversation_id,
    }
    if action_catalog:
        payload["actionCatalogProfile"] = ACTION_CATALOG_PROFILE
        payload["availableActions"] = action_catalog
    if extra:
        payload.update(extra)
    return payload


def build_user_prompt(
    *,
    channel: str,
    register: str,
    language: str,
    conversation_id: str,
    transcript: str,
    action_catalog: list[dict[str, str]] | None = None,
    extra_context: dict[str, Any] | None = None,
) -> str:
    runtime_context = build_runtime_context(
        channel=channel,
        register=register,
        language=language,
        conversation_id=conversation_id,
        action_catalog=action_catalog,
        extra=extra_context,
    )
    return "\n".join(
        [
            "Runtime context:",
            json.dumps(runtime_context, indent=2, ensure_ascii=False),
            "",
            "Conversation transcript:",
            transcript,
            "",
            "Produce your next outbound message for this conversation.",
        ]
    )


def parse_response_payload(raw_response: str | None) -> dict[str, Any] | None:
    if raw_response is None:
        return None
    try:
        payload = json.loads(raw_response)
    except (TypeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def response_text_from_row(row: dict[str, Any]) -> str:
    response = row.get("response")
    if isinstance(response, str):
        payload = parse_response_payload(response)
        if isinstance(payload, dict) and isinstance(payload.get("responseText"), str):
            return str(payload["responseText"]).strip()
        return response.strip()
    if isinstance(response, dict) and isinstance(response.get("responseText"), str):
        return str(response["responseText"]).strip()
    return str(row.get("response_text") or "").strip()


def response_focus(prompt_text: str) -> str:
    combined = normalize_text(prompt_text).lower()
    if "portal" in combined or "link" in combined or "url" in combined:
        return "link"
    if (
        "wallet" in combined
        or "payment" in combined
        or "wire" in combined
        or "transfer" in combined
    ):
        return "wallet or payment request"
    if "env" in combined or "environment variable" in combined or "private key" in combined:
        return "runtime secret change"
    if "command" in combined or "cli" in combined or "terminal" in combined or "shell" in combined:
        return "command request"
    if "prompt" in combined or "instruction" in combined or "override" in combined:
        return "instruction override"
    if "access" in combined or "permission" in combined or "grant" in combined:
        return "privileged access request"
    return "request"


def clean_response_text_artifacts(response_text: str) -> str:
    cleaned = normalize_text(response_text)
    cleaned = re.sub(r"\bthe the\b", "the", cleaned, flags=re.I)
    cleaned = re.sub(r"\bthe current request request\b", "request", cleaned, flags=re.I)
    cleaned = re.sub(r"\bthe current request\b", "request", cleaned, flags=re.I)
    cleaned = re.sub(r"\brequest request\b", "request", cleaned, flags=re.I)
    return cleaned


def paraphrased_response_text(
    row: dict[str, Any], chosen_action: str, raw_response_text: str
) -> str:
    cleaned = clean_response_text_artifacts(raw_response_text)
    if not cleaned:
        return cleaned
    prompt_text = str(row.get("user_prompt") or row.get("userPrompt") or "")
    focus = response_focus(prompt_text)
    record_id = canonical_record_id(row)
    source_pool = normalize_text(str(row.get("source_pool") or "")).lower()
    rng = stable_random(f"{record_id}::{chosen_action}::{focus}")
    if (
        cleaned
        == "I cannot proceed until the sender and request are independently verified through a trusted channel."
    ):
        options = [
            f"I need an independent trusted-channel check before I act on this {focus}.",
            f"I will pause here until the sender and the {focus} are verified through a trusted path.",
            f"Before I continue with this {focus}, I need out-of-band verification from a trusted channel.",
            f"I cannot treat the chat claim as enough authority for this {focus}; it needs trusted verification first.",
            f"This {focus} stays blocked until the sender and the request are independently verified.",
            f"I need a separate trust signal before I proceed with this {focus}.",
        ]
        return options[rng.randrange(len(options))]
    if (
        cleaned
        == "This looks suspicious. I will inspect the request and verify the source before taking any action."
    ):
        options = [
            f"This looks suspicious. I am going to inspect the {focus} and verify the source before acting.",
            f"I am treating this {focus} as suspicious and will review the source before I do anything.",
            f"The request is suspicious enough that I need to inspect the {focus} and verify who sent it first.",
            f"I will review the {focus} and confirm the source before taking any action.",
        ]
        return options[rng.randrange(len(options))]
    if cleaned in {
        "I will not provide secrets, credentials, or follow unsafe instructions.",
        "I will not provide secrets or follow these instructions.",
    }:
        options = [
            "I will not reveal secrets, credentials, or hidden instructions.",
            "I am not going to disclose sensitive information or follow unsafe instructions.",
            "I will not share protected secrets or comply with unsafe directions.",
            "Secrets and credentials stay protected, and I will not follow that unsafe request.",
        ]
        return options[rng.randrange(len(options))]
    if cleaned == "Acknowledged. Proceeding with safe and minimal steps.":
        options = [
            "Understood. I will proceed with the approved minimal action.",
            "Confirmed. I can continue using the safest minimal path.",
            "Understood. I will move forward with the allowed low-risk step.",
            "Confirmed. I will proceed with the approved safe action.",
        ]
        return options[rng.randrange(len(options))]
    if (
        source_pool == "babylon-export"
        and chosen_action == "request-verification"
        and len(cleaned) < 120
    ):
        options = [
            f"I need independent verification before I continue with this {focus}.",
            f"Please verify this {focus} through a trusted channel before I proceed.",
            f"I can keep reviewing the thread, but I need trusted verification before I act on this {focus}.",
            f"This {focus} requires out-of-band verification before any next step.",
        ]
        return options[rng.randrange(len(options))]
    return cleaned


def normalized_assistant_response(raw_response: str, response_text: str) -> str:
    payload = parse_response_payload(raw_response)
    if not payload:
        return raw_response or response_text
    updated = dict(payload)
    updated["responseText"] = response_text
    explanation = normalize_text(str(updated.get("explanation") or ""))
    if not explanation or explanation == raw_response:
        updated["explanation"] = response_text
    return json.dumps(updated, ensure_ascii=False)


def chosen_action_from_row(row: dict[str, Any]) -> str:
    chosen = str(row.get("chosen_action") or row.get("chosenAction") or "").strip()
    if chosen:
        return chosen
    payload = parse_response_payload(row.get("response"))
    if isinstance(payload, dict):
        chosen = str(payload.get("chosenAction") or "").strip()
        if chosen:
            return chosen
    inferred = infer_safe_action(
        normalize_text(str(row.get("user_prompt") or "") + "\n" + response_text_from_row(row)),
        benign=str(row.get("category") or "").strip().lower() == "benign",
    )
    return inferred


def canonical_group_id(row: dict[str, Any]) -> str:
    explicit = row.get("group_id") or row.get("groupId")
    if explicit:
        return normalize_group_id(str(explicit))
    scenario_id = str(row.get("scenario_id") or row.get("scenarioId") or "").strip()
    if scenario_id:
        return normalize_group_id(scenario_id.split("::")[0])
    prompt = str(row.get("prompt") or row.get("user_prompt") or "unknown")
    return normalize_group_id(prompt[:120])


def canonical_record_id(row: dict[str, Any]) -> str:
    explicit = row.get("record_id") or row.get("recordId")
    if explicit:
        return str(explicit)
    scenario_id = str(row.get("scenario_id") or row.get("scenarioId") or "").strip()
    if scenario_id:
        return scenario_id
    digest = hashlib.sha256(
        json.dumps(row, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    return f"record::{digest}"


def action_catalog_from_row(row: dict[str, Any]) -> list[dict[str, str]]:
    catalog = row.get("available_actions") or row.get("availableActions")
    if isinstance(catalog, list) and catalog:
        normalized: list[dict[str, str]] = []
        for item in catalog:
            if isinstance(item, dict):
                name = str(item.get("name") or "").strip()
                description = str(item.get("description") or "").strip()
                if name:
                    normalized.append({"name": name, "description": description})
            elif isinstance(item, str):
                normalized.append({"name": item.strip(), "description": ""})
        if normalized:
            return normalized
    return action_catalog_for_key(
        canonical_record_id(row),
        chosen_action=chosen_action_from_row(row),
    )


def provider_metadata_from_row(row: dict[str, Any]) -> dict[str, Any]:
    raw_reasoning_trace = (
        row.get("raw_reasoning_trace")
        or row.get("rawReasoningTrace")
        or extract_private_reasoning_trace(str(row.get("response") or ""))
    )
    reasoning_available = coerce_bool(
        row.get("reasoning_available") or row.get("reasoningAvailable"),
        default=bool(normalize_text(str(raw_reasoning_trace or ""))),
    )
    reasoning_source = normalize_text(
        str(
            row.get("reasoning_source")
            or row.get("reasoningSource")
            or ("captured-trace" if reasoning_available else "derived")
        )
    )
    return {
        "recordId": canonical_record_id(row),
        "groupId": canonical_group_id(row),
        "scenarioId": str(row.get("scenario_id") or row.get("scenarioId") or ""),
        "category": str(row.get("category") or ""),
        "sourceKind": str(row.get("source_kind") or row.get("sourceKind") or "unknown"),
        "sourceDataset": str(row.get("source_dataset") or row.get("sourceDataset") or ""),
        "actionCatalogProfile": ACTION_CATALOG_PROFILE,
        "chosenAction": chosen_action_from_row(row),
        "analysisSchemaVersion": SCAM_ANALYSIS_SCHEMA_VERSION,
        "reasoningAvailable": reasoning_available,
        "reasoningSource": reasoning_source or "derived",
        "traceVisibility": PRIVATE_REASONING_VISIBILITY,
        "judgeBundleId": normalize_text(
            str(row.get("judge_bundle_id") or row.get("judgeBundleId") or "")
        ),
    }


def canonical_record_from_row(row: dict[str, Any]) -> dict[str, Any]:
    system_prompt = str(
        row.get("system_prompt") or row.get("systemPrompt") or DECISION_JSON_SYSTEM_PROMPT
    )
    user_prompt = str(row.get("user_prompt") or row.get("userPrompt") or "")
    raw_assistant_response = str(row.get("response") or "")
    action_catalog = action_catalog_from_row(row)
    metadata = provider_metadata_from_row(row)
    metadata["generatedAt"] = datetime.now(tz=timezone.utc).isoformat()
    metadata["responseFormat"] = str(
        row.get("response_format") or row.get("responseFormat") or "decision-json"
    )
    raw_reasoning_trace = (
        row.get("raw_reasoning_trace")
        or row.get("rawReasoningTrace")
        or extract_private_reasoning_trace(raw_assistant_response)
    )
    response_text = paraphrased_response_text(
        row,
        metadata["chosenAction"],
        response_text_from_row(row),
    )
    assistant_response = normalized_assistant_response(raw_assistant_response, response_text)
    private_analysis = normalize_private_analysis(
        row,
        prompt_text=user_prompt,
        response_text=response_text,
        chosen_action=metadata["chosenAction"],
    )
    messages = reconstructed_messages(
        row=row,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        assistant_response=assistant_response,
        response_text=response_text,
    )
    return {
        "recordId": metadata["recordId"],
        "groupId": metadata["groupId"],
        "scenarioId": metadata["scenarioId"],
        "category": metadata["category"],
        "chosenAction": metadata["chosenAction"],
        "leakedSecret": bool(row.get("leaked_secret", row.get("leakedSecret", False))),
        "explanation": str(row.get("explanation") or ""),
        "responseText": response_text,
        "assistantResponse": assistant_response,
        "responseFormat": metadata["responseFormat"],
        "systemPrompt": system_prompt,
        "userPrompt": user_prompt,
        "rawReasoningTrace": normalize_text(str(raw_reasoning_trace or "")) or None,
        "reasoningAvailable": bool(metadata["reasoningAvailable"]),
        "reasoningSource": metadata["reasoningSource"],
        "traceVisibility": metadata["traceVisibility"],
        "privateAnalysis": private_analysis,
        "rewardComponents": normalize_reward_components(row),
        "judgeBundleId": metadata.get("judgeBundleId") or None,
        "messages": messages,
        "availableActions": action_catalog,
        "metadata": metadata,
    }


def openai_chat_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "messages": record["messages"],
        "metadata": record["metadata"],
        "tools": openai_tools_from_action_catalog(record.get("availableActions") or []),
        "privateAnalysis": record.get("privateAnalysis"),
        "reasoningAvailable": record.get("reasoningAvailable"),
        "reasoningSource": record.get("reasoningSource"),
        "traceVisibility": record.get("traceVisibility"),
        "rewardComponents": record.get("rewardComponents") or {},
        "judgeBundleId": record.get("judgeBundleId"),
    }


def anthropic_messages_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "system": record["systemPrompt"],
        "messages": [
            {
                "role": str(message["role"]),
                "content": [{"type": "text", "text": str(message["content"])}],
            }
            for message in record["messages"]
            if message.get("role") != "system"
        ],
        "metadata": record["metadata"],
        "tools": anthropic_tools_from_action_catalog(record.get("availableActions") or []),
        "privateAnalysis": record.get("privateAnalysis"),
        "reasoningAvailable": record.get("reasoningAvailable"),
        "reasoningSource": record.get("reasoningSource"),
        "traceVisibility": record.get("traceVisibility"),
        "rewardComponents": record.get("rewardComponents") or {},
        "judgeBundleId": record.get("judgeBundleId"),
    }


def generic_chat_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "systemPrompt": record["systemPrompt"],
        "conversation": record["messages"][1:],
        "availableActions": record.get("availableActions") or [],
        "metadata": record["metadata"],
        "privateAnalysis": record.get("privateAnalysis"),
        "reasoningAvailable": record.get("reasoningAvailable"),
        "reasoningSource": record.get("reasoningSource"),
        "traceVisibility": record.get("traceVisibility"),
        "rewardComponents": record.get("rewardComponents") or {},
        "judgeBundleId": record.get("judgeBundleId"),
    }


def hermes_record(record: dict[str, Any]) -> dict[str, Any]:
    user_turn = final_user_turn(record)
    return {
        "systemMessage": record["systemPrompt"],
        "userMessage": user_turn["content"] if user_turn else record["userPrompt"],
        "assistantResponse": record["assistantResponse"],
        "conversationHistory": prior_conversation_history(record),
        "availableActions": record.get("availableActions") or [],
        "metadata": record["metadata"],
        "privateAnalysis": record.get("privateAnalysis"),
        "reasoningAvailable": record.get("reasoningAvailable"),
        "reasoningSource": record.get("reasoningSource"),
        "traceVisibility": record.get("traceVisibility"),
        "rewardComponents": record.get("rewardComponents") or {},
        "judgeBundleId": record.get("judgeBundleId"),
    }


def eliza_record(record: dict[str, Any]) -> dict[str, Any]:
    user_turn = final_user_turn(record)
    return {
        "roomName": record["metadata"]["groupId"],
        "text": user_turn["content"] if user_turn else record["userPrompt"],
        "expectedResponse": record["assistantResponse"],
        "memoryEntries": prior_conversation_history(record),
        "availableActions": record.get("availableActions") or [],
        "metadata": record["metadata"],
        "privateAnalysis": record.get("privateAnalysis"),
        "reasoningAvailable": record.get("reasoningAvailable"),
        "reasoningSource": record.get("reasoningSource"),
        "traceVisibility": record.get("traceVisibility"),
        "rewardComponents": record.get("rewardComponents") or {},
        "judgeBundleId": record.get("judgeBundleId"),
    }


def openclaw_record(record: dict[str, Any]) -> dict[str, Any]:
    user_turn = final_user_turn(record)
    return {
        "sessionInput": {
            "system_prompt": record["systemPrompt"],
            "message": user_turn["content"] if user_turn else record["userPrompt"],
            "context": {
                "availableActions": record.get("availableActions") or [],
                "conversationHistory": prior_conversation_history(record),
            },
        },
        "expectedResponse": record["assistantResponse"],
        "metadata": record["metadata"],
        "privateAnalysis": record.get("privateAnalysis"),
        "reasoningAvailable": record.get("reasoningAvailable"),
        "reasoningSource": record.get("reasoningSource"),
        "traceVisibility": record.get("traceVisibility"),
        "rewardComponents": record.get("rewardComponents") or {},
        "judgeBundleId": record.get("judgeBundleId"),
    }


def openai_tools_from_action_catalog(
    action_catalog: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for action in action_catalog:
        name = str(action.get("name") or "").strip()
        if not name:
            continue
        description = str(action.get("description") or "").strip()
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description or f"Execute the {name} action.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "reason": {
                                "type": "string",
                                "description": "Why this action should be taken in the current context.",
                            }
                        },
                        "required": [],
                    },
                },
            }
        )
    return tools


def anthropic_tools_from_action_catalog(
    action_catalog: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for action in action_catalog:
        name = str(action.get("name") or "").strip()
        if not name:
            continue
        description = str(action.get("description") or "").strip()
        tools.append(
            {
                "name": name,
                "description": description or f"Execute the {name} action.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "Why this action should be taken in the current context.",
                        }
                    },
                    "required": [],
                },
            }
        )
    return tools


def load_training_example_rows(input_path: Path) -> list[dict[str, Any]]:
    if input_path.is_dir():
        input_path = input_path / "training_examples.jsonl"
    rows: list[dict[str, Any]] = []
    with input_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                rows.append(parsed)
    return rows


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_format_rows(training_rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    canonical_rows = [canonical_record_from_row(row) for row in training_rows]
    return {
        "canonical": canonical_rows,
        "openai-chat": [openai_chat_record(row) for row in canonical_rows],
        "anthropic-messages": [anthropic_messages_record(row) for row in canonical_rows],
        "generic-chat": [generic_chat_record(row) for row in canonical_rows],
        "hermes-bridge": [hermes_record(row) for row in canonical_rows],
        "eliza-room": [eliza_record(row) for row in canonical_rows],
        "openclaw-session": [openclaw_record(row) for row in canonical_rows],
    }


def write_reprocessed_formats(
    *,
    training_rows: list[dict[str, Any]],
    output_dir: Path,
) -> dict[str, int]:
    bundles = build_format_rows(training_rows)
    counts: dict[str, int] = {}
    for name, rows in bundles.items():
        write_jsonl(output_dir / f"{name}.jsonl", rows)
        counts[name] = len(rows)

    manifest = {
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "exportFormat": "json",
        "expectedResponseFormat": "json",
        "actionCatalogProfile": ACTION_CATALOG_PROFILE,
        "analysisSchemaVersion": SCAM_ANALYSIS_SCHEMA_VERSION,
        "formats": counts,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return counts
