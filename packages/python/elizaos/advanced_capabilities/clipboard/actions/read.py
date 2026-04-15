"""Clipboard read action -- read a clipboard entry by ID."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.clipboard_service import create_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

EXTRACT_TEMPLATE = """Extract the clipboard entry ID and optional line range from the user's message.

User message: {text}

Available clipboard entries:
{entries}

Respond with XML containing:
- id: The ID of the clipboard entry to read (required)
- from: Starting line number (optional)
- lines: Number of lines to read (optional)

<response>
<id>entry-id</id>
</response>"""


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    text = (message.content.text or "").lower()
    return "clipboard" in text and "read" in text


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
            await callback(Content(text="There are no clipboard entries to read."))
        return ActionResult(text="No entries available", success=False)

    prompt = EXTRACT_TEMPLATE.format(text=message.content.text or "", entries=entries_ctx)
    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))

    if not parsed or not isinstance(parsed.get("id"), str):
        if callback:
            await callback(
                Content(
                    text=f"I couldn't determine which note to read. Available entries:\n{entries_ctx}"
                )
            )
        return ActionResult(text="Failed to extract read info", success=False)

    try:
        from ..types import ClipboardReadOptions

        entry = await service.read(
            str(parsed["id"]),
            ClipboardReadOptions(
                from_line=int(parsed["from"]) if parsed.get("from") else None,
                lines=int(parsed["lines"]) if parsed.get("lines") else None,
            ),
        )
        msg = f"**{entry.title}**\n\n{entry.content}"
        if callback:
            await callback(Content(text=msg, actions=["CLIPBOARD_READ_SUCCESS"]))
        return ActionResult(text=msg, success=True)
    except Exception as e:
        if callback:
            await callback(Content(text=f"Failed to read the note: {e}"))
        return ActionResult(text="Failed to read clipboard entry", success=False)


clipboard_read_action = Action(
    name="CLIPBOARD_READ",
    similes=["READ_NOTE", "GET_NOTE", "CLIPBOARD_GET"],
    description="Read a clipboard entry by its ID",
    validate=_validate,
    handler=_handler,
    examples=[],
)
