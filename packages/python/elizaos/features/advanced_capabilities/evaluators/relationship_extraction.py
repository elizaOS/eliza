from __future__ import annotations

import contextlib
import re
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from elizaos.generated.spec_helpers import require_evaluator_spec
from elizaos.types import (
    ActionResult,
    Component,
    Entity,
    Evaluator,
    EvaluatorResult,
    HandlerOptions,
)
from elizaos.types.primitives import string_to_uuid

if TYPE_CHECKING:
    from elizaos.types import Content, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_evaluator_spec("RELATIONSHIP_EXTRACTION")

# ---------------------------------------------------------------------------
# Platform identity patterns
# ---------------------------------------------------------------------------
X_HANDLE_PATTERN = re.compile(r"@[\w]+")
EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")
PHONE_PATTERN = re.compile(r"\+?[\d\s\-()]{10,}")
DISCORD_PATTERN = re.compile(r"[\w]+#\d{4}")
GITHUB_PATTERN = re.compile(r"github\.com/(\w+)|@(\w+)\s+on\s+github", re.IGNORECASE)

# ---------------------------------------------------------------------------
# Dispute detection patterns
# ---------------------------------------------------------------------------
_DISPUTE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"that'?s not (actually|really) their (\w+)", re.IGNORECASE),
    re.compile(r"no,?\s*(actually|really) it'?s (.+)", re.IGNORECASE),
    re.compile(r"you'?re wrong,?\s*it'?s (.+)", re.IGNORECASE),
    re.compile(r"that'?s incorrect", re.IGNORECASE),
    re.compile(r"that'?s wrong", re.IGNORECASE),
    re.compile(r"actually it'?s (.+?) not (.+)", re.IGNORECASE),
    re.compile(r"no,?\s*I said (.+)", re.IGNORECASE),
]

# ---------------------------------------------------------------------------
# Sentiment word lists
# ---------------------------------------------------------------------------
_POSITIVE_WORDS = [
    "thanks",
    "great",
    "good",
    "appreciate",
    "love",
    "helpful",
    "awesome",
    "wonderful",
    "excellent",
    "amazing",
    "fantastic",
    "brilliant",
    "kind",
    "generous",
    "happy",
    "glad",
    "pleased",
    "grateful",
]
_NEGATIVE_WORDS = [
    "harsh",
    "wrong",
    "bad",
    "terrible",
    "hate",
    "angry",
    "upset",
    "awful",
    "horrible",
    "annoying",
    "frustrating",
    "rude",
    "mean",
    "disgusting",
    "disappointed",
    "furious",
]

# ---------------------------------------------------------------------------
# Trust assessment patterns
# ---------------------------------------------------------------------------
_HELPFUL_PATTERN = re.compile(
    r"here'?s|let me help|i can help|try this|solution|answer",
    re.IGNORECASE,
)
_SUSPICIOUS_PATTERN = re.compile(
    r"delete all|give me access|send me your|password|private key"
    r"|update my permissions|i'?m the new admin|give me.*details|send me.*keys",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Privacy boundary patterns
# ---------------------------------------------------------------------------
_PRIVACY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"don'?t tell anyone", re.IGNORECASE), "doNotShare"),
    (re.compile(r"keep.{0,20}confidential", re.IGNORECASE), "confidential"),
    (re.compile(r"keep.{0,20}secret", re.IGNORECASE), "confidential"),
    (re.compile(r"don'?t mention", re.IGNORECASE), "doNotShare"),
    (re.compile(r"between you and me", re.IGNORECASE), "private"),
    (re.compile(r"off the record", re.IGNORECASE), "private"),
    (re.compile(r"this is confidential", re.IGNORECASE), "confidential"),
    (re.compile(r"don'?t share this", re.IGNORECASE), "doNotShare"),
    (re.compile(r"keep this between us", re.IGNORECASE), "private"),
    (re.compile(r"private", re.IGNORECASE), "private"),
]

