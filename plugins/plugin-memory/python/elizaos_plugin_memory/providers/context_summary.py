
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


class ContextSummaryProvider:
    name: str = "SUMMARIZED_CONTEXT"
    description: str = "Provides summarized context from previous conversations"
    position: int = 96

    def __init__(self, memory_service: MemoryService) -> None:
        self._memory_service = memory_service

    async def get(
        self,
        room_id: UUID,
    ) -> ProviderResult:
        current_summary = await self._memory_service.get_current_session_summary(room_id)

        if not current_summary:
            return ProviderResult(
                data={"summary": None},
                values={"sessionSummaries": "", "sessionSummariesWithTopics": ""},
                text="",
            )

        message_range = f"{current_summary.message_count} messages"
        time_range = current_summary.start_time.strftime("%Y-%m-%d")

        summary_only = (
            f"**Previous Conversation** ({message_range}, {time_range})\n"
            f"{current_summary.summary}"
        )

        summary_with_topics = summary_only
        if current_summary.topics:
            topics_str = ", ".join(current_summary.topics)
            summary_with_topics += f"\n*Topics: {topics_str}*"

        session_summaries = f"# Conversation Summary\n\n{summary_only}"
        session_summaries_with_topics = f"# Conversation Summary\n\n{summary_with_topics}"

        return ProviderResult(
            data={
                "summary": {
                    "id": str(current_summary.id),
                    "summary": current_summary.summary,
                    "messageCount": current_summary.message_count,
                    "topics": current_summary.topics,
                }
            },
            values={
                "sessionSummaries": session_summaries,
                "sessionSummariesWithTopics": session_summaries_with_topics,
            },
            text=session_summaries_with_topics,
        )
