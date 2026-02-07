"""SCRATCHPAD_LIST action - List all scratchpad entries."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos_plugin_scratchpad.service import create_scratchpad_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


@dataclass
class ListResult:
    """Result of the SCRATCHPAD_LIST action."""

    success: bool
    text: str
    error: str | None = None


async def handle_scratchpad_list(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ListResult | None:
    """Handle the SCRATCHPAD_LIST action."""
    try:
        service = create_scratchpad_service(runtime)
        entries = await service.list()

        if not entries:
            msg = "You don't have any scratchpad entries yet. Use SCRATCHPAD_WRITE to create one."
            if callback:
                await callback(
                    {
                        "text": msg,
                        "actions": ["SCRATCHPAD_LIST_EMPTY"],
                        "source": message.content.source if message.content else None,
                    }
                )
            return ListResult(success=True, text="No entries")

        lines: list[str] = []
        for i, entry in enumerate(entries):
            tags_str = f" [{', '.join(entry.tags)}]" if entry.tags else ""
            lines.append(
                f"{i + 1}. **{entry.title}** ({entry.id}){tags_str}\n"
                f"   _Modified: {entry.modified_at.strftime('%Y-%m-%d')}_"
            )

        list_text = "\n".join(lines)
        success_msg = f"**Your Scratchpad Entries** ({len(entries)} total):\n\n{list_text}"

        if callback:
            await callback(
                {
                    "text": success_msg,
                    "actions": ["SCRATCHPAD_LIST_SUCCESS"],
                    "source": message.content.source if message.content else None,
                }
            )

        return ListResult(success=True, text=success_msg)

    except Exception as exc:
        error_msg = f"Failed to list scratchpad entries: {exc}"
        logger.error("[ScratchpadList] Error: %s", exc)
        if callback:
            await callback(
                {
                    "text": error_msg,
                    "actions": ["SCRATCHPAD_LIST_FAILED"],
                    "source": message.content.source if message.content else None,
                }
            )
        return ListResult(success=False, text="Failed to list scratchpad entries", error=str(exc))


async def validate_scratchpad_list(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Always validate - listing is always allowed."""
    return True


SCRATCHPAD_LIST_ACTION: dict[str, object] = {
    "name": "SCRATCHPAD_LIST",
    "similes": [
        "LIST_NOTES",
        "SHOW_NOTES",
        "MY_NOTES",
        "ALL_NOTES",
        "SHOW_SCRATCHPAD",
    ],
    "description": "List all scratchpad entries with their titles, IDs, tags, and modification dates.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Show me all my saved notes"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "**Your Scratchpad Entries** (2 total):\n\n1. **Meeting Notes** (meeting-notes)\n2. **Project Ideas** (project-ideas)",
                    "actions": ["SCRATCHPAD_LIST_SUCCESS"],
                },
            },
        ],
    ],
}
