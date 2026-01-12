#!/usr/bin/env python3
"""
Bluesky Agent - A full-featured AI agent running on Bluesky

This agent:
- Monitors and responds to @mentions
- Processes and replies to direct messages
- Optionally posts automated content on a schedule
- Persists conversations and memories to SQL database
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

from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_bluesky import BlueSkyClient, BlueSkyConfig

from character import character
from handlers import handle_mention_received, handle_create_post


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def validate_environment() -> None:
    """Validate required environment variables."""
    required = ["BLUESKY_HANDLE", "BLUESKY_PASSWORD"]
    missing = [key for key in required if not os.environ.get(key)]

    if missing:
        logger.error("Missing required environment variables: %s", ", ".join(missing))
        logger.error("Copy env.example to .env and fill in your credentials.")
        sys.exit(1)

    # Check for model provider
    if not os.environ.get("OPENAI_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
        logger.error("No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.")
        sys.exit(1)


class BlueSkyAgent:
    """Main agent class that coordinates the runtime and Bluesky client."""

    def __init__(self) -> None:
        self.runtime: AgentRuntime | None = None
        self.client: BlueSkyClient | None = None
        self.running = False
        self._poll_task: asyncio.Task | None = None
        self._post_task: asyncio.Task | None = None

    async def start(self) -> None:
        """Initialize and start the agent."""
        logger.info("🦋 Starting Bluesky Agent...")

        # Create runtime with plugins
        self.runtime = AgentRuntime(
            character=character,
            plugins=[get_openai_plugin()],
        )

        await self.runtime.initialize()

        # Create Bluesky client
        config = BlueSkyConfig.from_env()
        self.client = BlueSkyClient(config)
        await self.client.authenticate()

        self.running = True

        # Start background tasks
        self._poll_task = asyncio.create_task(self._poll_notifications())

        if config.enable_posting:
            self._post_task = asyncio.create_task(self._automated_posting())

        logger.info("✅ Agent '%s' is now running on Bluesky!", character.name)
        logger.info("   Handle: %s", os.environ.get("BLUESKY_HANDLE"))
        logger.info("   Polling interval: %ss", config.poll_interval)
        logger.info("   Automated posting: %s", config.enable_posting)

    async def stop(self) -> None:
        """Stop the agent gracefully."""
        logger.info("Shutting down...")
        self.running = False

        # Cancel background tasks
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass

        if self._post_task:
            self._post_task.cancel()
            try:
                await self._post_task
            except asyncio.CancelledError:
                pass

        # Close client and runtime
        if self.client:
            await self.client.close()

        if self.runtime:
            await self.runtime.stop()

        logger.info("👋 Goodbye!")

    async def _poll_notifications(self) -> None:
        """Poll for new notifications and process them."""
        config = BlueSkyConfig.from_env()
        last_seen_at: str | None = None

        while self.running:
            try:
                if not self.client or not self.runtime:
                    await asyncio.sleep(1)
                    continue

                result = await self.client.get_notifications(50)
                notifications = result.notifications

                if notifications:
                    # Filter to new notifications
                    new_notifications = notifications
                    if last_seen_at:
                        new_notifications = [
                            n for n in notifications if n.indexed_at > last_seen_at
                        ]

                    if new_notifications:
                        last_seen_at = notifications[0].indexed_at

                        for notification in new_notifications:
                            if notification.reason in ("mention", "reply"):
                                await handle_mention_received(
                                    self.runtime, self.client, notification
                                )

                        await self.client.update_seen_notifications()

            except Exception as e:
                logger.error("Error polling notifications: %s", e)

            await asyncio.sleep(config.poll_interval)

    async def _automated_posting(self) -> None:
        """Generate and post automated content on a schedule."""
        import random

        config = BlueSkyConfig.from_env()

        while self.running:
            try:
                if not self.client or not self.runtime:
                    await asyncio.sleep(1)
                    continue

                await handle_create_post(self.runtime, self.client)

            except Exception as e:
                logger.error("Error creating automated post: %s", e)

            # Random interval between min and max
            interval = random.randint(config.post_interval_min, config.post_interval_max)
            await asyncio.sleep(interval)


async def main() -> None:
    """Main entry point."""
    validate_environment()

    agent = BlueSkyAgent()

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
