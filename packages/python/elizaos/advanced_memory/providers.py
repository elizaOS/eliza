from __future__ import annotations

from elizaos.types import Provider, ProviderResult


async def long_term_memory_get(runtime, message, _state=None) -> ProviderResult:
    svc = runtime.get_service("memory")
    if svc is None:
        return ProviderResult(text="", values={"longTermMemories": ""}, data={"memoryCount": 0})

    entity_id = message.entity_id
    if entity_id == runtime.agent_id:
        return ProviderResult(text="", values={"longTermMemories": ""}, data={"memoryCount": 0})

    memories = await svc.get_long_term_memories(entity_id, None, 25)
    if not memories:
        return ProviderResult(text="", values={"longTermMemories": ""}, data={"memoryCount": 0})

    formatted = await svc.get_formatted_long_term_memories(entity_id)
    text = f"# What I Know About You\n\n{formatted}"

    category_counts: dict[str, int] = {}
    for m in memories:
        category_counts[m.category.value] = category_counts.get(m.category.value, 0) + 1
    category_list = ", ".join(f"{k}: {v}" for k, v in category_counts.items())

    return ProviderResult(
        text=text,
        values={"longTermMemories": text, "memoryCategories": category_list},
        data={"memoryCount": len(memories), "categories": category_list},
    )


async def context_summary_get(runtime, message, _state=None) -> ProviderResult:
    svc = runtime.get_service("memory")
    if svc is None:
        return ProviderResult(
            text="",
            values={"sessionSummaries": "", "sessionSummariesWithTopics": ""},
            data={},
        )

    current = await svc.get_current_session_summary(message.room_id)
    if current is None:
        return ProviderResult(
            text="",
            values={"sessionSummaries": "", "sessionSummariesWithTopics": ""},
            data={},
        )

    summary_only = (
        f"**Previous Conversation** ({current.message_count} messages)\n{current.summary}"
    )
    summary_with_topics = (
        summary_only + f"\n*Topics: {', '.join(current.topics)}*"
        if current.topics
        else summary_only
    )
    session_summaries = f"# Conversation Summary\n\n{summary_only}" if summary_only else ""
    session_summaries_with_topics = (
        f"# Conversation Summary\n\n{summary_with_topics}" if summary_with_topics else ""
    )

    return ProviderResult(
        text=session_summaries_with_topics,
        values={
            "sessionSummaries": session_summaries,
            "sessionSummariesWithTopics": session_summaries_with_topics,
        },
        data={
            "summaryText": current.summary,
            "messageCount": current.message_count,
            "topics": ", ".join(current.topics),
        },
    )


long_term_memory_provider = Provider(
    name="LONG_TERM_MEMORY",
    description="Persistent facts and preferences about the user",
    position=50,
    get=long_term_memory_get,
)

context_summary_provider = Provider(
    name="SUMMARIZED_CONTEXT",
    description="Provides summarized context from previous conversations",
    position=96,
    get=context_summary_get,
)
