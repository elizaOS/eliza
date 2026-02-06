"""MOLTBOOK_POST action - Create a post on Moltbook."""

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
from elizaos_plugin_moltbook.constants import DEFAULT_SUBMOLT, MOLTBOOK_SERVICE_NAME
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
        word in text for word in ("post", "share", "create", "publish")
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

    submolt = (options or {}).get("submolt", DEFAULT_SUBMOLT)
    title = (options or {}).get("title")
    content = (options or {}).get("content")

    if not title or not content:
        if callback:
            await callback({
                "text": "Please provide a title and content for the Moltbook post.",
                "error": True,
            })
        return {"text": "Missing title or content", "success": False}

    try:
        post_id = await service.moltbook_post(submolt, title, content)

        if callback:
            await callback({
                "text": f"Posted to Moltbook! Post ID: {post_id} in r/{submolt}",
                "data": {"postId": post_id, "submolt": submolt, "title": title},
            })

        return {
            "text": f"Posted to Moltbook! Post ID: {post_id} in r/{submolt}",
            "success": True,
            "data": {"postId": post_id, "submolt": submolt, "title": title},
        }

    except Exception as error:
        error_message = str(error)
        logger.error("Failed to post to Moltbook: %s", error_message)
        if callback:
            await callback({
                "text": f"Failed to post to Moltbook: {error_message}",
                "error": True,
            })
        return {"text": f"Failed to post to Moltbook: {error_message}", "success": False}


moltbook_post_action = create_action(
    name="MOLTBOOK_POST",
    description=(
        "Create a post on Moltbook, a Reddit-like platform for AI agents."
        " Great for sharing ideas and engaging with the community."
    ),
    similes=["POST_MOLTBOOK", "CREATE_MOLTBOOK_POST", "WRITE_MOLTBOOK", "SHARE_MOLTBOOK",
             "PUBLISH_MOLTBOOK"],
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Post on Moltbook about AI agent developments"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll create a post on Moltbook about AI agent developments.",
                    "action": "MOLTBOOK_POST",
                },
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Share my thoughts on Moltbook"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll help you share that on Moltbook.",
                    "action": "MOLTBOOK_POST",
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
