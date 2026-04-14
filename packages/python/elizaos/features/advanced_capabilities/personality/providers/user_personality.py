"""User personality provider -- injects per-user interaction preferences.

Adapts the agent's style for each individual user without changing
the global character definition.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

from ..types import MAX_PREFS_PER_USER, USER_PREFS_TABLE

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


async def _get_user_personality(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    # Skip for agent's own messages
    if not message.entity_id or message.entity_id == runtime.agent_id:
        return ProviderResult(text="", values={}, data={})

    try:
        preferences = await runtime.get_memories(
            {
                "entityId": str(message.entity_id),
                "roomId": str(runtime.agent_id),
                "tableName": USER_PREFS_TABLE,
                "count": MAX_PREFS_PER_USER,
            }
        )

        if not preferences:
            return ProviderResult(text="", values={}, data={})

        pref_texts = [
            p.content.text
            for p in preferences
            if hasattr(p, "content")
            and hasattr(p.content, "text")
            and isinstance(p.content.text, str)
            and p.content.text.strip()
        ]

        if not pref_texts:
            return ProviderResult(text="", values={}, data={})

        lines = [
            "[USER INTERACTION PREFERENCES]",
            "The following preferences apply ONLY when responding to THIS specific user:",
        ]
        for i, text in enumerate(pref_texts, 1):
            lines.append(f"{i}. {text}")
        lines.append("[/USER INTERACTION PREFERENCES]")

        context_text = "\n".join(lines)

        logger.debug(
            "Injecting user personality preferences: userId=%s, count=%d",
            message.entity_id,
            len(pref_texts),
        )

        return ProviderResult(
            text=context_text,
            values={
                "userPreferenceCount": len(pref_texts),
                "hasUserPreferences": True,
            },
            data={
                "preferences": pref_texts,
                "userId": str(message.entity_id),
            },
        )
    except Exception as e:
        logger.warning("Failed to load user personality preferences: %s", e)
        return ProviderResult(text="", values={}, data={})


user_personality_provider = Provider(
    name="userPersonalityPreferences",
    description="Injects per-user interaction preferences into the prompt when responding to a specific user",
    get=_get_user_personality,
    dynamic=True,
)
