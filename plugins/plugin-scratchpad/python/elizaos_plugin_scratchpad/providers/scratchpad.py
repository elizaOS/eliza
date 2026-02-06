"""Scratchpad provider - exposes scratchpad state to agent context."""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

from elizaos_plugin_scratchpad.service import create_scratchpad_service

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


async def get_scratchpad(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide information about the user's scratchpad entries.

    Returns a summary of recent entries with previews, plus structured
    data and values for template interpolation.
    """
    try:
        service = create_scratchpad_service(runtime)
        entries = await service.list()

        if not entries:
            return ProviderResult(
                text="No scratchpad entries available.",
                data={"entries": [], "count": 0},
                values={"scratchpadCount": 0},
            )

        # Build summary text
        summary_lines: list[str] = [
            f"**Scratchpad** ({len(entries)} entries available):",
            "",
        ]

        # Show up to 5 most recent entries with previews
        for entry in entries[:5]:
            content_no_fm = re.sub(r"^---[\s\S]*?---\n*", "", entry.content, count=1).strip()
            preview = content_no_fm[:80].replace("\n", " ")

            tags_str = f" [{', '.join(entry.tags)}]" if entry.tags else ""
            summary_lines.append(f"- **{entry.title}** ({entry.id}){tags_str}")
            summary_lines.append(
                f"  {preview}{'...' if len(content_no_fm) > 80 else ''}"
            )

        if len(entries) > 5:
            summary_lines.append(f"\n_...and {len(entries) - 5} more entries_")

        summary_lines.append(
            "\n_Use SCRATCHPAD_SEARCH to find specific entries "
            "or SCRATCHPAD_READ to view full content._"
        )

        # Build data payload
        entry_data = [
            {
                "id": e.id,
                "title": e.title,
                "modifiedAt": e.modified_at.isoformat(),
                "tags": e.tags or [],
            }
            for e in entries
        ]

        return ProviderResult(
            text="\n".join(summary_lines),
            data={
                "entries": entry_data,
                "count": len(entries),
                "basePath": service.get_base_path(),
            },
            values={
                "scratchpadCount": len(entries),
                "scratchpadEntryIds": ", ".join(e.id for e in entries),
            },
        )

    except Exception as exc:
        error_msg = str(exc)
        logger.error("[ScratchpadProvider] Error: %s", error_msg)
        return ProviderResult(
            text="Scratchpad service unavailable.",
            data={"error": error_msg},
            values={"scratchpadCount": 0},
        )


SCRATCHPAD_PROVIDER = Provider(
    name="scratchpad",
    description="Provides information about the user's scratchpad entries - file-based notes and memories that persist across sessions.",
    get=get_scratchpad,
    dynamic=True,
)
