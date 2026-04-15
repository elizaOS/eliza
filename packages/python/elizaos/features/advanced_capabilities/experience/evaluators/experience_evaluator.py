from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from elizaos.features.advanced_capabilities.experience.service import EXPERIENCE_SERVICE_TYPE
from elizaos.features.advanced_capabilities.experience.types import ExperienceType, OutcomeType
from elizaos.types import ActionResult, Evaluator, HandlerOptions, ModelType

if TYPE_CHECKING:
    from elizaos.types import Content, IAgentRuntime, Memory, State

logger = logging.getLogger("elizaos.experience")

# Domain detection keywords (matches TypeScript implementation)
_DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "shell": ["command", "terminal", "bash", "shell", "execute", "script", "cli"],
    "coding": [
        "code",
        "function",
        "variable",
        "syntax",
        "programming",
        "debug",
        "typescript",
        "javascript",
    ],
    "system": [
        "file",
        "directory",
        "process",
        "memory",
        "cpu",
        "system",
        "install",
        "package",
    ],
    "network": ["http", "api", "request", "response", "url", "network", "fetch", "curl"],
    "data": ["json", "csv", "database", "query", "data", "sql", "table"],
    "ai": ["model", "llm", "embedding", "prompt", "token", "inference"],
}

_EXPERIENCE_TYPE_MAP: dict[str, ExperienceType] = {
    "DISCOVERY": ExperienceType.DISCOVERY,
    "CORRECTION": ExperienceType.CORRECTION,
    "SUCCESS": ExperienceType.SUCCESS,
    "LEARNING": ExperienceType.LEARNING,
}

# Prompt template for extracting experiences from conversation
_EXTRACT_EXPERIENCES_TEMPLATE = """Analyze the following conversation context and extract any novel learning experiences.

Conversation context:
{{conversation_context}}

Existing experiences (to avoid duplicates):
{{existing_experiences}}

Extract experiences as a JSON array. Each experience should have:
- type: one of DISCOVERY, CORRECTION, SUCCESS, LEARNING
- learning: what was learned (concise, actionable)
- context: what was happening when this was learned
- confidence: 0-1 how confident in this learning
- reasoning: brief explanation of why this is notable

Return ONLY a JSON array, no other text. Return [] if no novel experiences found.
"""


def _detect_domain(text: str) -> str:
    """Detect the domain of an experience from its text content."""
    lower_text = text.lower()
    for domain, keywords in _DOMAIN_KEYWORDS.items():
        if any(keyword in lower_text for keyword in keywords):
            return domain
    return "general"


def _sanitize_context(text: str) -> str:
    """Remove user-specific details while preserving technical context."""
    if not text:
        return "Unknown context"

    result = text
    # emails
    result = re.sub(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", "[EMAIL]", result)
    # IP addresses
    result = re.sub(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "[IP]", result)
    # user directories
    result = re.sub(r"/Users/[^/\s]+", "/Users/[USER]", result)
    result = re.sub(r"/home/[^/\s]+", "/home/[USER]", result)
    # API keys/tokens
    result = re.sub(r"\b[A-Z0-9]{20,}\b", "[TOKEN]", result)
    # personal references
    result = re.sub(
        r"\b(user|person|someone|they)\s+(said|asked|told|mentioned)",
        "when asked",
        result,
        flags=re.IGNORECASE,
    )
    return result[:200]


def _parse_extracted_experiences(response: str) -> list[dict[str, object]]:
    """Parse JSON array of experiences from LLM response."""
    json_match = re.search(r"\[[\s\S]*\]", response)
    if not json_match:
        return []
    try:
        parsed = json.loads(json_match.group(0))
        if not isinstance(parsed, list):
            return []
        return [item for item in parsed if isinstance(item, dict)]
    except (json.JSONDecodeError, ValueError):
        return []


def _get_number_setting(runtime: IAgentRuntime, key: str, fallback: float) -> float:
    """Get a numeric setting from runtime, with fallback."""
    value = runtime.get_setting(key)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value)
            if parsed == parsed:  # check for NaN
                return parsed
        except ValueError:
            pass
    return fallback