# ---------------------------------------------------------------------------
# Mentioned-person extraction patterns
# ---------------------------------------------------------------------------
_PERSON_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(\w+ \w+) (?:is|was|works) (?:a|an|the|at|in) ([^.!?]+)", re.IGNORECASE),
    re.compile(r"(?:met|know|talked to) (\w+ \w+)", re.IGNORECASE),
    re.compile(r"(\w+)'s (birthday|email|phone|address) is ([^.!?]+)", re.IGNORECASE),
]
_STOP_WORDS = {"the", "and", "but", "for", "with", "this", "that", "from"}

# ---------------------------------------------------------------------------
# Admin update pattern
# ---------------------------------------------------------------------------
_ADMIN_UPDATE_PATTERN = re.compile(
    r"(?:update|set|change)\s+(\w+(?:\s+\w+)*)'?s?\s+(\w+)\s+(?:to|is|=)\s+(.+)",
    re.IGNORECASE,
)


def extract_platform_identities(text: str) -> list[dict[str, str | bool | float]]:
    """Extract platform identities (X, email, Discord, GitHub) from text."""
    identities: list[dict[str, str | bool | float]] = []
    now = time.time()

    for match in X_HANDLE_PATTERN.finditer(text):
        handle = match.group()
        if handle.lower() not in ("@here", "@everyone", "@channel"):
            identities.append(
                {
                    "platform": "x",
                    "handle": handle,
                    "verified": False,
                    "confidence": 0.7,
                    "timestamp": now,
                }
            )

    for match in EMAIL_PATTERN.finditer(text):
        identities.append(
            {
                "platform": "email",
                "handle": match.group(),
                "verified": False,
                "confidence": 0.9,
                "timestamp": now,
            }
        )

    for match in DISCORD_PATTERN.finditer(text):
        identities.append(
            {
                "platform": "discord",
                "handle": match.group(),
                "verified": False,
                "confidence": 0.8,
                "timestamp": now,
            }
        )

    for match in GITHUB_PATTERN.finditer(text):
        handle = match.group(1) or match.group(2)
        if handle:
            identities.append(
                {
                    "platform": "github",
                    "handle": handle,
                    "verified": False,
                    "confidence": 0.8,
                    "timestamp": now,
                }
            )

    return identities


def detect_relationship_indicators(text: str) -> list[dict[str, str | float]]:
    """Detect friend/colleague/family/community relationship indicators."""
    indicators: list[dict[str, str | float]] = []

    friend_patterns = [
        r"my friend",
        r"good friend",
        r"best friend",
        r"close friend",
        r"we're friends",
        r"thanks.*friend",
        r"you'?re a (great|good|true) friend",
        r"appreciate you",
        r"buddy|pal",
    ]
    for pattern in friend_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append(
                {
                    "type": "friend",
                    "sentiment": "positive",
                    "confidence": 0.8,
                    "context": text[:100],
                }
            )
            break

    colleague_patterns = [
        r"my colleague",
        r"coworker",
        r"co-worker",
        r"work together",
        r"at work",
        r"code review",
        r"project|meeting|deadline",
        r"team|department",
    ]
    for pattern in colleague_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append(
                {
                    "type": "colleague",
                    "sentiment": "neutral",
                    "confidence": 0.8,
                    "context": text[:100],
                }
            )
            break

    family_patterns = [
        r"my (brother|sister|mom|dad|mother|father|parent|son|daughter|child)",
        r"my family",
        r"family member",
    ]
    for pattern in family_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append(
                {
                    "type": "family",
                    "sentiment": "positive",
                    "confidence": 0.9,
                    "context": text[:100],
                }
            )
            break

    community_patterns = [
        r"community|group",
        r"event|meetup",
        r"member",
        r"contribute|volunteer",
        r"help with|count me in",
        r"together we can",
    ]
    for pattern in community_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append(
                {
                    "type": "community",
                    "sentiment": "positive",
                    "confidence": 0.6,
                    "context": text[:100],
                }
            )
            break

    return indicators


