"""Character evolution evaluator.

Analyzes conversations for character evolution opportunities. Runs after
conversations to identify patterns suggesting character growth, using a
two-tier approach: LLM-based trigger detection with regex fallback.
"""

from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING, Any

from elizaos.types import ActionResult, Evaluator, MemoryType, ModelType
from elizaos.utils.xml import parse_key_value_xml

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _parse_structured_record(response: str) -> dict[str, Any] | None:
    parsed = parse_key_value_xml(response)
    return parsed if _is_record(parsed) else None


def _normalize_boolean(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return None


def _normalize_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if value == value else None  # NaN check
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            return float(trimmed)
        except ValueError:
            return None
    return None


def _normalize_string_list(value: Any) -> list[str] | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    delimited = [entry.strip() for entry in trimmed.split("||") if entry.strip()]
    return delimited if delimited else None


def _coerce_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            try:
                return int(trimmed)
            except ValueError:
                return default
    return default


def parse_trigger_analysis(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "hasEvolutionTrigger": _normalize_boolean(raw.get("hasEvolutionTrigger")) or False,
        "triggerType": raw.get("triggerType", "unknown")
        if isinstance(raw.get("triggerType"), str)
        else "unknown",
        "reasoning": raw.get("reasoning", "") if isinstance(raw.get("reasoning"), str) else "",
        "confidence": _normalize_number(raw.get("confidence")) or 0,
    }


def build_modifications(raw: dict[str, Any]) -> dict[str, Any]:
    mods: dict[str, Any] = {}

    name = raw.get("name")
    if isinstance(name, str) and name.strip():
        mods["name"] = name.strip()

    system = raw.get("system")
    if isinstance(system, str) and system.strip():
        mods["system"] = system.strip()

    bio = _normalize_string_list(raw.get("bio"))
    if bio:
        mods["bio"] = bio

    topics = _normalize_string_list(raw.get("topics"))
    if topics:
        mods["topics"] = topics

    style: dict[str, list[str]] = {}
    for key, field in [("all", "style_all"), ("chat", "style_chat"), ("post", "style_post")]:
        items = _normalize_string_list(raw.get(field))
        if items:
            style[key] = items
    if style:
        mods["style"] = style

    return mods


def parse_evolution_analysis(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "shouldModify": _normalize_boolean(raw.get("shouldModify")) or False,
        "confidence": _normalize_number(raw.get("confidence")) or 0,
        "gradualChange": _normalize_boolean(raw.get("gradualChange"))
        if raw.get("gradualChange") is not None
        else True,
        "reasoning": raw.get("reasoning", "") if isinstance(raw.get("reasoning"), str) else "",
        "modifications": build_modifications(raw),
    }


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    # Skip if too recent since last evaluation
    last_check = await runtime.get_cache("character-evolution:last-check")
    now = int(time.time() * 1000)
    cooldown_ms = 5 * 60 * 1000  # 5 minutes

    if last_check:
        try:
            if now - _coerce_int(last_check) < cooldown_ms:
                return False
        except (ValueError, TypeError):
            pass

    # Only evaluate if conversation has substantial content
    if state and hasattr(state, "data") and isinstance(state.data, dict):
        msg_count = state.data.get("messageCount", 0)
        if isinstance(msg_count, (int, float)) and msg_count < 3:
            return False

    # Get recent messages for trigger detection
    recent_messages = await runtime.get_memories(
        {
            "roomId": str(message.room_id),
            "count": 10,
            "unique": True,
            "tableName": "messages",
        }
    )

    # LLM-based trigger detection
    conversation_text = "\n".join(
        f"{'Agent' if m.entity_id == runtime.agent_id else 'User'}: {m.content.text}"
        for m in recent_messages
        if hasattr(m, "content") and hasattr(m.content, "text") and m.content.text
    )

    trigger_prompt = f"""Analyze this conversation for character evolution triggers:

CONVERSATION:
{conversation_text}

TRIGGER ANALYSIS - Check for:

1. CONVERSATION SUCCESS PATTERNS
   - User engagement (long responses, follow-up questions)
   - Positive sentiment from user

2. KNOWLEDGE GAP DISCOVERY
   - Agent uncertainty or "I don't know" responses
   - User providing corrections or new information

3. PERSONALITY EFFECTIVENESS
   - User preferences for communication style
   - Emotional intelligence opportunities

4. VALUE CREATION OPPORTUNITIES
   - User goals mentioned that agent could help with better

5. EXPLICIT FEEDBACK
   - Direct requests for personality changes
   - User feedback about agent behavior

TOON only. Return exactly one TOON document. No prose before or after it.

Example:
hasEvolutionTrigger: true
triggerType: explicit_feedback
reasoning: User explicitly asked for a personality change
confidence: 0.85"""

    has_triggers = False
    try:
        trigger_response = await runtime.use_model(
            ModelType.TEXT_SMALL,
            prompt=trigger_prompt,
        )
        raw = _parse_structured_record(str(trigger_response))
        if raw:
            trigger = parse_trigger_analysis(raw)
            has_triggers = trigger["hasEvolutionTrigger"] and trigger["confidence"] > 0.6

            if has_triggers:
                logger.info(
                    "Evolution trigger detected: type=%s, reasoning=%s, confidence=%s",
                    trigger["triggerType"],
                    trigger["reasoning"],
                    trigger["confidence"],
                )
    except Exception:
        # Fallback to basic pattern matching
        has_triggers = any(
            any(
                kw in (m.content.text or "").lower()
                for kw in [
                    "you should",
                    "change your",
                    "different way",
                    "personality",
                    "behavior",
                    "remember that",
                    "from now on",
                ]
            )
            for m in recent_messages
            if hasattr(m, "content") and hasattr(m.content, "text")
        )

    return has_triggers


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> ActionResult | None:
    try:
        await runtime.set_cache(
            "character-evolution:last-check",
            str(int(time.time() * 1000)),
        )

        # Get recent conversation context
        recent_messages = await runtime.get_memories(
            {
                "roomId": str(message.room_id),
                "count": 20,
                "unique": True,
                "tableName": "messages",
            }
        )

        conversation_text = "\n".join(
            f"{runtime.character.name if m.entity_id == runtime.agent_id else 'User'}: {m.content.text}"
            for m in recent_messages[-10:]
            if hasattr(m, "content") and hasattr(m.content, "text") and m.content.text
        )

        character = runtime.character
        character_summary = {
            "name": getattr(character, "name", ""),
            "system": getattr(character, "system", "No system prompt defined"),
            "bio": getattr(character, "bio", []),
            "currentTopics": getattr(character, "topics", []) or [],
            "messageExampleCount": len(getattr(character, "message_examples", []) or []),
        }

        bio_list = character_summary["bio"]
        if isinstance(bio_list, str):
            bio_list = [bio_list]
        elif not isinstance(bio_list, list):
            bio_list = []
        current_topics = character_summary["currentTopics"]
        topics_list = current_topics if isinstance(current_topics, list) else []

        evolution_prompt = f"""You are conducting a comprehensive analysis to determine if an AI agent should evolve its character definition based on measurable patterns and outcomes.

CURRENT CHARACTER STATE:
Name: {character_summary["name"]}
System: {character_summary["system"]}
Bio: {"; ".join(str(b) for b in bio_list)}
Topics: {", ".join(str(t) for t in topics_list)}
Message Examples: {character_summary["messageExampleCount"]}

CONVERSATION TO ANALYZE:
{conversation_text}

EVOLUTION DECISION FRAMEWORK:
- Only suggest modifications that address measurable gaps
- Prioritize changes that improve user experience
- Ensure gradual, incremental evolution
- Maintain core personality while optimizing effectiveness
- Consider safety and appropriateness of all changes

MODIFICATION PRIORITIES:
- name: ONLY if a truly fitting identity emerges organically (very rare)
- system: ONLY for fundamental behavioral misalignment (rare)
- bio: New traits that emerge from successful interactions
- topics: Domains where agent showed interest/competence
- style: Communication preferences that enhance effectiveness

TOON only. Return exactly one TOON document. No prose before or after it.
Use || to separate list items within a field.

Example:
shouldModify: true
confidence: 0.75
gradualChange: true
reasoning: User consistently asks about sustainability topics that are not in the current character definition.
bio: Passionate about environmental sustainability || Knowledgeable about renewable energy
topics: climate change || solar energy || sustainable living
style_chat: Use encouraging tone when discussing environmental topics"""

        response = await runtime.use_model(
            ModelType.TEXT_LARGE,
            prompt=evolution_prompt,
        )

        raw = _parse_structured_record(str(response))
        if not raw:
            logger.warning("Failed to parse character evolution analysis")
            return None

        evolution = parse_evolution_analysis(raw)

        # Only proceed if modification is recommended with sufficient confidence
        if not evolution["shouldModify"] or evolution["confidence"] < 0.7:
            return None

        if not evolution.get("gradualChange", True):
            logger.info("Skipping character evolution - change too dramatic")
            return None

        # Store evolution suggestion for potential application
        await runtime.create_memory(
            {
                "entityId": str(runtime.agent_id),
                "roomId": str(message.room_id),
                "content": {
                    "text": f"Character evolution suggested (confidence: {evolution['confidence']}): {evolution['reasoning']}",
                    "source": "character_evolution",
                },
                "metadata": {
                    "type": MemoryType.CUSTOM,
                    "evaluatorName": "character-evolution",
                    "timestamp": int(time.time() * 1000),
                    "confidence": evolution["confidence"],
                    "evolutionData": json.dumps(
                        {
                            "shouldModify": evolution["shouldModify"],
                            "gradualChange": evolution.get("gradualChange", True),
                            "modifications": evolution["modifications"],
                        }
                    ),
                },
            },
            "character_evolution",
        )

        logger.info(
            "Character evolution analysis completed: shouldModify=%s, confidence=%s, reasoning=%s",
            evolution["shouldModify"],
            evolution["confidence"],
            str(evolution["reasoning"])[:100],
        )
    except Exception as e:
        logger.error("Error in character evolution evaluator: %s", e)

    return None


character_evolution_evaluator = Evaluator(
    name="CHARACTER_EVOLUTION",
    description="Analyzes conversations to identify opportunities for gradual character evolution and self-modification",
    always_run=False,
    validate=_validate,
    handler=_handler,
    examples=[
        {
            "prompt": "Evaluating character evolution after many conversations about environmental issues",
            "messages": [
                {"name": "{{user1}}", "content": {"text": "What can I do about climate change?"}},
                {
                    "name": "{{agentName}}",
                    "content": {
                        "text": "There are many ways to help, from reducing energy use to supporting renewable energy initiatives."
                    },
                },
            ],
            "outcome": "Character develops environmental expertise and adds sustainability topics",
        },
    ],
)
