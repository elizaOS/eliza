"""Clipboard list action -- list all clipboard entries."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content

from ..services.clipboard_service import create_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    text = (message.content.text or "").lower()
    return "clipboard" in text and "list" in text


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    try:
        service = create_clipboard_service(runtime)
        entries = await service.list()

        if not entries:
            if callback:
                await callback(
                    Content(
                        text="You don't have any clipboard entries yet. Use CLIPBOARD_WRITE to create one.",
                    )
                )
            return ActionResult(text="No entries", success=True)

        lines = []
        for i, e in enumerate(entries):
            tags_str = f" [{', '.join(e.tags)}]" if e.tags else ""
            lines.append(
                f"{i + 1}. **{e.title}** ({e.id}){tags_str}\n"
                f"   _Modified: {e.modified_at.strftime('%Y-%m-%d')}_"
            )

        msg = f"**Your Clipboard Entries** ({len(entries)} total):\n\n" + "\n".join(lines)
        if callback:
            await callback(Content(text=msg, actions=["CLIPBOARD_LIST_SUCCESS"]))
        return ActionResult(text=msg, success=True)
    except Exception as e:
        if callback:
            await callback(Content(text=f"Failed to list clipboard entries: {e}"))
        return ActionResult(text="Failed to list clipboard entries", success=False)


clipboard_list_action = Action(
    name="CLIPBOARD_LIST",
    similes=["LIST_NOTES", "SHOW_NOTES", "CLIPBOARD_SHOW"],
    description="List all clipboard entries",
    validate=_validate,
    handler=_handler,
    examples=[],
)