# ---------------------------------------------------------------------------
# 1. Dispute detection
# ---------------------------------------------------------------------------
def detect_disputes(
    text: str,
    recent_messages: list[Any] | None = None,
) -> list[dict[str, str | float]]:
    """Detect corrections or disputes in *text*.

    Returns a list of dicts, each with keys:
        disputed_field, correction, confidence
    """
    _ = recent_messages  # reserved for future context-aware matching
    results: list[dict[str, str | float]] = []
    for pattern in _DISPUTE_PATTERNS:
        m = pattern.search(text)
        if m:
            # Pull the first non-None captured group as the correction value
            correction = next((g for g in m.groups() if g), "unknown")
            results.append(
                {
                    "disputed_field": "platform_identity",
                    "correction": correction,
                    "confidence": 0.7,
                }
            )
    return results


# ---------------------------------------------------------------------------
# 2. Sentiment analysis
# ---------------------------------------------------------------------------
def analyze_sentiment(text: str) -> dict[str, Any]:
    """Determine positive/negative/neutral sentiment from word patterns.

    Returns ``{sentiment, score, indicators}``.
    """
    lower = text.lower()
    pos_hits = [w for w in _POSITIVE_WORDS if w in lower]
    neg_hits = [w for w in _NEGATIVE_WORDS if w in lower]

    pos_count = len(pos_hits)
    neg_count = len(neg_hits)
    total = pos_count + neg_count or 1

    if pos_count > neg_count:
        sentiment = "positive"
        score = pos_count / total
    elif neg_count > pos_count:
        sentiment = "negative"
        score = -(neg_count / total)
    else:
        sentiment = "neutral"
        score = 0.0

    return {
        "sentiment": sentiment,
        "score": round(score, 3),
        "indicators": pos_hits + neg_hits,
    }


# ---------------------------------------------------------------------------
# 3. Trust assessment
# ---------------------------------------------------------------------------
def assess_trust(text: str, entity_id: str) -> dict[str, Any]:
    """Evaluate helpfulness vs. suspicious behaviour in *text*.

    Returns ``{helpfulness, suspicion, indicators}``.
    """
    _ = entity_id  # may be used for per-entity history later
    indicators: list[str] = []
    helpful = 0.0
    suspicious = 0.0

    if _HELPFUL_PATTERN.search(text):
        helpful += 1.0
        indicators.append("helpful_language")

    if _SUSPICIOUS_PATTERN.search(text):
        suspicious += 2.0  # double weight, matching TS
        indicators.append("suspicious_language")

    return {
        "helpfulness": min(1.0, helpful),
        "suspicion": min(1.0, suspicious),
        "indicators": indicators,
    }


# ---------------------------------------------------------------------------
# 4. Privacy boundary detection
# ---------------------------------------------------------------------------
def detect_privacy_boundaries(text: str) -> list[dict[str, str | float]]:
    """Detect confidentiality / privacy markers in *text*.

    Returns a list of ``{type, content, confidence}``.
    """
    results: list[dict[str, str | float]] = []
    for pattern, privacy_type in _PRIVACY_PATTERNS:
        if pattern.search(text):
            results.append(
                {
                    "type": privacy_type,
                    "content": text,
                    "confidence": 0.8,
                }
            )
    return results


# ---------------------------------------------------------------------------
# 5. Mentioned-person extraction
# ---------------------------------------------------------------------------
def extract_mentioned_people(text: str) -> list[dict[str, str]]:
    """Extract third-party people mentioned in *text*.

    Returns a list of ``{name, context, relationship_type}``.
    """
    people: list[dict[str, str]] = []
    seen_names: set[str] = set()

    for pattern in _PERSON_PATTERNS:
        for m in pattern.finditer(text):
            name = m.group(1)
            if (
                name
                and len(name) > 3
                and name.lower() not in _STOP_WORDS
                and name.lower() not in seen_names
            ):
                seen_names.add(name.lower())
                people.append(
                    {
                        "name": name,
                        "context": m.group(0),
                        "relationship_type": "mentioned",
                    }
                )
    return people


# ---------------------------------------------------------------------------
# Runtime helpers (entity / component persistence)
# ---------------------------------------------------------------------------


