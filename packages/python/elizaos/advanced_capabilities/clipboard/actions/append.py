"""Clipboard append action -- append content to an existing entry."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.clipboard_service import create_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

EXTRACT_TEMPLATE = """Extract the clipboard entry ID and content to append from the user's message.

User message: {text}

Available clipboard entries:
{entries}

Respond with XML containing:
- id: The ID of the clipboard entry to append to (required)
- content: The new content to append (required)

<response>
<id>entry-id</id>
<content>Content to append</content>
</response>"""


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    text = (message.content.text or "").lower()
    return "clipboard" in text and "append" in text


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
            await callback(
                Content(text="There are no clipboard entries to append to. Create one first.")
            )
        return ActionResult(text="No entries available", success=False)

    prompt = EXTRACT_TEMPLATE.format(text=message.content.text or "", entries=entries_ctx)
    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))

    if (
        not parsed
        or not isinstance(parsed.get("id"), str)
        or not isinstance(parsed.get("content"), str)
    ):
        if callback:
            await callback(
                Content(
                    text=f"I couldn't determine which note to update or what to add. Available entries:\n{entries_ctx}"
                )
            )
        return ActionResult(text="Failed to extract append info", success=False)

    try:
        entry_id = str(parsed["id"])
        if not await service.exists(entry_id):
            if callback:
                await callback(
                    Content(
                        text=f'Clipboard entry "{entry_id}" not found. Available entries:\n{entries_ctx}'
                    )
                )
            return ActionResult(text="Entry not found", success=False)

        existing = await service.read(entry_id)
        from ..types import ClipboardWriteOptions

        entry = await service.write(
            existing.title,
            str(parsed["content"]),
            ClipboardWriteOptions(append=True, tags=existing.tags),
        )

        msg = f'Successfully appended content to "{entry.title}" ({entry.id}).'
        if callback:
            await callback(Content(text=msg, actions=["CLIPBOARD_APPEND_SUCCESS"]))
        return ActionResult(text=msg, success=True)
    except Exception as e:
        if callback:
            await callback(Content(text=f"Failed to append to the note: {e}"))
        return ActionResult(text="Failed to append to clipboard entry", success=False)


clipboard_append_action = Action(
    name="CLIPBOARD_APPEND",
    similes=["APPEND_NOTE", "ADD_TO_NOTE", "CLIPBOARD_ADD"],
    description="Append content to an existing clipboard entry",
    validate=_validate,
    handler=_handler,
    examples=[],
)
