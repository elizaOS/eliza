"""FORGET action - remove a stored memory by ID or by matching content."""

from __future__ import annotations

import json
import logging
import re

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
    decode_memory_text,
)

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol,
    _message: Memory,
    _state: State | None = None,
) -> bool:
    try:
        return callable(getattr(runtime, "get_memories", None)) and callable(
            getattr(runtime, "delete_memory", None)
        )
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
            error_message = "Please specify which memory to forget."
            if callback:
                await callback({"text": error_message, "source": content_data.get("source")})
            return {"text": error_message, "success": False}

        # Direct removal by ID
        memory_id = str(options.get("memoryId", "")) if options else ""
        if memory_id:
            await runtime.delete_memory(memory_id)
            success_message = f"Removed memory with ID: {memory_id}"
            if callback:
                await callback({"text": success_message, "source": content_data.get("source")})
            return {"text": success_message, "success": True, "data": {"removedId": memory_id}}

        # Search for matching memory
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
            no_mem_msg = "No stored memories found to remove."
            if callback:
                await callback({"text": no_mem_msg, "source": content_data.get("source")})
            return {"text": no_mem_msg, "success": True}

        # Use LLM to find the best matching memory
        search_content = str(options.get("content", content)) if options else content
        descriptions = []
        for i, m in enumerate(plugin_memories):
            parsed = decode_memory_text(m.get("content", {}).get("text", ""))
            descriptions.append(f'{i}: "{parsed.content}"')

        match_prompt = (
            "Given the user's request to forget a memory, identify which memory index matches.\n\n"
            f'User request: "{search_content}"\n\n'
            f"Available memories:\n{chr(10).join(descriptions)}\n\n"
            'Return ONLY a JSON object: {"index": <number or -1>, "confidence": <0.0 to 1.0>}'
        )

        response = await runtime.use_model("TEXT_LARGE", {"prompt": match_prompt})
        if not response:
            raise RuntimeError("Failed to identify memory to remove")

        cleaned = re.sub(r"^```(?:json)?\n?", "", response)
        cleaned = re.sub(r"\n?```$", "", cleaned).strip()
        match_result: dict[str, int | float] = json.loads(cleaned)

        idx = int(match_result.get("index", -1))
        confidence = float(match_result.get("confidence", 0.0))

        if idx < 0 or idx >= len(plugin_memories) or confidence < 0.5:
            no_match_msg = "Could not find a matching memory to remove. Please be more specific."
            if callback:
                await callback({"text": no_match_msg, "source": content_data.get("source")})
            return {"text": no_match_msg, "success": False}

        target = plugin_memories[idx]
        parsed = decode_memory_text(target.get("content", {}).get("text", ""))
        target_id = target.get("id", "")

        if target_id:
            await runtime.delete_memory(target_id)

        success_message = f'Removed memory: "{parsed.content}"'
        if callback:
            await callback({"text": success_message, "source": content_data.get("source")})

        return {
            "text": success_message,
            "success": True,
            "data": {"removedId": target_id, "content": parsed.content},
        }

    except Exception as error:
        logger.error("Failed to forget memory: %s", error)
        error_message = f"Failed to forget memory: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


forget_action = create_action(
    name="FORGET",
    description="Remove a stored memory by ID or by matching content description",
    similes=["forget", "remove-memory", "delete-memory", "erase-memory", "clear-memory"],
    examples=[
        [
            ActionExample(
                name="User",
                content={"text": "Forget what you know about my favorite color."},
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll remove that memory about your favorite color.",
                    "actions": ["FORGET"],
                },
            ),
        ],
        [
            ActionExample(
                name="User",
                content={"text": "Delete the memory about the project deadline."},
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I've removed the memory about the project deadline.",
                    "actions": ["FORGET"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
