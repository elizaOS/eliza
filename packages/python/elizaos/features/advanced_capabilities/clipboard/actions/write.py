"""Clipboard write action -- save content to the clipboard."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.clipboard_service import create_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

EXTRACT_TEMPLATE = """Extract the following information from the user's message to save to the clipboard:

User message: {text}

Respond with XML containing:
- title: A short, descriptive title for the note (required)
- content: The main content to save (required)
- tags: Comma-separated tags for categorization (optional)

<response>
<title>The note title</title>
<content>The content to save</content>
<tags>tag1, tag2</tags>
</response>"""


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    text = (message.content.text or "").lower()
    save_keywords = ["save", "note", "remember", "write", "clipboard", "jot down", "store"]
    return any(kw in text for kw in save_keywords) and "clipboard" in text


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    prompt = EXTRACT_TEMPLATE.format(text=message.content.text or "")
    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))

    if (
        not parsed
        or not isinstance(parsed.get("title"), str)
        or not isinstance(parsed.get("content"), str)
    ):
        if callback:
            await callback(
                Content(
                    text="I couldn't understand what you want me to save. Please provide a clear title and content.",
                    actions=["CLIPBOARD_WRITE_FAILED"],
                )
            )
        return ActionResult(text="Failed to extract write info", success=False)

    tags = None
    if parsed.get("tags"):
        tags = [t.strip() for t in str(parsed["tags"]).split(",") if t.strip()]

    try:
        service = create_clipboard_service(runtime)
        from ..types import ClipboardWriteOptions

        entry = await service.write(
            str(parsed["title"]),
            str(parsed["content"]),
            ClipboardWriteOptions(tags=tags),
        )
        msg = (
            f'I\'ve saved a note titled "{entry.title}" (ID: {entry.id}).'
            + (f" Tags: {', '.join(entry.tags)}" if entry.tags else "")
            + " You can retrieve it later using the ID or by searching for it."
        )
        if callback:
            await callback(Content(text=msg, actions=["CLIPBOARD_WRITE_SUCCESS"]))
        return ActionResult(text=msg, success=True, values={"entryId": entry.id})
    except Exception as e:
        if callback:
            await callback(
                Content(text=f"Failed to save the note: {e}", actions=["CLIPBOARD_WRITE_FAILED"])
            )
        return ActionResult(text="Failed to write to clipboard", success=False)


clipboard_write_action = Action(
    name="CLIPBOARD_WRITE",
    similes=["SAVE_NOTE", "WRITE_NOTE", "CLIPBOARD_SAVE"],
    description="Save content to the clipboard as a named note",
    validate=_validate,
    handler=_handler,
    examples=[],
)
