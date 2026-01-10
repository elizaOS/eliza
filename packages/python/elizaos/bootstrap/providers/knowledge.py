"""
Knowledge Provider - Provides relevant knowledge from the agent's knowledge base.

This provider retrieves and formats relevant knowledge entries
based on the current context and message.
"""

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
    """
    Get relevant knowledge for the current context.

    Returns knowledge entries that are:
    - Semantically similar to the current message
    - Relevant to the conversation topic
    - Part of the agent's knowledge base
    """
    sections: list[str] = []
    knowledge_entries: list[dict[str, str]] = []

    # Get message text for similarity search
    query_text = ""
    if message.content and message.content.text:
        query_text = message.content.text

    if not query_text:
        return ProviderResult(
            text="",
            values={"knowledgeCount": 0, "hasKnowledge": False},
            data={"entries": []},
        )

    try:
        # Search for relevant knowledge
        relevant_knowledge = await runtime.search_knowledge(
            query=query_text,
            limit=5,
        )

        for entry in relevant_knowledge:
            if entry.content and entry.content.text:
                knowledge_text = entry.content.text
                # Truncate if too long
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

    except Exception as e:
        runtime.logger.warning(
            {"src": "provider:knowledge", "error": str(e)},
            "Error searching knowledge base",
        )

    context_text = ""
    if sections:
        context_text = "# Relevant Knowledge\n" + "\n".join(sections)

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


# Create the provider instance
knowledge_provider = Provider(
    name="KNOWLEDGE",
    description="Provides relevant knowledge from the agent's knowledge base based on semantic similarity",
    get=get_knowledge_context,
    dynamic=True,  # Knowledge relevance depends on the message
)
