"""MOLTBOOK_READ action - Read a specific Moltbook post with comments."""

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
        phrase in text
        for phrase in ("read post", "view post", "open post", "show post", "get post")
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

    if not post_id:
        if callback:
            await callback({
                "text": "Please provide a post ID to read.",
                "error": True,
            })
        return {"text": "Missing postId", "success": False}

    try:
        result = await service.moltbook_read_post(post_id)
        post = result.post
        comments = result.comments

        if comments:
            formatted_comments = "\n".join(
                f"  - {c.get('author', {}).get('name', 'anon') if c.get('author') else 'anon'}: "
                f"{c.get('content', '')[:200]}{'...' if len(c.get('content', '')) > 200 else ''}"
                for c in comments[:10]
            )
        else:
            formatted_comments = "  (no comments yet)"

        post_content = post.get("content") or post.get("body") or "(no content)"
        truncated_content = (
            f"{post_content[:500]}..." if len(post_content) > 500 else post_content
        )

        submolt_name = (
            post.get("submolt", {}).get("name", "general")
            if post.get("submolt") else "general"
        )
        author_name = (
            post.get("author", {}).get("name", "anon")
            if post.get("author") else "anon"
        )

        formatted_post = (
            f"**{post.get('title', '?')}**\n"
            f"by {author_name} in r/{submolt_name}\n"
            f"{post.get('upvotes', 0)} upvotes | {post.get('comment_count', 0)} comments\n\n"
            f"{truncated_content}\n\n"
            f"Comments:\n{formatted_comments}"
        )

        if callback:
            await callback({
                "text": formatted_post,
                "data": {"post": post, "comments": comments},
            })

        return {
            "text": formatted_post,
            "success": True,
            "data": {"post": post, "comments": comments},
        }

    except Exception as error:
        error_message = str(error)
        logger.error("Failed to read Moltbook post: %s", error_message)
        if callback:
            await callback({
                "text": f"Failed to read Moltbook post: {error_message}",
                "error": True,
            })
        return {
            "text": f"Failed to read Moltbook post: {error_message}",
            "success": False,
        }


moltbook_read_action = create_action(
    name="MOLTBOOK_READ",
    description=(
        "Read a specific Moltbook post with its comments to see the full discussion."
    ),
    similes=["READ_MOLTBOOK_POST", "VIEW_MOLTBOOK_POST", "GET_MOLTBOOK_POST",
             "OPEN_MOLTBOOK_POST"],
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Read Moltbook post abc123"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "Let me fetch that Moltbook post for you.",
                    "action": "MOLTBOOK_READ",
                },
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Show me the Moltbook post with ID xyz789"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll retrieve that post from Moltbook.",
                    "action": "MOLTBOOK_READ",
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
