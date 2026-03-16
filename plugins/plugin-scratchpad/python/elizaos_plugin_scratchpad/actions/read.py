"""SCRATCHPAD_READ action - Read a specific scratchpad entry by ID."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos_plugin_scratchpad.service import create_scratchpad_service
from elizaos_plugin_scratchpad.types import ScratchpadReadOptions

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)

EXTRACT_TEMPLATE = """Extract the scratchpad entry ID and optional line range from the user's message.

User message: {{text}}

Available scratchpad entries:
{{entries}}

Respond with XML containing:
- id: The ID of the scratchpad entry to read (required)
- from: Starting line number (optional)
- lines: Number of lines to read (optional)

<response>
<id>entry-id</id>
<from>1</from>
<lines>10</lines>
</response>"""


def _parse_xml_field(text: str, field_name: str) -> str | None:
    """Extract a field value from XML-like response text."""
    match = re.search(rf"<{field_name}>([\s\S]*?)</{field_name}>", text)
    return match.group(1).strip() if match else None


@dataclass
class ReadResult:
    """Result of the SCRATCHPAD_READ action."""

    success: bool
    text: str
    error: str | None = None


async def _extract_read_info(
    runtime: IAgentRuntime,
    message: Memory,
    available_entries: str,
) -> dict[str, str | int] | None:
    """Use the LLM to extract the entry ID and optional line range."""
    message_text = message.content.text if message.content else ""
    prompt = EXTRACT_TEMPLATE.replace("{{text}}", message_text).replace(
        "{{entries}}", available_entries
    )

    result = await runtime.use_model("TEXT_SMALL", {"prompt": prompt, "stopSequences": []})
    result_str = str(result)
    logger.debug("[ScratchpadRead] Extract result: %s", result_str)

    entry_id = _parse_xml_field(result_str, "id")
    if not entry_id:
        logger.error("[ScratchpadRead] Failed to extract valid read info")
        return None

    info: dict[str, str | int] = {"id": entry_id}
    from_str = _parse_xml_field(result_str, "from")
    if from_str:
        try:
            info["from_line"] = int(from_str)
        except ValueError:
            pass
    lines_str = _parse_xml_field(result_str, "lines")
    if lines_str:
        try:
            info["lines"] = int(lines_str)
        except ValueError:
            pass

    return info


async def handle_scratchpad_read(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ReadResult | None:
    """Handle the SCRATCHPAD_READ action."""
    service = create_scratchpad_service(runtime)

    entries = await service.list()
    entries_context = "\n".join(f'- {e.id}: "{e.title}"' for e in entries)

    if not entries:
        msg = "There are no scratchpad entries to read. You can create one first."
        if callback:
            await callback(
                {
                    "text": msg,
                    "actions": ["SCRATCHPAD_READ_EMPTY"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ReadResult(success=False, text="No entries available")

    read_info = await _extract_read_info(runtime, message, entries_context)

    if not read_info:
        msg = f"I couldn't determine which note to read. Available entries:\n{entries_context}"
        if callback:
            await callback(
                {
                    "text": msg,
                    "actions": ["SCRATCHPAD_READ_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ReadResult(success=False, text="Failed to extract read info")

    try:
        entry_id = str(read_info["id"])
        from_line = read_info.get("from_line")
        num_lines = read_info.get("lines")
        read_opts = ScratchpadReadOptions(
            from_line=int(from_line) if from_line is not None else None,
            lines=int(num_lines) if num_lines is not None else None,
        )

        entry = await service.read(entry_id, read_opts)

        line_info = ""
        if from_line is not None:
            end_line = (int(from_line) or 1) + (int(num_lines) if num_lines is not None else 10)
            line_info = f" (lines {from_line}-{end_line})"

        success_msg = f"**{entry.title}**{line_info}\n\n{entry.content}"

        if callback:
            await callback(
                {
                    "text": success_msg,
                    "actions": ["SCRATCHPAD_READ_SUCCESS"],
                    "source": message.content.source if message.content else None,
                }
            )

        return ReadResult(success=True, text=success_msg)

    except Exception as exc:
        error_msg = f"Failed to read the note: {exc}"
        logger.error("[ScratchpadRead] Error: %s", exc)
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["SCRATCHPAD_READ_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ReadResult(success=False, text="Failed to read scratchpad entry", error=str(exc))


async def validate_scratchpad_read(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Always validate - selection is handled in the handler."""
    return True


SCRATCHPAD_READ_ACTION: dict[str, object] = {
    "name": "SCRATCHPAD_READ",
    "similes": [
        "READ_NOTE",
        "GET_NOTE",
        "VIEW_NOTE",
        "SHOW_NOTE",
        "OPEN_SCRATCHPAD",
    ],
    "description": "Read a specific scratchpad entry by its ID, with optional line range.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Read my note about project deadlines"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "**Project Deadline**\n\nThe deadline is March 15th.",
                    "actions": ["SCRATCHPAD_READ_SUCCESS"],
                },
            },
        ],
    ],
}
