#!/usr/bin/env python3
"""
Eliza Telegram Agent Example - Python

A complete Telegram bot powered by elizaOS with SQL persistence.

Features:
- Full Telegram integration (private/group chats, reactions, inline buttons)
- PostgreSQL or PGLite database persistence
- OpenAI for language model capabilities

Required environment variables:
- TELEGRAM_BOT_TOKEN: Your Telegram bot token from @BotFather
- OPENAI_API_KEY: Your OpenAI API key
- POSTGRES_URL (optional): PostgreSQL connection string (falls back to PGLite)
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Suppress noisy HTTP logs
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)

from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_sql import sql_plugin
from elizaos_plugin_telegram import (
    TelegramConfig,
    TelegramService,
    TelegramEventType,
    TelegramContent,
    TelegramMessagePayload,
    Button,
    ButtonKind,
)


def create_character() -> Character:
    """Create the agent's character/personality."""
    return Character(
        name="TelegramEliza",
        username="telegram_eliza",
        bio="A helpful and friendly AI assistant available on Telegram. I can answer questions, have conversations, and help with various tasks.",
        system="""You are TelegramEliza, a helpful AI assistant on Telegram.
You are friendly, knowledgeable, and concise in your responses.
When users greet you with /start, welcome them warmly.
Keep responses appropriate for chat format - not too long, easy to read.
You can use emojis sparingly to make conversations more engaging.""",
    )


class TelegramAgent:
    """Encapsulates the Telegram agent with all services."""

    def __init__(self, character: Character, telegram_config: TelegramConfig) -> None:
        self.character = character
        self.telegram_config = telegram_config
        self.runtime: AgentRuntime | None = None
        self.telegram_service: TelegramService | None = None
        self._shutdown_event = asyncio.Event()

    async def start(self) -> None:
        """Initialize and start all services."""
        # Create the agent runtime with plugins
        self.runtime = AgentRuntime(
            character=self.character,
            plugins=[
                get_openai_plugin(),  # Language model capabilities
                sql_plugin,  # Database persistence (PostgreSQL or PGLite)
            ],
        )

        # Initialize the runtime
        await self.runtime.initialize()

        # Create and configure the Telegram service
        self.telegram_service = TelegramService(self.telegram_config)

        # Register /start command handler
        self.telegram_service.on_event(
            TelegramEventType.SLASH_START,
            self._handle_start_command,
        )

        # Register message handler
        self.telegram_service.on_message(self._handle_message)

        # Start the Telegram service
        await self.telegram_service.start()

        logger.info(f"✅ {self.character.name} is now running on Telegram!")

    async def _handle_start_command(self, update: object) -> None:
        """Handle the /start command from Telegram."""
        if self.telegram_service is None:
            return

        # Extract chat info from the update
        # The update is a telegram.Update object
        try:
            from telegram import Update

            if isinstance(update, Update) and update.message:
                chat_id = update.message.chat_id
                user = update.message.from_user
                username = user.first_name if user else "friend"

                logger.info(f"New user started bot: {username}")

                welcome_message = TelegramContent(
                    text=f"👋 Hello, {username}! I'm {self.character.name}.\n\n"
                    "I'm here to help you with questions, conversations, and more. "
                    "Just send me a message!",
                    buttons=[
                        Button(
                            kind=ButtonKind.URL,
                            text="Learn More",
                            url="https://elizaos.ai",
                        ),
                    ],
                )
                await self.telegram_service.send_message(chat_id, welcome_message)
        except Exception as e:
            logger.error(f"Error handling /start command: {e}")

    def _handle_message(self, payload: TelegramMessagePayload) -> None:
        """Handle incoming messages from Telegram.

        Note: This is called synchronously by the service, so we schedule
        the async processing on the event loop.
        """
        asyncio.create_task(self._process_message_async(payload))

    async def _process_message_async(self, payload: TelegramMessagePayload) -> None:
        """Process a message asynchronously."""
        if self.runtime is None or self.telegram_service is None:
            return

        if not payload.text:
            return

        chat_id = payload.chat.id
        username = payload.from_user.username if payload.from_user else None
        text = payload.text

        logger.info(f"Message from {username or 'unknown'}: {text[:50]}...")

        try:
            # Create unique IDs for this conversation context
            # In a real app, you'd persist these mappings
            user_entity_id = uuid7()
            room_id = uuid7()

            # Create a memory from the incoming message
            message = Memory(
                entity_id=user_entity_id,
                room_id=room_id,
                content=Content(
                    text=text,
                    source="telegram",
                    channel_type=ChannelType.DM.value,
                ),
            )

            # Process through the runtime
            result = await self.runtime.message_service.handle_message(
                self.runtime, message
            )

            # Send the response back to Telegram
            if result and result.response_content and result.response_content.text:
                response = TelegramContent(text=result.response_content.text)
                await self.telegram_service.send_message(chat_id, response)
            else:
                logger.warning("No response generated from runtime")

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            # Optionally send error message to user
            try:
                error_response = TelegramContent(
                    text="Sorry, I encountered an error processing your message. Please try again."
                )
                await self.telegram_service.send_message(chat_id, error_response)
            except Exception:
                pass

    async def stop(self) -> None:
        """Stop all services gracefully."""
        if self.telegram_service:
            await self.telegram_service.stop()
        if self.runtime:
            await self.runtime.stop()
        logger.info("All services stopped")

    async def wait_for_shutdown(self) -> None:
        """Wait for shutdown signal."""
        await self._shutdown_event.wait()

    def request_shutdown(self) -> None:
        """Request graceful shutdown."""
        self._shutdown_event.set()


async def main() -> None:
    """Main entry point for the Telegram agent."""
    # Validate required environment variables
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        logger.error("❌ TELEGRAM_BOT_TOKEN environment variable is required")
        logger.error("   Get your bot token from @BotFather on Telegram")
        sys.exit(1)

    openai_key = os.environ.get("OPENAI_API_KEY")
    if not openai_key:
        logger.error("❌ OPENAI_API_KEY environment variable is required")
        sys.exit(1)

    print("🚀 Starting TelegramEliza...\n")

    # Create the character
    character = create_character()

    # Configure Telegram
    telegram_config = TelegramConfig.from_env()

    # Create and start the agent
    agent = TelegramAgent(character, telegram_config)

    # Set up graceful shutdown
    def signal_handler() -> None:
        print("\n\n🛑 Shutting down...")
        agent.request_shutdown()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)

    try:
        await agent.start()

        print(f"\n✅ {character.name} is now running on Telegram!")
        print("   Send a message to your bot to start chatting.\n")
        print("Press Ctrl+C to stop.\n")

        await agent.wait_for_shutdown()

    finally:
        await agent.stop()
        print("👋 Goodbye!\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
