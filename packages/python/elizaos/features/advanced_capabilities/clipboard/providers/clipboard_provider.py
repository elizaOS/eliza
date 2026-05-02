"""Clipboard provider -- injects bounded task clipboard state into agent context."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

from ..services.task_clipboard_service import create_task_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


def _preview_content(content: str) -> str:
    import re

    return re.sub(r"\s+", " ", content).strip()[:140]


async def _get_clipboard(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    try:
        entity_id = str(message.entity_id) if message.entity_id else None
        service = create_task_clipboard_service(runtime)
        snapshot = await service.get_snapshot(entity_id)
        count = len(snapshot.items)

        lines = [f"Clipboard usage: {count}/{snapshot.max_items}."]
        if count > 0:
            lines.append("Clear unused clipboard state when it is no longer needed.")

            if count >= snapshot.max_items - 1:
                oldest = snapshot.items[-1]
                lines.append(
                    f"WARNING: Clipboard is "
                    f"{'FULL' if count >= snapshot.max_items else 'nearly full'}. "
                    f"Remove the least relevant item before adding new content. "
                    f'Least recently updated: {oldest.id} ("{oldest.title[:40]}"). '
                    f"Use REMOVE_FROM_CLIPBOARD to free a slot."
                )

            lines.append("")
            for item in snapshot.items:
                lines.append(f"- {item.id}: {item.title}")
                source_info = f"  source={item.source_type}"
                if item.source_id:
                    source_info += f" ({item.source_id})"
                lines.append(source_info)
                lines.append(f"  {_preview_content(item.content)}")
        else:
            lines.append("No clipboard items are currently stored.")

        return ProviderResult(
            text="\n".join(lines),
            data={
                "items": [
                    {
                        "id": item.id,
                        "title": item.title,
                        "sourceType": item.source_type,
                    }
                    for item in snapshot.items
                ],
                "count": count,
                "maxItems": snapshot.max_items,
            },
            values={
                "clipboardCount": count,
                "clipboardUsage": f"{count}/{snapshot.max_items}",
                "clipboardItemIds": ", ".join(item.id for item in snapshot.items),
            },
        )
    except Exception as e:
        logger.error("[ClipboardProvider] Error: %s", e)
        return ProviderResult(
            text="Clipboard usage: unavailable.",
            data={"items": [], "count": 0, "error": str(e)},
            values={"clipboardCount": 0, "clipboardUsage": "0/10"},
        )


clipboard_provider = Provider(
    name="clipboard",
    description="Bounded task clipboard state. Each item has a stable ID and stays available in context until removed.",
    get=_get_clipboard,
    dynamic=True,
)
