from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from elizaos.bootstrap.types import EvaluatorResult
from elizaos.generated.spec_helpers import require_evaluator_spec
from elizaos.types import ActionResult, Evaluator, HandlerOptions

if TYPE_CHECKING:
    from elizaos.types import Content, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_evaluator_spec("RELATIONSHIP_EXTRACTION")

X_HANDLE_PATTERN = re.compile(r"@[\w]+")
EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")
PHONE_PATTERN = re.compile(r"\+?[\d\s\-()]{10,}")
DISCORD_PATTERN = re.compile(r"[\w]+#\d{4}")


def extract_platform_identities(text: str) -> list[dict[str, str | bool | float]]:
    identities: list[dict[str, str | bool | float]] = []

    for match in X_HANDLE_PATTERN.finditer(text):
        handle = match.group()
        if handle.lower() not in ("@here", "@everyone", "@channel"):
            identities.append(
                {
                    "platform": "x",
                    "handle": handle,
                    "verified": False,
                    "confidence": 0.7,
                }
            )

    for match in EMAIL_PATTERN.finditer(text):
        identities.append(
            {
                "platform": "email",
                "handle": match.group(),
                "verified": False,
                "confidence": 0.9,
            }
        )

    for match in DISCORD_PATTERN.finditer(text):
        identities.append(
            {
                "platform": "discord",
                "handle": match.group(),
                "verified": False,
                "confidence": 0.8,
            }
        )

    return identities


def detect_relationship_indicators(text: str) -> list[dict[str, str | float]]:
    indicators: list[dict[str, str | float]] = []

    friend_patterns = [
        r"my friend",
        r"good friend",
        r"best friend",
        r"close friend",
        r"we're friends",
    ]
    for pattern in friend_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append(
                {
                    "type": "friend",
                    "sentiment": "positive",
                    "confidence": 0.8,
                }
            )
            break

    colleague_patterns = [
        r"my colleague",
        r"coworker",
        r"co-worker",
        r"work together",
        r"at work",
    ]
    for pattern in colleague_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            indicators.append(
                {
                    "type": "colleague",
                    "sentiment": "neutral",
                    "confidence": 0.8,
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
                }
            )
            break

    return indicators


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

    identities = extract_platform_identities(text)

    indicators = detect_relationship_indicators(text)

    if identities and message.entity_id:
        entity = await runtime.get_entity(str(message.entity_id))
        if entity:
            metadata = entity.metadata or {}
            existing_identities = metadata.get("platformIdentities", [])
            if isinstance(existing_identities, list):
                for identity in identities:
                    exists = any(
                        i.get("platform") == identity["platform"]
                        and i.get("handle") == identity["handle"]
                        for i in existing_identities
                        if isinstance(i, dict)
                    )
                    if not exists:
                        existing_identities.append(identity)
                metadata["platformIdentities"] = existing_identities
                entity.metadata = metadata
                await runtime.update_entity(entity)

    runtime.logger.info(
        f"Completed extraction: src=evaluator:relationship_extraction agentId={runtime.agent_id} identitiesFound={len(identities)} indicatorsFound={len(indicators)}"
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
    # Return None as ActionResult - evaluators don't typically return action results
    return ActionResult(text=result.reason, success=result.passed, values={}, data={})


relationship_extraction_evaluator = Evaluator(
    name=str(_spec["name"]),
    description=str(_spec["description"]),
    similes=list(_spec.get("similes", [])) if _spec.get("similes") else [],
    validate=validate_relationship_extraction,
    handler=_relationship_extraction_handler,
    always_run=bool(_spec.get("alwaysRun", False)),
    examples=[],
)
