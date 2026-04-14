from __future__ import annotations

from elizaos.types import Evaluator, HandlerOptions


async def _summarization_validate(runtime, message, _state=None) -> bool:
    if not message.content or not message.content.text:
        return False
    svc = runtime.get_service("memory")
    if svc is None:
        return False

    # Best-effort message count (works with adapter; otherwise stays 0)
    count = await runtime.count_memories(message.room_id, unique=False, table_name="messages")
    existing = await svc.get_current_session_summary(message.room_id)
    cfg = svc.get_config()

    if existing is None:
        return count >= cfg.short_term_summarization_threshold
    return (count - existing.last_message_offset) >= cfg.short_term_summarization_interval


async def _summarization_handler(
    runtime, message, _state=None, _options: HandlerOptions | None = None, *_args
):
    svc = runtime.get_service("memory")
    if svc is None:
        return None
    # Pull a window of messages; adapters may vary, so be defensive.
    messages = await runtime.get_memories(
        {"tableName": "messages", "roomId": message.room_id, "count": 200, "unique": False}
    )
    await svc.summarize_from_messages(
        room_id=message.room_id,
        agent_id=runtime.agent_id,
        agent_name=runtime.character.name,
        messages=messages,
    )
    return None


async def _long_term_validate(runtime, message, _state=None) -> bool:
    if not message.content or not message.content.text:
        return False
    if message.entity_id == runtime.agent_id:
        return False
    svc = runtime.get_service("memory")
    if svc is None:
        return False
    cfg = svc.get_config()
    if not cfg.long_term_extraction_enabled:
        return False
    count = await runtime.count_memories(message.room_id, unique=False, table_name="messages")
    return await svc.should_run_extraction(message.entity_id, message.room_id, count)


async def _long_term_handler(
    runtime, message, _state=None, _options: HandlerOptions | None = None, *_args
):
    svc = runtime.get_service("memory")
    if svc is None:
        return None
    messages = await runtime.get_memories(
        {"tableName": "messages", "roomId": message.room_id, "count": 50, "unique": False}
    )
    await svc.extract_long_term_from_messages(
        entity_id=message.entity_id,
        room_id=message.room_id,
        agent_id=runtime.agent_id,
        agent_name=runtime.character.name,
        messages=messages,
    )
    # Update checkpoint
    count = await runtime.count_memories(message.room_id, unique=False, table_name="messages")
    await svc.set_last_extraction_checkpoint(message.entity_id, message.room_id, count)
    return None


summarization_evaluator = Evaluator(
    name="MEMORY_SUMMARIZATION",
    description="Automatically summarizes conversations to optimize context usage",
    always_run=True,
    similes=["CONVERSATION_SUMMARY", "CONTEXT_COMPRESSION", "MEMORY_OPTIMIZATION"],
    examples=[],
    validate=_summarization_validate,
    handler=_summarization_handler,
)

long_term_extraction_evaluator = Evaluator(
    name="LONG_TERM_MEMORY_EXTRACTION",
    description="Extracts long-term facts about users from conversations",
    always_run=True,
    similes=["MEMORY_EXTRACTION", "FACT_LEARNING", "USER_PROFILING"],
    examples=[],
    validate=_long_term_validate,
    handler=_long_term_handler,
)
