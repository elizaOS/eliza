"""REMEMBER action - store a piece of information as a long-term memory."""

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
    MemoryImportance,
    encode_memory_text,
)

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol,
    _message: Memory,
    _state: State | None = None,
) -> bool:
    try:
        return callable(getattr(runtime, "create_memory", None))
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
            error_message = "Please provide content to remember."
            if callback:
                await callback({"text": error_message, "source": content_data.get("source")})
            return {"text": error_message, "success": False}

        memory_text = str(options.get("content", content)) if options else content
        tags: list[str] = list(options.get("tags", [])) if options and options.get("tags") else []
        importance_val = int(options.get("importance", 2)) if options and options.get("importance") else 2
        importance = (
            MemoryImportance(importance_val)
            if 1 <= importance_val <= 4
            else MemoryImportance.NORMAL
        )

        # Use LLM to extract structured memory if no explicit content given
        if not options or not options.get("content"):
            prompt = (
                "Extract the key information to remember from this message.\n"
                "Return ONLY a JSON object (no markdown, no code blocks):\n"
                '{"memory": "The concise fact to store", '
                '"tags": ["relevant", "tags"], "importance": 2}\n\n'
                "Importance: 1=low, 2=normal, 3=high, 4=critical\n\n"
                f'User message: "{content}"'
            )

            response = await runtime.use_model("TEXT_LARGE", {"prompt": prompt})
            if response:
                try:
                    cleaned = re.sub(r"^```(?:json)?\n?", "", response)
                    cleaned = re.sub(r"\n?```$", "", cleaned).strip()
                    parsed = json.loads(cleaned)
                    memory_text = parsed.get("memory", content)
                    raw_tags = parsed.get("tags", [])
                    tags = [str(t) for t in raw_tags] if isinstance(raw_tags, list) else []
                    imp = parsed.get("importance", 2)
                    importance = (
                        MemoryImportance(int(imp))
                        if isinstance(imp, (int, float)) and 1 <= int(imp) <= 4
                        else MemoryImportance.NORMAL
                    )
                except (json.JSONDecodeError, ValueError) as parse_err:
                    logger.warning("Failed to parse memory extraction: %s", parse_err)
                    memory_text = content

        encoded = encode_memory_text(memory_text, tags, importance)

        entity_id = message.get("entityId") or message.get("userId", "")
        memory_entry: Memory = {
            "agentId": runtime.agent_id,
            "roomId": message.get("roomId", ""),
            "userId": entity_id,
            "content": {"text": encoded, "source": MEMORY_SOURCE},
            "createdAt": 0,
        }

        await runtime.create_memory(memory_entry, PLUGIN_MEMORY_TABLE, True)

        tag_suffix = f" [tags: {', '.join(tags)}]" if tags else ""
        success_message = f'Remembered: "{memory_text}"{tag_suffix}'

        if callback:
            await callback({"text": success_message, "source": content_data.get("source")})

        return {
            "text": success_message,
            "success": True,
            "data": {"content": memory_text, "tags": tags, "importance": int(importance)},
        }

    except Exception as error:
        logger.error("Failed to store memory: %s", error)
        error_message = f"Failed to store memory: {error}"
        if callback:
            await callback(
                {"text": error_message, "source": message.get("content", {}).get("source")}
            )
        return {"text": error_message, "success": False}


remember_action = create_action(
    name="REMEMBER",
    description="Store a piece of information as a long-term memory for later recall",
    similes=["remember", "memorize", "store-memory", "save-memory", "note-down"],
    examples=[
        [
            ActionExample(
                name="User",
                content={"text": "Remember that my favorite color is blue."},
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "I'll remember that your favorite color is blue.",
                    "actions": ["REMEMBER"],
                },
            ),
        ],
        [
            ActionExample(
                name="User",
                content={"text": "Memorize this: the project deadline is March 15th."},
            ),
            ActionExample(
                name="Assistant",
                content={
                    "text": "Got it, I've stored that the project deadline is March 15th.",
                    "actions": ["REMEMBER"],
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
