"""Memory context provider - provides relevant long-term memories for conversation context."""

from __future__ import annotations

from elizaos_plugin_memory.providers.base import Provider, ProviderResult
from elizaos_plugin_memory.types import (
    IMPORTANCE_LABELS,
    MEMORY_SOURCE,
    PLUGIN_MEMORY_TABLE,
    decode_memory_text,
)


async def get_memory_context(runtime: object, message: object, _state: object) -> ProviderResult:
    try:
        get_memories = getattr(runtime, "get_memories", None)
        if not callable(get_memories):
            return ProviderResult(text="Runtime get_memories is not available")

        msg_dict = message if isinstance(message, dict) else {}
        room_id = msg_dict.get("roomId", "")

        memories = await get_memories(
            {"roomId": room_id, "tableName": PLUGIN_MEMORY_TABLE, "count": 50}
        )

        plugin_memories = [
            m for m in memories if m.get("content", {}).get("source") == MEMORY_SOURCE
        ]

        if not plugin_memories:
            return ProviderResult(text="No stored memories available")

        # Parse and sort by importance then recency
        parsed_list = []
        for m in plugin_memories:
            parsed = decode_memory_text(m.get("content", {}).get("text", ""))
            parsed_list.append(
                {
                    "id": m.get("id", ""),
                    "content": parsed.content,
                    "tags": parsed.tags,
                    "importance": parsed.importance,
                    "createdAt": m.get("createdAt", 0),
                }
            )

        parsed_list.sort(
            key=lambda x: (int(x["importance"]), x["createdAt"]), reverse=True
        )
        parsed_list = parsed_list[:20]

        lines = []
        for m in parsed_list:
            tag_str = f" [{', '.join(m['tags'])}]" if m["tags"] else ""
            level = IMPORTANCE_LABELS.get(int(m["importance"]), "normal")
            lines.append(f"- ({level}) {m['content']}{tag_str}")

        count = len(parsed_list)
        text = f"Stored Memories ({count}):\n" + "\n".join(lines)

        return ProviderResult(
            text=text,
            data={
                "memories": [
                    {
                        "id": m["id"],
                        "content": m["content"],
                        "tags": m["tags"],
                        "importance": int(m["importance"]),
                    }
                    for m in parsed_list
                ],
                "count": count,
            },
        )
    except Exception:
        return ProviderResult(text="Error retrieving stored memories")


memory_context_provider = Provider(
    name="MEMORY_CONTEXT",
    description="Provides relevant long-term memories from conversation context",
    get=get_memory_context,
)