async def _store_platform_identities(
    runtime: IAgentRuntime,
    entity_id: str,
    identities: list[dict[str, str | bool | float]],
) -> None:
    """Merge *identities* into the entity's metadata, deduplicating by platform+handle."""
    entity = await runtime.get_entity(entity_id)
    if not entity:
        return
    metadata = entity.metadata or {}
    existing: list[dict[str, Any]] = metadata.get("platformIdentities", [])
    if not isinstance(existing, list):
        existing = []

    existing_keys: set[str] = set()
    for ident in existing:
        if isinstance(ident, dict):
            existing_keys.add(f"{ident.get('platform')}|{ident.get('handle')}")

    for ident in identities:
        key = f"{ident['platform']}|{ident['handle']}"
        if key not in existing_keys:
            existing.append(ident)
            existing_keys.add(key)

    metadata["platformIdentities"] = existing
    entity.metadata = metadata
    await runtime.update_entity(entity)


async def _handle_disputes(
    runtime: IAgentRuntime,
    disputes: list[dict[str, str | float]],
    message: Memory,
) -> None:
    """Persist each dispute as a ``dispute_record`` component."""
    for dispute in disputes:
        await runtime.create_component(
            Component(
                id=str(string_to_uuid(f"dispute-{time.time()}-{message.entity_id}")),
                type="dispute_record",
                agent_id=str(runtime.agent_id),
                entity_id=str(message.entity_id),
                room_id=str(message.room_id),
                source_entity_id=str(message.entity_id),
                data={
                    "disputedField": dispute.get("disputed_field", "unknown"),
                    "correction": dispute.get("correction", "unknown"),
                    "confidence": dispute.get("confidence", 0.7),
                    "disputer": str(message.entity_id),
                },
                created_at=int(time.time() * 1000),
            )
        )
    runtime.logger.info(
        f"Disputes recorded: src=evaluator:relationship_extraction "
        f"agentId={runtime.agent_id} count={len(disputes)}"
    )


async def _handle_privacy_boundaries(
    runtime: IAgentRuntime,
    boundaries: list[dict[str, str | float]],
    message: Memory,
) -> None:
    """Mark entity metadata as private and create ``privacy_marker`` components."""
    entity = await runtime.get_entity(str(message.entity_id))
    if entity:
        metadata = entity.metadata or {}
        metadata["privateData"] = True
        metadata["confidential"] = True
        entity.metadata = metadata
        await runtime.update_entity(entity)

    for boundary in boundaries:
        await runtime.create_component(
            Component(
                id=str(string_to_uuid(f"privacy-{time.time()}-{message.entity_id}")),
                type="privacy_marker",
                agent_id=str(runtime.agent_id),
                entity_id=str(message.entity_id),
                room_id=str(message.room_id),
                source_entity_id=str(message.entity_id),
                data={
                    "privacyType": boundary.get("type", "private"),
                    "privacyContent": boundary.get("content", ""),
                    "privacyContext": "Privacy boundary detected",
                    "timestamp": int(time.time() * 1000),
                },
                created_at=int(time.time() * 1000),
            )
        )
    runtime.logger.info(
        f"Privacy boundaries recorded: src=evaluator:relationship_extraction "
        f"agentId={runtime.agent_id} count={len(boundaries)}"
    )


async def _create_or_update_mentioned_entity(
    runtime: IAgentRuntime,
    person: dict[str, str],
    mentioned_by: str,
) -> None:
    """Create a new entity for a mentioned person, or update the existing one."""
    # Search for an existing entity with the same name via recent entity memories
    try:
        memories = await runtime.get_memories(
            {"tableName": "entities", "count": 1000, "unique": True}
        )
    except Exception:
        memories = []

    existing = None
    for mem in memories:
        if mem.entity_id:
            entity = await runtime.get_entity(str(mem.entity_id))
            if entity and hasattr(entity, "names"):
                names = entity.names if isinstance(entity.names, list) else []
                if any(n.lower() == person["name"].lower() for n in names):
                    existing = entity
                    break

    if existing is None:
        await runtime.create_entity(
            Entity(
                id=str(string_to_uuid(f"mentioned-{person['name']}-{time.time()}")),
                agent_id=str(runtime.agent_id),
                names=[person["name"]],
                metadata={
                    "mentionedBy": mentioned_by,
                    "mentionContext": person.get("context", ""),
                    "createdFrom": "mention",
                },
            )
        )
    else:
        metadata = existing.metadata or {}
        mentions = metadata.get("mentions", [])
        if not isinstance(mentions, list):
            mentions = []
        mentions.append(
            {
                "by": mentioned_by,
                "context": person.get("context", ""),
                "timestamp": int(time.time() * 1000),
            }
        )
        metadata["mentions"] = mentions
        existing.metadata = metadata
        await runtime.update_entity(existing)


