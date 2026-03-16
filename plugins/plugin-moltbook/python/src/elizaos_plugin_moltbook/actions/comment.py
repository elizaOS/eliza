"""MOLTBOOK_COMMENT action - Comment on a Moltbook post."""

import logging
from typing import Any

from elizaos_plugin_moltbook.actions.base import (
    ActionExample,
    ActionResult,
    HandlerCallback,
    Memory,
    RuntimeProtocol,
    State,
    create_action,
)
from elizaos_plugin_moltbook.constants import MOLTBOOK_SERVICE_NAME
from elizaos_plugin_moltbook.services.moltbook import MoltbookService

logger = logging.getLogger(__name__)


async def validate(
    runtime: RuntimeProtocol,
    message: Memory,
    _state: State | None = None,
) -> bool:
    service = runtime.get_service(MOLTBOOK_SERVICE_NAME)
    if not service:
        return False

    text = (message.get("content", {}).get("text", "") or "").lower()
    return "moltbook" in text and any(
        word in text for word in ("comment", "reply", "respond")
    )


async def handler(
    runtime: RuntimeProtocol,
    _message: Memory,
    _state: State | None = None,
    options: dict[str, Any] | None = None,
    callback: HandlerCallback | None = None,
) -> ActionResult:
    service: MoltbookService | None = runtime.get_service(MOLTBOOK_SERVICE_NAME)
    if not service:
        if callback:
            await callback({"text": "Moltbook service is not available.", "error": True})
        return {"text": "Moltbook service is not available.", "success": False}

    post_id = (options or {}).get("postId")
    content = (options or {}).get("content")
    parent_id = (options or {}).get("parentId")

    if not post_id or not content:
        if callback:
            await callback({
                "text": "Please provide a post ID and comment content.",
                "error": True,
            })
        return {"text": "Missing postId or content", "success": False}

    try:
        if parent_id:
            # Reply to a comment
            comment_id = await service.moltbook_reply(post_id, parent_id, content)
        else:
            # Comment on the post
            comment_id = await service.moltbook_comment(post_id, content)

        if callback:
            await callback({
                "text": f"Comment posted successfully! Comment ID: {comment_id}",
                "data": {
                    "commentId": comment_id,
                    "postId": post_id,
                    "parentId": parent_id,
                },
            })

        return {
            "text": f"Comment posted successfully! Comment ID: {comment_id}",
            "success": True,
            "data": {
                "commentId": comment_id,
                "postId": post_id,
                "parentId": parent_id,
            },
        }

    except Exception as error:
        error_message = str(error)
        logger.error("Failed to comment on Moltbook: %s", error_message)
        if callback:
            await callback({
                "text": f"Failed to comment on Moltbook: {error_message}",
                "error": True,
            })
        return {
            "text": f"Failed to comment on Moltbook: {error_message}",
            "success": False,
        }


moltbook_comment_action = create_action(
    name="MOLTBOOK_COMMENT",
    description="Comment on a Moltbook post to engage with the community.",
    similes=["COMMENT_MOLTBOOK", "REPLY_MOLTBOOK", "RESPOND_MOLTBOOK"],
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Comment on that Moltbook post"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll add a comment to that Moltbook post.",
                    "action": "MOLTBOOK_COMMENT",
                },
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Reply to the discussion on Moltbook"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll reply to that Moltbook discussion.",
                    "action": "MOLTBOOK_COMMENT",
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
