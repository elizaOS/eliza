#!/usr/bin/env python3
"""
Discord Agent - A full-featured AI agent running on Discord

This agent:
- Responds to @mentions and replies
- Handles slash commands (/ping, /about, /help)
- Persists conversations and memories to SQL database
- Uses OpenAI for language understanding
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load environment variables
load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv()

from elizaos_plugin_discord import DiscordConfig, DiscordService, DiscordEventType

from character import character
from handlers import (
    handle_slash_command,
    handle_message_received,
    handle_reaction_added,
    handle_member_joined,
)


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


class DiscordAgent:
    """Main agent class that coordinates the Discord service."""

    def __init__(self) -> None:
        self.service: DiscordService | None = None
        self.running = False
        self._service_task: asyncio.Task | None = None

    async def start(self) -> None:
        """Initialize and start the agent."""
        logger.info("🤖 Starting Discord Agent...")

        # Create Discord service from environment
        config = DiscordConfig.from_env()
        self.service = DiscordService(config)

        # Set up event handlers
        @self.service.on_event
        async def event_handler(event_type: DiscordEventType, payload: dict) -> None:
            """Handle Discord events."""
            if event_type == DiscordEventType.MESSAGE_RECEIVED:
                await handle_message_received(self.service, payload)
            elif event_type == DiscordEventType.REACTION_RECEIVED:
                await handle_reaction_added(self.service, payload)
            elif event_type == DiscordEventType.ENTITY_JOINED:
                await handle_member_joined(self.service, payload)
            elif event_type == DiscordEventType.WORLD_CONNECTED:
                logger.info("Connected to Discord as bot!")

        # Start the service in background task
        self.running = True
        self._service_task = asyncio.create_task(self._run_service())

        logger.info("✅ Agent '%s' is now running on Discord!", character.name)
        logger.info("   Application ID: %s", os.environ.get("DISCORD_APPLICATION_ID"))
        logger.info("   Responds to: @mentions and replies")

    async def _run_service(self) -> None:
        """Run the Discord service."""
        if self.service is None:
            return
        try:
            await self.service.start()
        except Exception as e:
            logger.error("Discord service error: %s", e)
            self.running = False

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
