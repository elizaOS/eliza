"""MOLTBOOK_SUBMOLTS action - List or examine submolts on Moltbook."""

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
    return ("moltbook" in text or "submolt" in text) and any(
        word in text
        for word in ("list", "submolt", "communities", "subreddit", "explore", "examine", "what",
                     "show")
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

    submolt_name = (options or {}).get("submolt")

    # If a specific submolt is requested, get its details
    if submolt_name:
        submolt_result = await service.moltbook_get_submolt(submolt_name)

        if not submolt_result.success:
            if callback:
                await callback({
                    "text": f"Failed to get submolt: {submolt_result.error}",
                    "error": True,
                })
            return {
                "text": f"Failed to get submolt: {submolt_result.error}",
                "success": False,
            }

        submolt = submolt_result.data
        if not submolt:
            if callback:
                await callback({
                    "text": f'Submolt "m/{submolt_name}" not found.',
                    "error": True,
                })
            return {"text": f'Submolt "m/{submolt_name}" not found.', "success": False}

        # Also get recent posts from this submolt
        posts_result = await service.moltbook_browse(submolt_name, "hot")
        posts = posts_result.data if posts_result.success else []

        if posts:
            recent_posts = "\n".join(
                f"  - {p.get('title', '?')} by "
                f"{p.get('author', {}).get('name', 'anon') if p.get('author') else 'anon'} "
                f"({p.get('upvotes', 0)} votes)"
                for p in list(posts)[:5]
            )
        else:
            recent_posts = "  (no recent posts)"

        description = submolt.get("description", "(no description)") or "(no description)"
        subscriber_count = submolt.get("subscriber_count", "unknown")
        post_count = submolt.get("post_count", "unknown")
        created_at = submolt.get("created_at")
        created_info = f"\nCreated: {created_at}" if created_at else ""

        submolt_info = (
            f"**m/{submolt.get('name', submolt_name)}**\n"
            f"{description}\n\n"
            f"Subscribers: {subscriber_count}\n"
            f"Posts: {post_count}{created_info}\n\n"
            f"Recent posts:\n{recent_posts}"
        )

        if callback:
            await callback({
                "text": submolt_info,
                "data": {"submolt": submolt, "posts": posts},
            })

        return {
            "text": submolt_info,
            "success": True,
            "data": {"submolt": submolt, "posts": posts},
        }

    # Otherwise, list all submolts
    submolts_result = await service.moltbook_list_submolts("popular")

    if not submolts_result.success:
        if callback:
            await callback({
                "text": f"Failed to get submolts: {submolts_result.error}",
                "error": True,
            })
        return {
            "text": f"Failed to get submolts: {submolts_result.error}",
            "success": False,
        }

    submolts = submolts_result.data or []

    if not submolts:
        if callback:
            await callback({
                "text": "No submolts found on Moltbook.",
                "data": {"submolts": []},
            })
        return {
            "text": "No submolts found on Moltbook.",
            "success": True,
            "data": {"submolts": []},
        }

    formatted_submolts = "\n".join(
        f"- m/{s.get('name', '?')} - "
        f"{(s.get('description', '(no description)') or '(no description)')[:60]}"
        f"{'...' if s.get('description') and len(s.get('description', '')) > 60 else ''} "
        f"({s.get('subscriber_count', 0)} members)"
        for s in list(submolts)[:15]
    )

    text = (
        f"Available submolts on Moltbook:\n\n{formatted_submolts}\n\n"
        'Use "examine m/[name]" to see details about a specific submolt.'
    )

    if callback:
        await callback({"text": text, "data": {"submolts": submolts}})

    return {"text": text, "success": True, "data": {"submolts": submolts}}


moltbook_submolts_action = create_action(
    name="MOLTBOOK_SUBMOLTS",
    description=(
        "List available submolts (communities) on Moltbook or get details"
        " about a specific submolt."
    ),
    similes=["LIST_SUBMOLTS", "SHOW_SUBMOLTS", "MOLTBOOK_COMMUNITIES", "EXPLORE_SUBMOLTS",
             "GET_SUBMOLT", "EXAMINE_SUBMOLT"],
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "List the submolts on Moltbook"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "Let me show you the available submolts on Moltbook.",
                    "action": "MOLTBOOK_SUBMOLTS",
                },
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "What communities are there on Moltbook?"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll list the available communities for you.",
                    "action": "MOLTBOOK_SUBMOLTS",
                },
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Examine the m/iq submolt"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "Let me get the details about that submolt.",
                    "action": "MOLTBOOK_SUBMOLTS",
                },
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Show me what m/crypto is about"},
            ),
            ActionExample(
                name="{{agent}}",
                content={
                    "text": "I'll examine that submolt for you.",
                    "action": "MOLTBOOK_SUBMOLTS",
                },
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
