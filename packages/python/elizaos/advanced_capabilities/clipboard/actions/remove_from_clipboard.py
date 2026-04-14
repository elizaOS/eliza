"""Remove-from-clipboard action -- remove an item from the bounded clipboard.

Remove an item from the bounded clipboard when it is no longer needed for the
current task.

Ported from clipboard/actions/remove-from-clipboard.ts.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.task_clipboard_service import create_task_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _resolve_item_id(runtime: IAgentRuntime, message: Memory) -> str | None:
    """Resolve which clipboard item ID to remove."""
    # Check explicit attributes
    item_id = getattr(message.content, "itemId", None) or getattr(message.content, "item_id", None)
    if isinstance(item_id, str) and item_id.strip():
        return item_id.strip()

    content_id = getattr(message.content, "id", None)
    if isinstance(content_id, str) and content_id.strip():
        return content_id.strip()

    entity_id = (
        str(message.entity_id) if hasattr(message, "entity_id") and message.entity_id else None
    )
    service = create_task_clipboard_service(runtime)
    items = await service.list_items(entity_id)

    if len(items) == 1:
        return items[0].id if items[0] else None

    text = (message.content.text if message.content else "") or ""
    if not text.strip() or not items:
        return None

    items_ctx = "\n".join(f"- {item.id}: {item.title}" for item in items)
    prompt = (
        "Select the clipboard item ID to remove.\n\n"
        f"User message: {text}\n\n"
        "Clipboard items:\n"
        f"{items_ctx}\n\n"
        "Respond with XML:\n"
        "<response><itemId>sp-1234abcd</itemId></response>"
    )

    result = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
    parsed = parse_key_value_xml(str(result))
    if parsed and isinstance(parsed.get("itemId"), str) and parsed["itemId"].strip():
        return str(parsed["itemId"]).strip()

    return None


# ---------------------------------------------------------------------------
# Action definition
# ---------------------------------------------------------------------------


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    has_explicit_id = isinstance(
        getattr(message.content, "itemId", None) or getattr(message.content, "item_id", None),
        str,
    )
    if has_explicit_id:
        return True
    text = (message.content.text if message.content else "") or ""
    return bool(re.search(r"remove|clear|drop.*clipboard", text, re.IGNORECASE))


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    try:
        item_id = await _resolve_item_id(runtime, message)
        if not item_id:
            raise ValueError("I couldn't determine which clipboard item to remove.")

        entity_id = (
            str(message.entity_id) if hasattr(message, "entity_id") and message.entity_id else None
        )
        service = create_task_clipboard_service(runtime)
        removed, snapshot = await service.remove_item(item_id, entity_id)

        if not removed:
            raise ValueError(f"Clipboard item not found: {item_id}")

        response_text = (
            f"Removed clipboard item {item_id}. "
            f"Clipboard usage: {len(snapshot.items)}/{snapshot.max_items}."
        )

        if callback:
            await callback(
                Content(
                    text=response_text,
                    actions=["REMOVE_FROM_CLIPBOARD_SUCCESS"],
                )
            )

        return ActionResult(
            text=response_text,
            success=True,
            data={
                "itemId": item_id,
                "clipboardCount": len(snapshot.items),
                "maxItems": snapshot.max_items,
            },
        )
    except Exception as exc:
        error_msg = str(exc)
        logger.error("[RemoveFromClipboard] Error: %s", error_msg)
        if callback:
            await callback(
                Content(
                    text=f"Failed to remove clipboard item: {error_msg}",
                    actions=["REMOVE_FROM_CLIPBOARD_FAILED"],
                )
            )
        return ActionResult(text="Failed to remove clipboard item", success=False)


remove_from_clipboard_action = Action(
    name="REMOVE_FROM_CLIPBOARD",
    similes=["CLEAR_CLIPBOARD_ITEM", "DELETE_CLIPBOARD_ITEM"],
    description=(
        "Remove an item from the bounded clipboard when it is no longer "
        "needed for the current task."
    ),
    validate=_validate,
    handler=_handler,
    examples=[],
)
