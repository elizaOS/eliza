"""
Discord Event Handlers

These handlers demonstrate custom event handling for Discord-specific features
like slash commands, reactions, and member events.

Note: Message handling is done through the elizaOS pipeline in agent.py via
message_service.handle_message() - this file is for auxiliary Discord features.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos_plugin_discord import DiscordService

from character import character

logger = logging.getLogger(__name__)


async def handle_slash_command(
    runtime: "AgentRuntime",
    service: "DiscordService",
    payload: dict,
) -> None:
    """Handle Discord slash commands."""
    command_name = payload.get("command_name", "")
    interaction = payload.get("interaction")
    
    if not interaction:
        return

    logger.info("Slash command received: /%s", command_name)

    if command_name == "ping":
        await interaction.reply(
            content="🏓 Pong! I'm alive and responding.",
            ephemeral=True,
        )
    elif command_name == "about":
        await interaction.reply(
            content=f"""👋 Hi! I'm **{character.name}**, an AI assistant powered by elizaOS.

I use:
• `elizaos` runtime for intelligent message processing
• `elizaos_plugin_discord` for Discord integration  
• `elizaos_plugin_openai` for language understanding
• `elizaos_plugin_sql` for memory persistence

Mention me or reply to my messages to chat!""",
            ephemeral=True,
        )
    elif command_name == "help":
        await interaction.reply(
            content="""**Available Commands:**
• `/ping` - Check if I'm online
• `/about` - Learn about me
• `/help` - Show this help message

You can also just @mention me in any channel to chat!""",
            ephemeral=True,
        )
    else:
        await interaction.reply(
            content=f"Unknown command: `/{command_name}`",
            ephemeral=True,
        )


async def handle_reaction_added(
    runtime: "AgentRuntime",
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
    # For example, thumbs up reactions could trigger message saving


async def handle_member_joined(
    runtime: "AgentRuntime",
    service: "DiscordService",
    payload: dict,
) -> None:
    """Handle new member events."""
    username = payload.get("username", "unknown")
    guild_id = payload.get("guild_id", "")
    display_name = payload.get("display_name", username)
    user_id = payload.get("user_id")

    logger.info("New member %s joined guild %s", username, guild_id)
    
    # Example: Send welcome DM (uncomment to enable)
    # if user_id:
    #     await service.send_dm(
    #         user_id,
    #         f"👋 Welcome to the server, {display_name}! "
    #         f"I'm {character.name}, an AI assistant. "
    #         f"Feel free to mention me if you need any help!"
    #     )


def register_discord_handlers(runtime: "AgentRuntime", service: "DiscordService") -> None:
    """
    Register Discord event handlers.
    
    Note: Main message handling is done through the elizaOS pipeline
    in agent.py. This function registers auxiliary handlers for
    slash commands and other Discord-specific features.
    """
    
    async def on_slash_command(payload: dict) -> None:
        await handle_slash_command(runtime, service, payload)
    
    async def on_reaction(payload: dict) -> None:
        await handle_reaction_added(runtime, service, payload)
    
    async def on_member_joined(payload: dict) -> None:
        await handle_member_joined(runtime, service, payload)
    
    # Register with runtime events (if supported by the Discord plugin)
    runtime.register_event("discord.slash_command", on_slash_command)
    runtime.register_event("discord.reaction_added", on_reaction)
    runtime.register_event("discord.member_joined", on_member_joined)
    
    logger.info("Registered Discord auxiliary event handlers")
