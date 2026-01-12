"""
Event handlers for Bluesky interactions.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Protocol
from uuid import uuid4

if TYPE_CHECKING:
    from typing import Optional

logger = logging.getLogger(__name__)


# Template for generating replies to mentions
REPLY_TEMPLATE = """# Task: Generate a reply to a Bluesky mention

You are {agent_name}, responding to a mention on Bluesky.

## Your Character
{bio}

## The Mention
From: @{author_handle}
Text: {mention_text}

## Guidelines
- Keep your response under 280 characters (leave room for @mention)
- Be helpful, friendly, and on-brand
- Address the user's question or comment directly
- Don't use hashtags unless relevant

Generate a concise, engaging reply:"""


# Template for generating automated posts
POST_TEMPLATE = """# Task: Generate an original Bluesky post

You are {agent_name}, creating an original post on Bluesky.

## Your Character
{bio}

## Post Examples
{post_examples}

## Guidelines
- Keep it under 300 characters
- Be engaging and on-brand
- Share something interesting, helpful, or thought-provoking
- Don't use excessive hashtags or emojis

Generate an original post:"""


class CharacterProtocol(Protocol):
    """Protocol for character configuration."""
    name: str
    bio: str | None
    post_examples: list[str] | None


class NotificationAuthor(Protocol):
    """Protocol for notification author."""
    did: str
    handle: str
    display_name: str | None


class NotificationProtocol(Protocol):
    """Protocol for notifications."""
    uri: str
    cid: str
    author: NotificationAuthor
    reason: str
    record: dict
    is_read: bool
    indexed_at: str


class TextResult(Protocol):
    """Protocol for text generation result."""
    text: str | None


class RuntimeProtocol(Protocol):
    """Protocol for the agent runtime."""
    agent_id: str
    character: CharacterProtocol

    async def generate_text(
        self, *, prompt: str, max_tokens: int, temperature: float
    ) -> TextResult:
        ...

    async def create_memory(self, memory: object, table: str) -> None:
        ...


class PostResult(Protocol):
    """Protocol for post result."""
    uri: str
    cid: str


class ClientProtocol(Protocol):
    """Protocol for the Bluesky client."""

    async def send_post(self, text: str, reply_to: dict | None = None) -> PostResult:
        ...


async def handle_mention_received(
    runtime: RuntimeProtocol,
    client: ClientProtocol,
    notification: NotificationProtocol,
) -> None:
    """
    Process an incoming mention and generate a reply.
    """
    logger.info(
        "Processing mention from @%s: %s",
        notification.author.handle,
        notification.reason,
    )

    # Skip non-mention/reply notifications
    if notification.reason not in ("mention", "reply"):
        return

    # Extract post text
    mention_text = ""
    record = notification.record
    if isinstance(record, dict):
        mention_text = record.get("text", "")
    elif hasattr(record, "text"):
        mention_text = getattr(record, "text", "") or ""

    if not mention_text.strip():
        logger.debug("Empty mention text, skipping")
        return

    # Generate reply
    prompt = REPLY_TEMPLATE.format(
        agent_name=runtime.character.name,
        bio=runtime.character.bio or "",
        author_handle=notification.author.handle,
        mention_text=mention_text,
    )

    result = await runtime.generate_text(prompt=prompt, max_tokens=100, temperature=0.7)
    reply_text = result.text.strip() if result.text else ""

    if not reply_text:
        logger.warning("Generated empty reply, skipping")
        return

    # Post the reply
    try:
        reply_ref = {"uri": notification.uri, "cid": notification.cid}
        post = await client.send_post(reply_text, reply_to=reply_ref)
        logger.info("Posted reply to @%s: %s", notification.author.handle, post.uri)

    except Exception as e:
        logger.error("Failed to post reply: %s", e)


async def handle_create_post(
    runtime: RuntimeProtocol,
    client: ClientProtocol,
) -> None:
    """
    Generate and post automated content.
    """
    logger.info("Generating automated Bluesky post")

    post_examples = "\n- ".join(runtime.character.post_examples or [])
    prompt = POST_TEMPLATE.format(
        agent_name=runtime.character.name,
        bio=runtime.character.bio or "",
        post_examples=f"- {post_examples}" if post_examples else "No examples provided",
    )

    result = await runtime.generate_text(prompt=prompt, max_tokens=100, temperature=0.8)
    post_text = result.text.strip() if result.text else ""

    if not post_text:
        logger.warning("Generated empty post, skipping")
        return

    try:
        post = await client.send_post(post_text)
        logger.info("Created automated post: %s", post.uri)

    except Exception as e:
        logger.error("Failed to create automated post: %s", e)
