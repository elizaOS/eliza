"""
Relationship Extraction Evaluator - Passively extracts relationship info.

This evaluator analyzes conversations to extract and update
relationship information between entities.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from elizaos.types import Evaluator

from elizaos.bootstrap.types import EvaluatorResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


# Platform identity patterns
TWITTER_PATTERN = re.compile(r"@[\w]+")
EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")
PHONE_PATTERN = re.compile(r"\+?[\d\s\-()]{10,}")
DISCORD_PATTERN = re.compile(r"[\w]+#\d{4}")


def extract_platform_identities(text: str) -> list[dict[str, str | bool | float]]:
    """Extract platform identities from text."""
    identities: list[dict[str, str | bool | float]] = []

    # Twitter handles
    for match in TWITTER_PATTERN.finditer(text):
        handle = match.group()
        if handle.lower() not in ("@here", "@everyone", "@channel"):
            identities.append({
                "platform": "twitter",
                "handle": handle,
                "verified": False,
                "confidence": 0.7,
            })

    # Email addresses
    for match in EMAIL_PATTERN.finditer(text):
        identities.append({
            "platform": "email",
            "handle": match.group(),
            "verified": False,
            "confidence": 0.9,
        })

    # Discord usernames
    for match in DISCORD_PATTERN.finditer(text):
        identities.append({
            "platform": "discord",
            "handle": match.group(),
            "verified": False,
            "confidence": 0.8,
        })

    return identities


def detect_relationship_indicators(text: str) -> list[dict[str, str | float]]:
    """Detect relationship indicators in text."""
    indicators: list[dict[str, str | float]] = []

    # Friend indicators
    friend_patterns = [
        r"my friend",
        r"good friend",
        r"best friend",
        r"close friend",
        r"we're friends",
    ]
    for pattern in friend_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append({
                "type": "friend",
                "sentiment": "positive",
                "confidence": 0.8,
            })
            break

    # Colleague indicators
    colleague_patterns = [
        r"my colleague",
        r"coworker",
        r"co-worker",
        r"work together",
        r"at work",
    ]
    for pattern in colleague_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append({
                "type": "colleague",
                "sentiment": "neutral",
                "confidence": 0.8,
            })
            break

    # Family indicators
    family_patterns = [
        r"my (brother|sister|mom|dad|mother|father|parent|son|daughter|child)",
        r"my family",
        r"family member",
    ]
    for pattern in family_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append({
                "type": "family",
                "sentiment": "positive",
                "confidence": 0.9,
            })
            break

    return indicators


async def evaluate_relationship_extraction(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> EvaluatorResult:
    """
    Extract relationship information from the conversation.

    This evaluator passively analyzes messages to:
    - Extract platform identities (Twitter, Discord, email)
    - Detect relationship indicators
    - Update entity metadata
    """
    text = message.content.text if message.content else ""

    if not text:
        return EvaluatorResult(
            score=50,
            passed=True,
            reason="No text to analyze",
            details={"noText": True},
        )

    try:
        # Extract platform identities
        identities = extract_platform_identities(text)

        # Detect relationship indicators
        indicators = detect_relationship_indicators(text)

        # Update entity metadata if we found identities
        if identities and message.entity_id:
            entity = await runtime.get_entity(message.entity_id)
            if entity:
                metadata = entity.metadata or {}
                existing_identities = metadata.get("platformIdentities", [])
                if isinstance(existing_identities, list):
                    for identity in identities:
                        # Check if already exists
                        exists = any(
                            i.get("platform") == identity["platform"]
                            and i.get("handle") == identity["handle"]
                            for i in existing_identities
                        )
                        if not exists:
                            existing_identities.append(identity)
                    metadata["platformIdentities"] = existing_identities
                    entity.metadata = metadata
                    await runtime.update_entity(entity)

        runtime.logger.info(
            {
                "src": "evaluator:relationship_extraction",
                "agentId": str(runtime.agent_id),
                "identitiesFound": len(identities),
                "indicatorsFound": len(indicators),
            },
            "Completed extraction",
        )

        return EvaluatorResult(
            score=70,
            passed=True,
            reason=f"Found {len(identities)} identities and {len(indicators)} relationship indicators",
            details={
                "identitiesCount": len(identities),
                "indicatorsCount": len(indicators),
            },
        )

    except Exception as e:
        runtime.logger.error(
            {
                "src": "evaluator:relationship_extraction",
                "error": str(e),
            },
            "Error during extraction",
        )
        return EvaluatorResult(
            score=50,
            passed=True,
            reason=f"Extraction error: {e}",
            details={"error": str(e)},
        )


async def validate_relationship_extraction(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Validate that extraction can be performed."""
    return message.content is not None and bool(message.content.text)


# Create the evaluator instance
relationship_extraction_evaluator = Evaluator(
    name="RELATIONSHIP_EXTRACTION",
    description="Passively extracts and updates relationship information from conversations",
    validate=validate_relationship_extraction,
    handler=evaluate_relationship_extraction,
    examples=[],
)

