
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    from elizaos_plugin_memory.services.memory_service import MemoryService

logger = logging.getLogger(__name__)


@dataclass
class ProviderResult:
    data: dict[str, object] = field(default_factory=dict)
    values: dict[str, str] = field(default_factory=dict)
    text: str = ""


class LongTermMemoryProvider:
    name: str = "LONG_TERM_MEMORY"
    description: str = "Persistent facts and preferences about the user"
    position: int = 50

    def __init__(self, memory_service: MemoryService) -> None:
        self._memory_service = memory_service

    async def get(
        self,
        agent_id: UUID,
        entity_id: UUID,
    ) -> ProviderResult:
        if entity_id == agent_id:
            return ProviderResult(
                data={"memories": []},
                values={"longTermMemories": ""},
                text="",
            )

        memories = await self._memory_service.get_long_term_memories(entity_id, None, 25)

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

        category_list = ", ".join(f"{cat}: {count}" for cat, count in category_counts.items())

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
