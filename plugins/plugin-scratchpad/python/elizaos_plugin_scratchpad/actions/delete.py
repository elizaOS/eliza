"""SCRATCHPAD_DELETE action - Delete a scratchpad entry."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos_plugin_scratchpad.service import create_scratchpad_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)

EXTRACT_TEMPLATE = """Extract the scratchpad entry ID to delete from the user's message.

User message: {{text}}

Available scratchpad entries:
{{entries}}

Respond with XML containing:
- id: The ID of the scratchpad entry to delete (required)

<response>
<id>entry-id</id>
</response>"""


def _parse_xml_field(text: str, field_name: str) -> str | None:
    """Extract a field value from XML-like response text."""
    match = re.search(rf"<{field_name}>([\s\S]*?)</{field_name}>", text)
    return match.group(1).strip() if match else None


@dataclass
class DeleteResult:
    """Result of the SCRATCHPAD_DELETE action."""

    success: bool
    text: str
    error: str | None = None


async def _extract_delete_info(
    runtime: IAgentRuntime,
    message: Memory,
    available_entries: str,
) -> dict[str, str] | None:
    """Use the LLM to extract the entry ID to delete."""
    message_text = message.content.text if message.content else ""
    prompt = EXTRACT_TEMPLATE.replace("{{text}}", message_text).replace(
        "{{entries}}", available_entries
    )

    result = await runtime.use_model("TEXT_SMALL", {"prompt": prompt, "stopSequences": []})
    result_str = str(result)
    logger.debug("[ScratchpadDelete] Extract result: %s", result_str)

    entry_id = _parse_xml_field(result_str, "id")
    if not entry_id:
        logger.error("[ScratchpadDelete] Failed to extract valid delete info")
        return None

    return {"id": entry_id}


async def handle_scratchpad_delete(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> DeleteResult | None:
    """Handle the SCRATCHPAD_DELETE action."""
    service = create_scratchpad_service(runtime)

    entries = await service.list()
    entries_context = "\n".join(f'- {e.id}: "{e.title}"' for e in entries)

    if not entries:
        msg = "There are no scratchpad entries to delete."
        if callback:
            await callback(
                {
                    "text": msg,
                    "actions": ["SCRATCHPAD_DELETE_EMPTY"],
                    "source": message.content.source if message.content else None,
                }
            )
        return DeleteResult(success=False, text="No entries available")

    delete_info = await _extract_delete_info(runtime, message, entries_context)

    if not delete_info:
        msg = f"I couldn't determine which note to delete. Available entries:\n{entries_context}"
        if callback:
            await callback(
                {
                    "text": msg,
                    "actions": ["SCRATCHPAD_DELETE_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return DeleteResult(success=False, text="Failed to extract delete info")

    try:
        entry_id = delete_info["id"]
        deleted = await service.delete(entry_id)

        if not deleted:
            msg = f'Scratchpad entry "{entry_id}" not found.'
            if callback:
                await callback(
                    {
                        "text": msg,
                        "actions": ["SCRATCHPAD_DELETE_NOT_FOUND"],
                        "source": message.content.source if message.content else None,
                    }
                )
            return DeleteResult(success=False, text="Entry not found")

        success_msg = f'Successfully deleted scratchpad entry "{entry_id}".'
        if callback:
            await callback(
                {
                    "text": success_msg,
                    "actions": ["SCRATCHPAD_DELETE_SUCCESS"],
                    "source": message.content.source if message.content else None,
                }
            )

        return DeleteResult(success=True, text=success_msg)

    except Exception as exc:
        error_msg = f"Failed to delete the note: {exc}"
        logger.error("[ScratchpadDelete] Error: %s", exc)
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["SCRATCHPAD_DELETE_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return DeleteResult(
            success=False, text="Failed to delete scratchpad entry", error=str(exc)
        )


async def validate_scratchpad_delete(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Always validate - selection is handled in the handler."""
    return True


SCRATCHPAD_DELETE_ACTION: dict[str, object] = {
    "name": "SCRATCHPAD_DELETE",
    "similes": [
        "DELETE_NOTE",
        "REMOVE_NOTE",
        "ERASE_NOTE",
        "REMOVE_FROM_SCRATCHPAD",
    ],
    "description": "Delete a scratchpad entry by its ID.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Delete my note about meeting-notes"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": 'Successfully deleted scratchpad entry "meeting-notes".',
                    "actions": ["SCRATCHPAD_DELETE_SUCCESS"],
                },
            },
        ],
    ],
}
