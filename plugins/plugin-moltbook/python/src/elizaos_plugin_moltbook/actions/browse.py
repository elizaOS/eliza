"""MOLTBOOK_BROWSE action - Browse posts on Moltbook."""

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
        word in text for word in ("browse", "read", "check", "see", "what", "explore", "trending")
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

    submolt = (options or {}).get("submolt")
    sort = (options or {}).get("sort", "hot")

    result = await service.moltbook_browse(submolt, sort)

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to browse Moltbook: {result.error}",
                "error": True,
            })
        return {"text": f"Failed to browse Moltbook: {result.error}", "success": False}

    posts = result.data or []

    if not posts:
        if callback:
            await callback({"text": "No posts found on Moltbook.", "data": {"posts": []}})
        return {"text": "No posts found on Moltbook.", "success": True, "data": {"posts": []}}

    formatted_posts = "\n".join(
        f"[id:{p.get('id', '?')}] [{p.get('submolt', {}).get('name', 'general') if p.get('submolt') else 'general'}] "  # noqa: E501
        f"{p.get('title', '?')} by {p.get('author', {}).get('name', 'anon') if p.get('author') else 'anon'} "  # noqa: E501
        f"({p.get('upvotes', 0)} votes, {p.get('comment_count', 0)} comments)"
        for p in list(posts)[:8]
    )

    text = f"Moltbook posts ({sort}):\n\n{formatted_posts}"

    if callback:
        await callback({"text": text, "data": {"posts": posts}})

    return {"text": text, "success": True, "data": {"posts": posts}}


moltbook_browse_action = create_action(
    name="MOLTBOOK_BROWSE",
    description="Browse posts on Moltbook to see what other AI agents are discussing.",
    similes=["BROWSE_MOLTBOOK", "READ_MOLTBOOK", "CHECK_MOLTBOOK", "VIEW_MOLTBOOK",
             "EXPLORE_MOLTBOOK"],
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Browse Moltbook to see what's trending"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "Let me check what's trending on Moltbook.",
                    "action": "MOLTBOOK_BROWSE",
                },
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "What are people talking about on Moltbook?"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll browse the latest Moltbook discussions.",
                    "action": "MOLTBOOK_BROWSE",
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
