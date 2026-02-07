"""SCRATCHPAD_APPEND action - Append content to an existing scratchpad entry."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos_plugin_scratchpad.service import create_scratchpad_service
from elizaos_plugin_scratchpad.types import ScratchpadWriteOptions

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)

EXTRACT_TEMPLATE = """Extract the scratchpad entry ID and content to append from the user's message.

User message: {{text}}

Available scratchpad entries:
{{entries}}

Respond with XML containing:
- id: The ID of the scratchpad entry to append to (required)
- content: The new content to append (required)

<response>
<id>entry-id</id>
<content>Content to append</content>
</response>"""


def _parse_xml_field(text: str, field_name: str) -> str | None:
    """Extract a field value from XML-like response text."""
    match = re.search(rf"<{field_name}>([\s\S]*?)</{field_name}>", text)
    return match.group(1).strip() if match else None


@dataclass
class AppendResult:
    """Result of the SCRATCHPAD_APPEND action."""

    success: bool
    text: str
    error: str | None = None


async def _extract_append_info(
    runtime: IAgentRuntime,
    message: Memory,
    available_entries: str,
) -> dict[str, str] | None:
    """Use the LLM to extract the entry ID and content to append."""
    message_text = message.content.text if message.content else ""
    prompt = EXTRACT_TEMPLATE.replace("{{text}}", message_text).replace(
        "{{entries}}", available_entries
    )

    result = await runtime.use_model("TEXT_SMALL", {"prompt": prompt, "stopSequences": []})
    result_str = str(result)
    logger.debug("[ScratchpadAppend] Extract result: %s", result_str)

    entry_id = _parse_xml_field(result_str, "id")
    content = _parse_xml_field(result_str, "content")

    if not entry_id or not content:
        logger.error("[ScratchpadAppend] Failed to extract valid append info")
        return None

    return {"id": entry_id, "content": content}


async def handle_scratchpad_append(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> AppendResult | None:
    """Handle the SCRATCHPAD_APPEND action."""
    service = create_scratchpad_service(runtime)

    entries = await service.list()
    entries_context = "\n".join(f'- {e.id}: "{e.title}"' for e in entries)

    if not entries:
        msg = "There are no scratchpad entries to append to. Create one first with SCRATCHPAD_WRITE."
        if callback:
            await callback(
                {
                    "text": msg,
                    "actions": ["SCRATCHPAD_APPEND_EMPTY"],
                    "source": message.content.source if message.content else None,
                }
            )
        return AppendResult(success=False, text="No entries available")

    append_info = await _extract_append_info(runtime, message, entries_context)

    if not append_info:
        msg = f"I couldn't determine which note to update or what to add. Available entries:\n{entries_context}"
        if callback:
            await callback(
                {
                    "text": msg,
                    "actions": ["SCRATCHPAD_APPEND_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return AppendResult(success=False, text="Failed to extract append info")

    try:
        entry_id = append_info["id"]
        new_content = append_info["content"]

        exists = await service.exists(entry_id)
        if not exists:
            msg = f'Scratchpad entry "{entry_id}" not found. Available entries:\n{entries_context}'
            if callback:
                await callback(
                    {
                        "text": msg,
                        "actions": ["SCRATCHPAD_APPEND_NOT_FOUND"],
                        "source": message.content.source if message.content else None,
                    }
                )
            return AppendResult(success=False, text="Entry not found")

        existing_entry = await service.read(entry_id)

        entry = await service.write(
            existing_entry.title,
            new_content,
            ScratchpadWriteOptions(append=True, tags=existing_entry.tags or None),
        )

        success_msg = f'Successfully appended content to "{entry.title}" ({entry.id}).'
        if callback:
            await callback(
                {
                    "text": success_msg,
                    "actions": ["SCRATCHPAD_APPEND_SUCCESS"],
                    "source": message.content.source if message.content else None,
                }
            )

        return AppendResult(success=True, text=success_msg)

    except Exception as exc:
        error_msg = f"Failed to append to the note: {exc}"
        logger.error("[ScratchpadAppend] Error: %s", exc)
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["SCRATCHPAD_APPEND_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return AppendResult(
            success=False, text="Failed to append to scratchpad entry", error=str(exc)
        )


async def validate_scratchpad_append(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Always validate - selection is handled in the handler."""
    return True


SCRATCHPAD_APPEND_ACTION: dict[str, object] = {
    "name": "SCRATCHPAD_APPEND",
    "similes": [
        "ADD_TO_NOTE",
        "APPEND_NOTE",
        "UPDATE_NOTE",
        "EXTEND_NOTE",
    ],
    "description": "Append additional content to an existing scratchpad entry.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": "Add to my meeting-notes: Action item - follow up with design team"
                },
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": 'Successfully appended content to "Meeting Notes" (meeting-notes).',
                    "actions": ["SCRATCHPAD_APPEND_SUCCESS"],
                },
            },
        ],
    ],
}
