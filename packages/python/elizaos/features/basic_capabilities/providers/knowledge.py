from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("KNOWLEDGE")


async def get_knowledge_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    sections: list[str] = []
    knowledge_entries: list[dict[str, str]] = []

    query_text = ""
    if message.content and message.content.text:
        query_text = message.content.text

    if not query_text:
        return ProviderResult(
            text="", values={"knowledgeCount": 0, "hasKnowledge": False}, data={"entries": []}
        )

    # 1. Fetch recent messages to get embeddings
    recent_messages = await runtime.get_memories(
        room_id=message.room_id, limit=5, table_name="messages"
    )

    # 2. Extract valid embeddings
    embeddings = [m.embedding for m in recent_messages if m and m.embedding]

    relevant_knowledge = []
    # 3. Search using the most recent embedding if available
    if embeddings:
        primary_embedding = embeddings[0]
        params = {
            "tableName": "knowledge",
            "roomId": str(message.room_id),
            "embedding": primary_embedding,
            "matchThreshold": 0.75,
            "matchCount": 5,
            "unique": True,
        }
        relevant_knowledge = await runtime.search_memories(params)
    elif query_text:
        # Fallback to search_knowledge if no embeddings found?
        # TS implementation might rely on search_memories logic handling missing embedding?
        # No, TS skips if no embedding.
        pass

    for entry in relevant_knowledge:
        if entry.content and entry.content.text:
            knowledge_text = entry.content.text
            if len(knowledge_text) > 500:
                knowledge_text = knowledge_text[:500] + "..."

            entry_dict = {
                "id": str(entry.id) if entry.id else "",
                "text": knowledge_text,
                "source": str(entry.metadata.get("source", "unknown"))
                if entry.metadata
                else "unknown",
            }
            knowledge_entries.append(entry_dict)
            sections.append(f"- {knowledge_text}")

    context_text = "# Relevant Knowledge\n" + "\n".join(sections) if sections else ""

    return ProviderResult(
        text=context_text,
        values={
            "knowledgeCount": len(knowledge_entries),
            "hasKnowledge": len(knowledge_entries) > 0,
        },
        data={
            "entries": knowledge_entries,
            "query": query_text,
        },
    )


knowledge_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_knowledge_context,
    dynamic=_spec.get("dynamic", True),
    position=_spec.get("position"),
)