async def _assess_trust_indicators(
    runtime: IAgentRuntime,
    entity_id: str,
    messages: list[Any],
) -> dict[str, Any] | None:
    """Compute and persist trust metrics for *entity_id* based on *messages*."""
    user_messages = [m for m in messages if str(getattr(m, "entity_id", "")) == str(entity_id)]
    if not user_messages:
        return None

    entity = await runtime.get_entity(str(entity_id))
    if not entity:
        return None

    metadata = entity.metadata or {}
    trust: dict[str, Any] = metadata.get(
        "trustMetrics",
        {
            "helpfulness": 0.0,
            "consistency": 0.0,
            "engagement": 0.0,
            "suspicionLevel": 0.0,
        },
    )

    helpful_count = 0
    suspicious_count = 0
    for msg in user_messages:
        text = getattr(getattr(msg, "content", None), "text", None)
        if not text:
            continue
        assessment = assess_trust(text, str(entity_id))
        if assessment["helpfulness"] > 0:
            helpful_count += 1
        if assessment["suspicion"] > 0:
            suspicious_count += 2  # double weight for security threats

    total = len(user_messages) or 1
    trust["helpfulness"] = min(
        1.0, float(trust.get("helpfulness", 0)) * 0.8 + (helpful_count / total) * 0.2
    )
    trust["suspicionLevel"] = min(
        1.0, float(trust.get("suspicionLevel", 0)) * 0.8 + (suspicious_count / total) * 0.2
    )
    trust["engagement"] = len(user_messages)
    trust["lastAssessed"] = int(time.time() * 1000)

    metadata["trustMetrics"] = trust
    entity.metadata = metadata
    await runtime.update_entity(entity)
    return trust


async def _handle_admin_updates(
    runtime: IAgentRuntime,
    message: Memory,
) -> None:
    """Allow admin-role users to update another entity's metadata inline."""
    entity = await runtime.get_entity(str(message.entity_id))
    if not entity:
        return
    metadata = entity.metadata or {}
    if not metadata.get("isAdmin"):
        return

    text = message.content.text if message.content else ""
    if not text:
        return

    m = _ADMIN_UPDATE_PATTERN.match(text)
    if not m:
        return

    target_name, field, value = m.group(1), m.group(2), m.group(3)
    field_lower = field.lower()

    allowed_admin_fields = frozenset(
        {
            "department",
            "language",
            "nickname",
            "notes",
            "role",
            "status",
            "timezone",
            "title",
        }
    )
    if field_lower not in allowed_admin_fields:
        runtime.logger.warning(
            f"Admin update rejected: src=evaluator:relationship_extraction "
            f"agentId={runtime.agent_id} admin={message.entity_id} "
            f"field={field} reason=field_not_allowed"
        )
        return

    # Find target entity in the same room
    try:
        entities = await runtime.get_entities_for_room(message.room_id)
    except Exception:
        entities = []

    target = None
    for ent in entities:
        names = ent.names if isinstance(getattr(ent, "names", None), list) else []
        if any(n.lower() == target_name.lower() for n in names):
            target = ent
            break

    if target:
        target_metadata = target.metadata or {}
        target_metadata[field_lower] = value
        target.metadata = target_metadata
        await runtime.update_entity(target)
        runtime.logger.info(
            f"Admin metadata update: src=evaluator:relationship_extraction "
            f"agentId={runtime.agent_id} admin={message.entity_id} "
            f"target={target.id} field={field} value={value}"
        )


