"""Long-term Memory Provider."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional
from uuid import UUID

if TYPE_CHECKING:
    from elizaos_plugin_memory.services.memory_service import MemoryService
    from elizaos_plugin_memory.types import LongTermMemory

logger = logging.getLogger(__name__)


@dataclass
class ProviderResult:
    """Result from a provider."""

    data: dict[str, object] = field(default_factory=dict)
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


class LongTermMemoryProvider:
    """
    Long-term Memory Provider.

    Provides persistent facts about the user that have been learned across
    all conversations.
    """

    name: str = "LONG_TERM_MEMORY"
    description: str = "Persistent facts and preferences about the user"
    position: int = 50

    def __init__(self, memory_service: MemoryService) -> None:
        """Initialize the provider."""
        self._memory_service = memory_service

    async def get(
        self,
        agent_id: UUID,
        entity_id: UUID,
    ) -> ProviderResult:
        """Get long-term memories for an entity."""
        try:
            if entity_id == agent_id:
                return ProviderResult(
                    data={"memories": []},
                    values={"longTermMemories": ""},
                    text="",
                )

            memories = await self._memory_service.get_long_term_memories(
                entity_id, None, 25
            )

            if not memories:
                return ProviderResult(
                    data={"memories": []},
                    values={"longTermMemories": ""},
                    text="",
                )

            formatted_memories = await self._memory_service.get_formatted_long_term_memories(
                entity_id
            )
            text = f"# What I Know About You\n\n{formatted_memories}"

            category_counts: dict[str, int] = {}
            for memory in memories:
                cat = memory.category.value
                category_counts[cat] = category_counts.get(cat, 0) + 1

            category_list = ", ".join(
                f"{cat}: {count}" for cat, count in category_counts.items()
            )

            return ProviderResult(
                data={
                    "memories": [
                        {
                            "id": str(m.id),
                            "category": m.category.value,
                            "content": m.content,
                            "confidence": m.confidence,
                        }
                        for m in memories
                    ],
                    "categoryCounts": category_counts,
                },
                values={
                    "longTermMemories": text,
                    "memoryCategories": category_list,
                },
                text=text,
            )
        except Exception as e:
            logger.error("Error in LongTermMemoryProvider: %s", e)
            return ProviderResult(
                data={"memories": []},
                values={"longTermMemories": ""},
                text="",
            )


