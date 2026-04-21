from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

from elizaos.features.advanced_capabilities.experience.service import EXPERIENCE_SERVICE_TYPE
from elizaos.features.advanced_capabilities.experience.types import ExperienceQuery

logger = logging.getLogger("elizaos.experience")


async def _get_experiences(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> ProviderResult:
    """Provides relevant past experiences and learnings for the current context."""
    from elizaos.features.advanced_capabilities.experience.service import ExperienceService

    experience_service = runtime.get_service(EXPERIENCE_SERVICE_TYPE)

    if not isinstance(experience_service, ExperienceService):
        return ProviderResult(text="", data={}, values={})

    # Get message text for context
    message_text = ""
    if hasattr(message, "content") and message.content:
        text_val = getattr(message.content, "text", None)
        if isinstance(text_val, str):
            message_text = text_val

    if len(message_text) < 10:
        return ProviderResult(text="", data={}, values={})

    # Find relevant experiences using semantic search
    relevant_experiences = await experience_service.query_experiences(
        ExperienceQuery(
            query=message_text,
            limit=5,
            min_confidence=0.6,
            min_importance=0.5,
        )
    )

    if not relevant_experiences:
        return ProviderResult(text="", data={}, values={})

    # Format experiences for context injection
    experience_lines = []
    for i, exp in enumerate(relevant_experiences):
        experience_lines.append(
            f"Experience {i + 1}: In {exp.domain} context, when {exp.context}, "
            f"I learned: {exp.learning}"
        )

    experience_text = "\n".join(experience_lines)
    context_text = f"[RELEVANT EXPERIENCES]\n{experience_text}\n[/RELEVANT EXPERIENCES]"

    logger.debug(
        "[experienceProvider] Injecting %d relevant experiences",
        len(relevant_experiences),
    )

    return ProviderResult(
        text=context_text,
        data={
            "experiences": [
                {
                    "id": exp.id,
                    "type": exp.type.value,
                    "domain": exp.domain,
                    "learning": exp.learning,
                    "confidence": exp.confidence,
                }
                for exp in relevant_experiences
            ],
            "count": len(relevant_experiences),
        },
        values={
            "experienceCount": str(len(relevant_experiences)),
        },
    )


experience_provider = Provider(
    name="EXPERIENCE",
    description="Provides relevant past experiences and learnings for the current context",
    get=_get_experiences,
    dynamic=True,
)
