from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


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
        # Fallback skipped for parity with TS/Bootstrap
        pass

    for entry in relevant_knowledge:
        # Handle both dict and object entries
        if isinstance(entry, dict):
            content = entry.get("content", {})
            text = content.get("text", "") if isinstance(content, dict) else ""
            entry_id = entry.get("id", "")
            metadata = entry.get("metadata", {})
        else:
            content = getattr(entry, "content", None)
            text = getattr(content, "text", "") if content else ""
            entry_id = getattr(entry, "id", "")
            metadata = getattr(entry, "metadata", {})

        if text:
            knowledge_text = text
            if len(knowledge_text) > 500:
                knowledge_text = knowledge_text[:500] + "..."

            source = "unknown"
            if isinstance(metadata, dict):
                source = str(metadata.get("source", "unknown"))

            entry_dict = {
                "id": str(entry_id) if entry_id else "",
                "text": knowledge_text,
                "source": source,
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
    name="KNOWLEDGE",
    description="Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
    get=get_knowledge_context,
    dynamic=True,
)
