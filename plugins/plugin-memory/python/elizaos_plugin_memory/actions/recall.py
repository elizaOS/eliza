"""RECALL action - retrieve stored memories based on a query or topic."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from elizaos_plugin_memory.actions.base import (
    ActionExample,
    ActionResult,
    HandlerCallback,
    Memory,
    RuntimeProtocol,
    State,
    create_action,
)
from elizaos_plugin_memory.types import (
    MEMORY_SOURCE,
    PLUGIN_MEMORY_TABLE,
    MemoryImportance,
    decode_memory_text,
)

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol,
    _message: Memory,
    _state: State | None = None,
) -> bool:
    try:
        return callable(getattr(runtime, "get_memories", None))
    except Exception:
        return False


async def handler(
    runtime: RuntimeProtocol,
    message: Memory,
    _state: State | None = None,
    options: dict[str, str | list[str] | int | None] | None = None,
    callback: HandlerCallback | None = None,
) -> ActionResult:
    try:
        content_data = message.get("content", {})
        content = content_data.get("text", "")
        if not content:
            error_message = "Please provide a query to recall memories."
            if callback:
                await callback({"text": error_message, "source": content_data.get("source")})
            return {"text": error_message, "success": False}

        query = str(options.get("query", content)) if options and options.get("query") else content
        filter_tags: list[str] = (
            list(options.get("tags", [])) if options and options.get("tags") else []
        )
        limit = int(options.get("limit", 10)) if options and options.get("limit") else 10
        min_imp = (
            int(options.get("minImportance", 1))
            if options and options.get("minImportance")
            else 1
        )

        memories = await runtime.get_memories(
            {
                "roomId": message.get("roomId", ""),
                "tableName": PLUGIN_MEMORY_TABLE,
                "count": 100,
            }
        )

        plugin_memories = [
            m for m in memories if m.get("content", {}).get("source") == MEMORY_SOURCE
        ]

        if not plugin_memories:
            no_mem_msg = "I don't have any stored memories yet."
            if callback:
                await callback({"text": no_mem_msg, "source": content_data.get("source")})
            return {"text": no_mem_msg, "success": True, "data": {"memories": [], "count": 0}}

        # Parse and filter
        parsed_list = []
        for m in plugin_memories:
            parsed = decode_memory_text(m.get("content", {}).get("text", ""))
            if int(parsed.importance) < min_imp:
                continue
            parsed_list.append(
                {
                    "id": m.get("id", ""),
                    "content": parsed.content,
                    "tags": parsed.tags,
                    "importance": parsed.importance,
                    "createdAt": m.get("createdAt", 0),
                }
            )

        if filter_tags:
            parsed_list = [
                m
                for m in parsed_list
                if any(tag in m["tags"] for tag in filter_tags)
            ]

        # Score and rank
        query_lower = query.lower()
        query_words = [w for w in query_lower.split() if len(w) >= 2]

        scored = []
        for m in parsed_list:
            content_lower = m["content"].lower()
            tags_str = " ".join(m["tags"]).lower()
            score = 0

            if query_lower in content_lower:
                score += 10

            for word in query_words:
                if word in content_lower:
                    score += 2
                if word in tags_str:
                    score += 3

            score += int(m["importance"])

            if score > 0:
                scored.append({**m, "score": score})

        scored.sort(key=lambda x: x["score"], reverse=True)
        scored = scored[:limit]

        if not scored:
            no_results_msg = "No memories found matching your query."
            if callback:
                await callback({"text": no_results_msg, "source": content_data.get("source")})
            return {
                "text": no_results_msg,
                "success": True,
                "data": {"memories": [], "count": 0},
            }

        lines = []
        for i, m in enumerate(scored):
            tag_str = f" [{', '.join(m['tags'])}]" if m["tags"] else ""
            created = m.get("createdAt", 0)
            date_str = (
                datetime.fromtimestamp(created / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                if created
                else "unknown"
            )
            lines.append(f"{i + 1}. {m['content']}{tag_str} ({date_str})")

        count = len(scored)
        suffix = "y" if count == 1 else "ies"
        result_text = f"Found {count} memor{suffix}:\n\n" + "\n".join(lines)

        if callback:
            await callback({"text": result_text, "source": content_data.get("source")})

        return {
            "text": result_text,
            "success": True,
            "data": {
                "memories": [
                    {
                        "id": m["id"],
                        "content": m["content"],
                        "tags": m["tags"],
                        "importance": int(m["importance"]),
                        "createdAt": m["createdAt"],
                    }
                    for m in scored
                ],
                "count": count,
            },
        }

    except Exception as error:
        logger.error("Failed to recall memories: %s", error)
        error_message = f"Failed to recall memories: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


recall_action = create_action(
    name="RECALL",
    description="Retrieve stored memories based on a query, tags, or topic",
    similes=["recall", "remember-what", "search-memory", "find-memory", "what-do-you-remember"],
    examples=[
        [
            ActionExample(
                name="User",
                content={"text": "What do you remember about my preferences?"},
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "Let me search my memories about your preferences.",
                    "actions": ["RECALL"],
                },
            ),
        ],
        [
            ActionExample(
                name="User",
                content={"text": "Recall everything about the project deadline."},
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll look up what I know about the project deadline.",
                    "actions": ["RECALL"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
