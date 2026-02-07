"""SCRATCHPAD_WRITE action - Create a new scratchpad entry."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos_plugin_scratchpad.service import create_scratchpad_service
from elizaos_plugin_scratchpad.types import ScratchpadWriteOptions

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)

EXTRACT_TEMPLATE = """Extract the following information from the user's message to save to the scratchpad:

User message: {{text}}

Recent conversation:
{{messageHistory}}

Respond with XML containing:
- title: A short, descriptive title for the note (required)
- content: The main content to save (required)
- tags: Comma-separated tags for categorization (optional)

<response>
<title>The note title</title>
<content>The content to save</content>
<tags>tag1, tag2</tags>
</response>"""


def _parse_xml_field(text: str, field_name: str) -> str | None:
    """Extract a field value from XML-like response text."""
    match = re.search(rf"<{field_name}>([\s\S]*?)</{field_name}>", text)
    return match.group(1).strip() if match else None


@dataclass
class WriteResult:
    """Result of the SCRATCHPAD_WRITE action."""

    success: bool
    text: str
    entry_id: str | None = None
    error: str | None = None


async def _extract_write_info(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> dict[str, str | list[str]] | None:
    """Use the LLM to extract title, content, and tags from the user message."""
    message_text = message.content.text if message.content else ""
    prompt = EXTRACT_TEMPLATE.replace("{{text}}", message_text).replace(
        "{{messageHistory}}", ""
    )

    result = await runtime.use_model("TEXT_SMALL", {"prompt": prompt, "stopSequences": []})
    result_str = str(result)
    logger.debug("[ScratchpadWrite] Extract result: %s", result_str)

    title = _parse_xml_field(result_str, "title")
    content = _parse_xml_field(result_str, "content")

    if not title or not content:
        logger.error("[ScratchpadWrite] Failed to extract valid write info")
        return None

    info: dict[str, str | list[str]] = {"title": title, "content": content}

    raw_tags = _parse_xml_field(result_str, "tags")
    if raw_tags:
        tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
        if tags:
            info["tags"] = tags

    return info


async def handle_scratchpad_write(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> WriteResult | None:
    """Handle the SCRATCHPAD_WRITE action."""
    if not state:
        state = await runtime.compose_state(message, [])

    write_info = await _extract_write_info(runtime, message, state)

    if not write_info:
        error_msg = "I couldn't understand what you want me to save. Please provide a clear title and content for the note."
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["SCRATCHPAD_WRITE_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return WriteResult(success=False, text=error_msg, error="Failed to extract write info")

    try:
        service = create_scratchpad_service(runtime)
        title = str(write_info["title"])
        content = str(write_info["content"])
        tags = write_info.get("tags")
        tag_list = list(tags) if isinstance(tags, list) else None

        entry = await service.write(
            title,
            content,
            ScratchpadWriteOptions(tags=tag_list),
        )

        tags_text = f" Tags: {', '.join(entry.tags)}" if entry.tags else ""
        success_msg = (
            f'I\'ve saved a note titled "{entry.title}" (ID: {entry.id}).{tags_text} '
            "You can retrieve it later using the ID or by searching for it."
        )

        if callback:
            await callback(
                {
                    "text": success_msg,
                    "actions": ["SCRATCHPAD_WRITE_SUCCESS"],
                    "source": message.content.source if message.content else None,
                }
            )

        return WriteResult(success=True, text=success_msg, entry_id=entry.id)

    except Exception as exc:
        error_msg = f"Failed to save the note: {exc}"
        logger.error("[ScratchpadWrite] Error: %s", exc)
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["SCRATCHPAD_WRITE_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return WriteResult(success=False, text="Failed to write to scratchpad", error=str(exc))


async def validate_scratchpad_write(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate that the message contains scratchpad write intent."""
    text = (message.content.text if message.content else "").lower()
    return any(
        kw in text
        for kw in ("save", "note", "remember", "write", "scratchpad", "jot down", "store")
    )


SCRATCHPAD_WRITE_ACTION: dict[str, object] = {
    "name": "SCRATCHPAD_WRITE",
    "similes": [
        "SAVE_NOTE",
        "WRITE_NOTE",
        "REMEMBER_THIS",
        "SAVE_TO_SCRATCHPAD",
        "JOT_DOWN",
    ],
    "description": "Create a new scratchpad entry with a title, content, and optional tags.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Save a note about the project deadline being March 15th"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": 'I\'ve saved a note titled "Project Deadline" (ID: project-deadline). You can retrieve it later.',
                    "actions": ["SCRATCHPAD_WRITE_SUCCESS"],
                },
            },
        ],
    ],
}
