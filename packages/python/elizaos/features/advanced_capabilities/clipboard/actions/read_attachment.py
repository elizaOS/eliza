"""Clipboard read-attachment action -- read a stored attachment by ID.

Use this instead of relying on inline attachment descriptions in the
conversation context.  Set ``addToClipboard=true`` to keep the result in
bounded task clipboard state.

Ported from clipboard/actions/read-attachment.ts.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any

from elizaos.types import Action, ActionResult, Content

from ..services.task_clipboard_service import create_task_clipboard_service

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _list_conversation_attachments(
    runtime: IAgentRuntime, message: Memory
) -> list[dict[str, Any]]:
    """List attachments available in the conversation window.

    This is a simplified version -- the full TS implementation uses
    ``attachmentContext.ts`` which queries recent messages for attachments.
    """
    attachments: list[dict[str, Any]] = []

    # Check message's own attachments
    msg_attachments = getattr(message.content, "attachments", None) or []
    for att in msg_attachments:
        if isinstance(att, dict):
            attachments.append(att)
        elif hasattr(att, "id"):
            attachments.append(
                {
                    "id": att.id,
                    "title": getattr(att, "title", None) or getattr(att, "name", ""),
                    "url": getattr(att, "url", ""),
                    "content_type": getattr(att, "content_type", None)
                    or getattr(att, "contentType", None),
                    "content": getattr(att, "content", None)
                    or getattr(att, "text", None)
                    or getattr(att, "description", ""),
                }
            )

    # Try to get attachments from recent memory
    if hasattr(runtime, "get_memories"):
        try:
            recent = await runtime.get_memories(room_id=message.room_id, count=20)
            for mem in recent or []:
                mem_atts = getattr(mem.content, "attachments", None) or []
                for att in mem_atts:
                    if isinstance(att, dict):
                        if att.get("id") and att["id"] not in {a.get("id") for a in attachments}:
                            attachments.append(att)
                    elif hasattr(att, "id"):
                        if att.id not in {a.get("id") for a in attachments}:
                            attachments.append(
                                {
                                    "id": att.id,
                                    "title": getattr(att, "title", None)
                                    or getattr(att, "name", ""),
                                    "url": getattr(att, "url", ""),
                                    "content_type": getattr(att, "content_type", None)
                                    or getattr(att, "contentType", None),
                                    "content": getattr(att, "content", None)
                                    or getattr(att, "text", None)
                                    or getattr(att, "description", ""),
                                }
                            )
        except Exception:
            pass

    return attachments


def _summarize_attachment(att: dict[str, Any]) -> str:
    """Format an attachment summary."""
    title = att.get("title") or att.get("name") or att.get("id", "Unknown")
    content_type = att.get("content_type") or att.get("contentType") or "unknown"
    url = att.get("url", "")
    parts = [f"**{title}** (type: {content_type})"]
    if url:
        parts.append(f"URL: {url}")
    return "\n".join(parts)


async def _read_attachment_record(
    runtime: IAgentRuntime,
    message: Memory,
    explicit_id: str | None = None,
) -> dict[str, Any] | None:
    """Read an attachment by ID or auto-select the most recent one."""
    attachments = await _list_conversation_attachments(runtime, message)
    if not attachments:
        return None

    attachment: dict[str, Any] | None = None
    auto_selected = False

    if explicit_id:
        for att in attachments:
            if att.get("id") == explicit_id:
                attachment = att
                break
    else:
        # Auto-select the most recent
        attachment = attachments[-1] if attachments else None
        auto_selected = True

    if not attachment:
        return None

    content = (
        attachment.get("content") or attachment.get("text") or attachment.get("description") or ""
    )

    return {
        "attachment": attachment,
        "content": str(content),
        "auto_selected": auto_selected,
    }


# ---------------------------------------------------------------------------
# Action definition
# ---------------------------------------------------------------------------


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    is_request = isinstance(getattr(message.content, "attachmentId", None), str) or isinstance(
        getattr(message.content, "attachment_id", None), str
    )
    if not is_request:
        text = (message.content.text if message.content else "") or ""
        is_request = bool(re.search(r"attachment|image|screenshot|file", text, re.IGNORECASE))
    if not is_request:
        return False

    attachments = await _list_conversation_attachments(runtime, message)
    return len(attachments) > 0


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    try:
        explicit_id = getattr(message.content, "attachmentId", None) or getattr(
            message.content, "attachment_id", None
        )
        if isinstance(explicit_id, str):
            explicit_id = explicit_id.strip() or None

        result = await _read_attachment_record(runtime, message, explicit_id)
        if not result:
            attachments = await _list_conversation_attachments(runtime, message)
            if attachments:
                fallback = "Available attachments:\n" + "\n\n".join(
                    _summarize_attachment(a) for a in attachments
                )
            else:
                fallback = "No attachments are available in the current conversation window."
            if callback:
                await callback(Content(text=fallback, actions=["READ_ATTACHMENT_FAILED"]))
            return ActionResult(text=fallback, success=False)

        stored_content = result["content"].strip()
        attachment = result["attachment"]

        # Optionally store in task clipboard
        add_to_clipboard = getattr(message.content, "addToClipboard", False) or getattr(
            message.content, "add_to_clipboard", False
        )
        clipboard_msg = ""
        if add_to_clipboard:
            try:
                service = create_task_clipboard_service(runtime)
                from ..types import AddTaskClipboardItemInput, TaskClipboardSourceType

                entity_id = (
                    str(message.entity_id)
                    if hasattr(message, "entity_id") and message.entity_id
                    else None
                )
                ct = attachment.get("content_type") or attachment.get("contentType")
                source_type: TaskClipboardSourceType
                source_type = "image_attachment" if ct and "image" in str(ct) else "attachment"
                item, replaced, snapshot = await service.add_item(
                    AddTaskClipboardItemInput(
                        title=attachment.get("title") or attachment.get("id", ""),
                        content=stored_content,
                        source_type=source_type,
                        source_id=attachment.get("id"),
                        source_label=attachment.get("title") or attachment.get("url"),
                        mime_type=ct,
                    ),
                    entity_id=entity_id,
                )
                action_word = "Updated" if replaced else "Added"
                clipboard_msg = (
                    f"{action_word} clipboard item {item.id}: {item.title}\n"
                    f"Clipboard usage: {len(snapshot.items)}/{snapshot.max_items}.\n"
                    "Clear unused clipboard state when it is no longer needed."
                )
            except Exception as exc:
                clipboard_msg = f"Clipboard add skipped: {exc}"

        parts = [_summarize_attachment(attachment)]
        if result["auto_selected"]:
            parts.append("Selection: auto-selected because no attachment ID was provided.")
        if clipboard_msg:
            parts.append(clipboard_msg)
        parts.append("")
        parts.append(
            stored_content or "No stored attachment content is available for this attachment."
        )

        response_text = "\n".join(parts)

        if callback:
            await callback(Content(text=response_text, actions=["READ_ATTACHMENT_SUCCESS"]))

        return ActionResult(
            text=response_text,
            success=True,
            data={
                "attachmentId": attachment.get("id"),
                "attachment": attachment,
                "content": stored_content,
            },
        )
    except Exception as exc:
        error_msg = str(exc)
        logger.error("[ClipboardReadAttachment] Error: %s", error_msg)
        if callback:
            await callback(
                Content(
                    text=f"Failed to read attachment: {error_msg}",
                    actions=["READ_ATTACHMENT_FAILED"],
                )
            )
        return ActionResult(text="Failed to read attachment", success=False)


read_attachment_action = Action(
    name="READ_ATTACHMENT",
    similes=["OPEN_ATTACHMENT", "INSPECT_ATTACHMENT"],
    description=(
        "Read a stored attachment by attachment ID. Use this instead of relying "
        "on inline attachment descriptions in the conversation context. Set "
        "addToClipboard=true to keep the result in bounded task clipboard state."
    ),
    validate=_validate,
    handler=_handler,
    examples=[],
)