# ---------------------------------------------------------------------------
# Main evaluator entry point
# ---------------------------------------------------------------------------


async def evaluate_relationship_extraction(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> EvaluatorResult:
    text = message.content.text if message.content else ""

    if not text:
        return EvaluatorResult(
            score=50,
            passed=True,
            reason="No text to analyze",
            details={"noText": True},
        )

    # --- existing: platform identities ---
    identities = extract_platform_identities(text)

    # --- existing: relationship indicators ---
    indicators = detect_relationship_indicators(text)

    # --- new: dispute detection ---
    recent_messages: list[Any] = []
    with contextlib.suppress(Exception):
        recent_messages = await runtime.get_memories(
            {"roomId": message.room_id, "tableName": "messages", "count": 10, "unique": False}
        )
    disputes = detect_disputes(text, recent_messages)

    # --- new: sentiment analysis ---
    sentiment = analyze_sentiment(text)

    # --- new: privacy boundaries ---
    privacy_boundaries = detect_privacy_boundaries(text)

    # --- new: mentioned people ---
    mentioned_people = extract_mentioned_people(text)

    # --- new: trust assessment (lightweight, on current text only) ---
    trust = assess_trust(text, str(message.entity_id))

    # --- persist platform identities ---
    if identities and message.entity_id:
        await _store_platform_identities(runtime, str(message.entity_id), identities)

    # --- persist disputes ---
    if disputes:
        await _handle_disputes(runtime, disputes, message)

    # --- persist privacy boundaries ---
    if privacy_boundaries:
        await _handle_privacy_boundaries(runtime, privacy_boundaries, message)

    # --- persist mentioned entities ---
    for person in mentioned_people:
        await _create_or_update_mentioned_entity(runtime, person, str(message.entity_id))

    # --- persist trust metrics (uses full message window) ---
    if message.entity_id and recent_messages:
        await _assess_trust_indicators(runtime, str(message.entity_id), recent_messages)

    # --- admin metadata updates ---
    await _handle_admin_updates(runtime, message)

    runtime.logger.info(
        f"Completed extraction: src=evaluator:relationship_extraction "
        f"agentId={runtime.agent_id} identitiesFound={len(identities)} "
        f"indicatorsFound={len(indicators)} disputeDetected={bool(disputes)} "
        f"mentionedPeople={len(mentioned_people)} "
        f"privacyBoundaries={len(privacy_boundaries)}"
    )

    return EvaluatorResult(
        score=70,
        passed=True,
        reason=(
            f"Found {len(identities)} identities, {len(indicators)} indicators, "
            f"{len(disputes)} disputes, {len(mentioned_people)} mentioned people"
        ),
        details={
            "identitiesCount": len(identities),
            "indicatorsCount": len(indicators),
            "disputeDetected": bool(disputes),
            "disputes": disputes,
            "sentiment": sentiment,
            "trust": trust,
            "privacyBoundaries": privacy_boundaries,
            "mentionedPeopleCount": len(mentioned_people),
            "mentionedPeople": mentioned_people,
        },
    )


async def validate_relationship_extraction(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    return message.content is not None and bool(message.content.text)


async def _relationship_extraction_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: Callable[[Content], Awaitable[list[Memory]]] | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult | None:
    """Wrapper handler that matches the expected signature."""
    _ = options, callback, responses  # Unused parameters
    result = await evaluate_relationship_extraction(runtime, message, state)
    return ActionResult(
        text=result.reason,
        success=result.passed,
        values={},
        data=result.details,
    )


relationship_extraction_evaluator = Evaluator(
    name=str(_spec["name"]),
    description=str(_spec["description"]),
    similes=list(_spec.get("similes", [])) if _spec.get("similes") else [],
    validate=validate_relationship_extraction,
    handler=_relationship_extraction_handler,
    always_run=bool(_spec.get("alwaysRun", False)),
    examples=[],
)