def _coerce_int(value: object | None, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


async def _validate_experience_evaluator(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Only run every 25 messages and only on agent messages."""
    entity_id = getattr(message, "entity_id", None)
    if str(entity_id) != str(runtime.agent_id):
        return False

    # Check cooldown - only extract experiences every 25 messages to reduce token cost
    last_extraction_key = "experience-extraction:last-message-count"
    current_count_raw = await runtime.get_cache(last_extraction_key)
    current_count = _coerce_int(current_count_raw)
    new_message_count = current_count + 1

    await runtime.set_cache(last_extraction_key, str(new_message_count))

    # Trigger extraction every 25 messages
    should_extract = new_message_count % 25 == 0

    if should_extract:
        logger.info(
            "[experienceEvaluator] Triggering experience extraction after %d messages",
            new_message_count,
        )

    return should_extract


async def _handle_experience_evaluator(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: Callable[[Content], Awaitable[list[Memory]]] | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult | None:
    """Extract novel learning experiences from recent conversation."""
    _ = options, callback, responses, state  # Unused parameters

    from elizaos.features.advanced_capabilities.experience.service import ExperienceService

    experience_service = runtime.get_service(EXPERIENCE_SERVICE_TYPE)
    if not isinstance(experience_service, ExperienceService):
        logger.warning("[experienceEvaluator] Experience service not available")
        return None

    room_id = getattr(message, "room_id", None)
    recent_messages = await runtime.get_memories(
        table_name="messages",
        room_id=str(room_id) if room_id else None,
        limit=10,
    )

    if len(recent_messages) < 3:
        logger.debug("[experienceEvaluator] Not enough messages for experience extraction")
        return None

    # Combine recent messages into analysis context
    conversation_parts: list[str] = []
    for m in recent_messages:
        if hasattr(m, "content") and m.content:
            text_val = getattr(m.content, "text", None)
            if text_val:
                conversation_parts.append(str(text_val))

    conversation_context = " ".join(conversation_parts)

    # Build extraction prompt
    extraction_prompt = _EXTRACT_EXPERIENCES_TEMPLATE.replace(
        "{{conversation_context}}", conversation_context
    ).replace("{{existing_experiences}}", "None")

    # Use TEXT_SMALL -- extraction is a structured JSON task, not complex reasoning
    response = await runtime.use_model(ModelType.TEXT_SMALL, prompt=extraction_prompt)

    experiences = _parse_extracted_experiences(str(response))
    threshold = _get_number_setting(runtime, "AUTO_RECORD_THRESHOLD", 0.6)

    # Record each novel experience (max 3 per extraction)
    recorded_count = 0
    for exp in experiences[:3]:
        learning = exp.get("learning")
        confidence = exp.get("confidence")

        if not learning or not isinstance(confidence, (int, float)) or confidence < threshold:
            continue

        learning_str = str(learning)

        # Post-extraction dedup: skip if a very similar experience already exists
        similar = await experience_service.find_similar_experiences(learning_str, 1)
        if similar:
            existing_learning = similar[0].learning.lower()
            new_learning = learning_str.lower()
            existing_words = {w for w in existing_learning.split() if len(w) > 3}
            new_words = {w for w in new_learning.split() if len(w) > 3}
            overlap = len(new_words & existing_words)
            union = len(existing_words | new_words)
            if union > 0 and overlap / union > 0.6:
                logger.debug(
                    '[experienceEvaluator] Skipping duplicate experience: "%s..."',
                    learning_str[:80],
                )
                continue

        normalized_type = str(exp.get("type", "")).upper()
        experience_type = _EXPERIENCE_TYPE_MAP.get(normalized_type, ExperienceType.LEARNING)

        await experience_service.record_experience(
            {
                "type": experience_type,
                "outcome": (
                    OutcomeType.POSITIVE
                    if experience_type == ExperienceType.CORRECTION
                    else OutcomeType.NEUTRAL
                ),
                "context": _sanitize_context(str(exp.get("context", "Conversation analysis"))),
                "action": "pattern_recognition",
                "result": learning_str,
                "learning": _sanitize_context(learning_str),
                "domain": _detect_domain(learning_str),
                "tags": ["extracted", "novel", experience_type.value],
                "confidence": min(float(confidence), 0.9),  # Cap confidence
                "importance": 0.8,  # High importance for extracted experiences
            }
        )

        logger.info(
            "[experienceEvaluator] Recorded novel experience: %s...",
            learning_str[:100],
        )
        recorded_count += 1

    if recorded_count > 0:
        logger.info(
            "[experienceEvaluator] Extracted %d novel experiences from conversation",
            recorded_count,
        )
    else:
        logger.debug("[experienceEvaluator] No novel experiences found in recent conversation")

    return ActionResult(
        success=True,
        data={"extractedCount": recorded_count},
        values={"extractedCount": str(recorded_count)},
    )


experience_evaluator = Evaluator(
    name="EXPERIENCE_EVALUATOR",
    description="Periodically analyzes conversation patterns to extract novel learning experiences",
    handler=_handle_experience_evaluator,
    validate=_validate_experience_evaluator,
    similes=["experience recorder", "learning evaluator", "self-reflection"],
    always_run=False,
    examples=[],
)
