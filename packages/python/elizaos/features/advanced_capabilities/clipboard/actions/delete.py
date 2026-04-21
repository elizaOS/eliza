"""Clipboard delete action -- remove a clipboard entry."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.clipboard_service import create_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

EXTRACT_TEMPLATE = """Extract the clipboard entry ID to delete from the user's message.

User message: {text}

Available clipboard entries:
{entries}

Respond with XML containing:
- id: The ID of the clipboard entry to delete (required)

<response>
<id>entry-id</id>
</response>"""


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    text = (message.content.text or "").lower()
    return "clipboard" in text and "delete" in text


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    service = create_clipboard_service(runtime)
    entries = await service.list()
    entries_ctx = "\n".join(f'- {e.id}: "{e.title}"' for e in entries)

    if not entries:
        if callback:
            await callback(Content(text="There are no clipboard entries to delete."))
        return ActionResult(text="No entries available", success=False)

    prompt = EXTRACT_TEMPLATE.format(text=message.content.text or "", entries=entries_ctx)
    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))

    if not parsed or not isinstance(parsed.get("id"), str):
        if callback:
            await callback(
                Content(
                    text=f"I couldn't determine which note to delete. Available entries:\n{entries_ctx}"
                )
            )
        return ActionResult(text="Failed to extract delete info", success=False)

    try:
        deleted = await service.delete(str(parsed["id"]))
        if not deleted:
            if callback:
                await callback(Content(text=f'Clipboard entry "{parsed["id"]}" not found.'))
            return ActionResult(text="Entry not found", success=False)

        msg = f'Successfully deleted clipboard entry "{parsed["id"]}".'
        if callback:
            await callback(Content(text=msg, actions=["CLIPBOARD_DELETE_SUCCESS"]))
        return ActionResult(text=msg, success=True)
    except Exception as e:
        if callback:
            await callback(Content(text=f"Failed to delete the note: {e}"))
        return ActionResult(text="Failed to delete clipboard entry", success=False)


clipboard_delete_action = Action(
    name="CLIPBOARD_DELETE",
    similes=["DELETE_NOTE", "REMOVE_NOTE", "CLIPBOARD_REMOVE"],
    description="Delete a clipboard entry by ID",
    validate=_validate,
    handler=_handler,
    examples=[],
)
