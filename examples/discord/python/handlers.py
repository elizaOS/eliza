"""
Discord Event Handlers

Custom handlers for Discord-specific events like messages,
reactions, and member events.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord import DiscordService

from character import character

logger = logging.getLogger(__name__)


async def handle_message_received(
    service: "DiscordService",
    payload: dict,
) -> None:
    """Handle incoming Discord messages that mention the bot."""
    content = payload.get("content", "")
    author_name = payload.get("author_name", "unknown")
    channel_id = payload.get("channel_id", "")

    if not content:
        return

    logger.info(
        "Message from %s in channel %s: %s...",
        author_name,
        channel_id,
        content[:50],
    )

    # Simple response logic - you can integrate with LLM here
    # For now, just acknowledge the message
    response = generate_response(content, author_name)
    
    if response:
        try:
            await service.send_message(channel_id, response)
            logger.info("Sent response to channel %s", channel_id)
        except Exception as e:
            logger.error("Error sending message: %s", e)


def generate_response(content: str, username: str) -> str | None:
    """Generate a response to a message.
    
    This is a simple implementation. In production, you would
    integrate with an LLM through the elizaOS runtime.
    """
    content_lower = content.lower()
    
    # Simple keyword responses
    if "hello" in content_lower or "hi" in content_lower:
        return f"👋 Hello, {username}! I'm {character.name}. How can I help you today?"
    
    if "help" in content_lower:
        return """**How I can help:**
• Ask me questions and I'll do my best to answer
• Mention me (@) in any channel to chat
• I'm here to assist with various tasks!

What would you like to know?"""
    
    if "ping" in content_lower:
        return "🏓 Pong! I'm alive and responding!"
    
    if "about" in content_lower or "who are you" in content_lower:
        return f"""👋 Hi! I'm **{character.name}**, an AI assistant powered by elizaOS.

{character.bio}

Feel free to ask me anything!"""
    
    # Default response for mentions
    return f"Hello {username}! I received your message. How can I assist you?"


async def handle_reaction_added(
    service: "DiscordService",
    payload: dict,
) -> None:
    """Handle reaction events."""
    emoji = payload.get("emoji", "")
    user_id = payload.get("user_id", "")
    message_id = payload.get("message_id", "")

    logger.debug(
        "Reaction %s added by %s on message %s",
        emoji,
        user_id,
        message_id,
    )
    # Custom reaction handling can be implemented here


async def handle_member_joined(
    service: "DiscordService",
    payload: dict,
) -> None:
    """Handle new member events."""
    username = payload.get("username", "unknown")
    guild_id = payload.get("guild_id", "")
    display_name = payload.get("display_name", username)

    logger.info("New member %s joined guild %s", username, guild_id)
    
    # Welcome message logic can be implemented here
    # Example: await service.send_dm(user_id, f"Welcome to the server, {display_name}!")
