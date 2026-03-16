#!/usr/bin/env python3
"""
Discord Agent - A full-featured AI agent running on Discord

This agent uses the COMPLETE elizaOS runtime pipeline:
- Full message processing through message_service.handle_message()
- State composition with all registered providers
- Action planning and execution
- Response generation via messageHandlerTemplate
- Evaluator execution
- basicCapabilities enabled by default (REPLY, IGNORE, NONE actions)

NO shortcuts, NO bypassing the pipeline - this is canonical elizaOS.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from dotenv import load_dotenv

# Load environment variables
load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv()

from elizaos import Character, ChannelType, Content, Memory
from elizaos.types.primitives import string_to_uuid, UUID
from elizaos.runtime import AgentRuntime
from elizaos_plugin_discord import DiscordConfig, DiscordService, DiscordEventType
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_sql import sql_plugin
from uuid6 import uuid7

from character import character

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def validate_environment() -> None:
    """Validate required environment variables."""
    required = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"]
    missing = [key for key in required if not os.environ.get(key)]

    if missing:
        logger.error("Missing required environment variables: %s", ", ".join(missing))
        logger.error("Copy env.example to .env and fill in your credentials.")
        sys.exit(1)

    # Check for model provider
    if not os.environ.get("OPENAI_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
        logger.error("No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.")
        sys.exit(1)


DISCORD_WORLD_ID = string_to_uuid("discord-world")


def create_unique_uuid(runtime: AgentRuntime, base_id: str) -> UUID:
    """Create a unique UUID by combining base ID with agent ID."""
    if base_id == runtime.agent_id:
        return runtime.agent_id
    combined = f"{base_id}:{runtime.agent_id}"
    return string_to_uuid(combined)


class DiscordAgent:
    """Main agent class that coordinates the Discord service with elizaOS runtime."""

    def __init__(self) -> None:
        self.runtime: AgentRuntime | None = None
        self.service: DiscordService | None = None
        self.running = False
        self._service_task: asyncio.Task | None = None

    async def start(self) -> None:
        """Initialize and start the agent with full elizaOS runtime."""
        logger.info("🤖 Starting Discord Agent...")

        # Create the runtime with all required plugins
        self.runtime = AgentRuntime(
            character=character,
            plugins=[get_openai_plugin(), sql_plugin],
            # These are the defaults, explicitly shown for clarity:
            disable_basic_capabilities=False,  # Keep basic actions (REPLY, IGNORE, NONE)
            enable_extended_capabilities=False,  # Extended features
        )

        # Initialize the runtime
        logger.info("⏳ Initializing runtime...")
        await self.runtime.initialize()

        # Create Discord service from environment
        config = DiscordConfig.from_env()
        self.service = DiscordService(config)

        # Register the Discord service with the runtime
        if "discord" not in self.runtime.services:
            self.runtime.services["discord"] = []
        self.runtime.services["discord"].append(self.service)

        # Set up event handlers that use the FULL elizaOS pipeline
        @self.service.on_event
        async def event_handler(event_type: DiscordEventType, payload: dict) -> None:
            """Handle Discord events through elizaOS pipeline."""
            if event_type == DiscordEventType.MESSAGE_RECEIVED:
                await self._handle_message_received(payload)
            elif event_type == DiscordEventType.REACTION_RECEIVED:
                await self._handle_reaction_added(payload)
            elif event_type == DiscordEventType.ENTITY_JOINED:
                await self._handle_member_joined(payload)
            elif event_type == DiscordEventType.WORLD_CONNECTED:
                logger.info("Connected to Discord as bot!")

        # Start the service in background task
        self.running = True
        self._service_task = asyncio.create_task(self._run_service())

        logger.info("✅ Agent '%s' is now running on Discord!", character.name)
        logger.info("   Application ID: %s", os.environ.get("DISCORD_APPLICATION_ID"))
        logger.info("   Responds to: @mentions and replies")
        logger.info("\n   Using FULL elizaOS pipeline:")
        logger.info("   - State composition with providers")
        logger.info("   - shouldRespond evaluation")
        logger.info("   - Action planning & execution")
        logger.info("   - Evaluators")

    async def _run_service(self) -> None:
        """Run the Discord service."""
        if self.service is None:
            return
        try:
            await self.service.start()
        except Exception as e:
            logger.error("Discord service error: %s", e)
            self.running = False

    async def _handle_message_received(self, payload: dict) -> None:
        """Handle incoming Discord messages through the FULL elizaOS pipeline."""
        if self.runtime is None or self.service is None:
            return

        content_text = payload.get("content", "")
        author_id = payload.get("author_id", "")
        author_name = payload.get("author_name", "unknown")
        channel_id = payload.get("channel_id", "")
        guild_id = payload.get("guild_id")
        is_mention = payload.get("is_mention", False)
        is_reply = payload.get("is_reply", False)

        if not content_text:
            return

        logger.info(
            "Processing message from %s in channel %s: %s...",
            author_name,
            channel_id,
            content_text[:50],
        )

        # Create unique IDs for this conversation
        entity_id = create_unique_uuid(self.runtime, author_id)
        room_id = create_unique_uuid(self.runtime, channel_id)

        # Determine channel type
        channel_type = ChannelType.GROUP.value if guild_id else ChannelType.DM.value

        # Ensure connection exists
        await self.runtime.ensure_connection(
            entity_id=entity_id,
            room_id=room_id,
            world_id=DISCORD_WORLD_ID,
            user_name=author_name,
            name=author_name,
            source="discord",
            channel_id=channel_id,
            channel_type=channel_type,
        )

        # Create the incoming message memory
        message = Memory(
            id=str(uuid7()),
            entity_id=entity_id,
            room_id=room_id,
            content=Content(
                text=content_text,
                source="discord",
                channel_type=channel_type,
                metadata={
                    "is_mention": is_mention,
                    "is_reply": is_reply,
                    "mention_type": "platform_mention" if is_mention else ("reply" if is_reply else None),
                    "channel_id": channel_id,
                    "guild_id": guild_id,
                    "author_id": author_id,
                    "author_name": author_name,
                    "platform": "discord",
                },
            ),
        )

        # Define callback to send response to Discord
        async def callback(response_content: Content) -> list[Memory]:
            """Send the response to Discord."""
            if response_content.target and response_content.target.lower() != "discord":
                logger.debug("Response targeted to %s, skipping Discord send", response_content.target)
                return []

            if not response_content.text or not response_content.text.strip():
                logger.debug("No text in response, skipping Discord send")
                return []

            response_text = response_content.text.strip()

            # Discord message limit is 2000 chars
            if len(response_text) > 2000:
                response_text = response_text[:1997] + "..."

            try:
                await self.service.send_message(channel_id, response_text)
                logger.info("Sent response to channel %s", channel_id)

                # Create memory for the response
                response_memory = Memory(
                    id=str(uuid7()),
                    entity_id=self.runtime.agent_id,
                    room_id=room_id,
                    content=Content(
                        text=response_text,
                        source="discord",
                        in_reply_to=message.id,
                        metadata={
                            "channel_id": channel_id,
                            "platform": "discord",
                        },
                    ),
                )

                return [response_memory]

            except Exception as e:
                logger.error("Error sending message: %s", e)
                return []

        # Process through the FULL elizaOS pipeline
        if not self.runtime.message_service:
            logger.error("MessageService not available - cannot process through elizaOS pipeline")
            return

        try:
            result = await self.runtime.message_service.handle_message(
                self.runtime, message, callback
            )

            logger.debug(
                "elizaOS pipeline completed: did_respond=%s, mode=%s",
                result.did_respond if result else None,
                result.mode if result else None,
            )

        except Exception as e:
            logger.error("Error processing message through elizaOS pipeline: %s", e)

    async def _handle_reaction_added(self, payload: dict) -> None:
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

    async def _handle_member_joined(self, payload: dict) -> None:
        """Handle new member events."""
        username = payload.get("username", "unknown")
        guild_id = payload.get("guild_id", "")

        logger.info("New member %s joined guild %s", username, guild_id)
        # Welcome message logic can be implemented here

    async def stop(self) -> None:
        """Stop the agent gracefully."""
        logger.info("Shutting down...")
        self.running = False

        if self.service:
            await self.service.stop()

        if self._service_task:
            self._service_task.cancel()
            try:
                await self._service_task
            except asyncio.CancelledError:
                pass

        if self.runtime:
            await self.runtime.stop()

        logger.info("👋 Goodbye!")


async def main() -> None:
    """Main entry point."""
    validate_environment()

    agent = DiscordAgent()

    # Handle graceful shutdown
    loop = asyncio.get_event_loop()

    def signal_handler() -> None:
        asyncio.create_task(agent.stop())

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)

    try:
        await agent.start()

        # Keep running
        while agent.running:
            await asyncio.sleep(1)

    except KeyboardInterrupt:
        pass
    finally:
        await agent.stop()


if __name__ == "__main__":
    asyncio.run(main())
