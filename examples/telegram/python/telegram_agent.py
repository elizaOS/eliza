#!/usr/bin/env python3
"""
Telegram bot using elizaOS with full message pipeline.

Required env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY
Optional: POSTGRES_URL (defaults to PGLite)
"""

import asyncio
import logging
import os
import signal
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)

from elizaos import Character, ChannelType, Content, Memory
from elizaos.types.primitives import string_to_uuid
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_sql import sql_plugin
from elizaos_plugin_telegram import (
    TelegramConfig,
    TelegramService,
    TelegramEventType,
    TelegramContent,
    TelegramChannelType,
    TelegramMessagePayload,
)


character = Character(
    name="TelegramEliza",
    username="telegram_eliza",
    bio="A helpful AI assistant on Telegram.",
    system="""You are TelegramEliza, a helpful AI assistant on Telegram.
Be friendly, concise, and genuinely helpful.
Keep responses short - suitable for mobile chat.""",
)

def get_ids(chat_id: int, user_id: int, thread_id: int | None) -> tuple[str, str]:
    """
    Stable IDs per Telegram chat/user for conversation continuity across restarts.

    Uses the same deterministic UUID scheme as TypeScript/Rust (`string_to_uuid`).
    """

    entity_id = string_to_uuid(f"telegram-user-{user_id}")
    room_key = (
        f"telegram-room-{chat_id}"
        if thread_id is None
        else f"telegram-room-{chat_id}-{thread_id}"
    )
    room_id = string_to_uuid(room_key)
    return entity_id, room_id


async def main() -> None:
    if not os.environ.get("TELEGRAM_BOT_TOKEN") or not os.environ.get("OPENAI_API_KEY"):
        logger.error("Missing TELEGRAM_BOT_TOKEN or OPENAI_API_KEY")
        sys.exit(1)

    logger.info("Starting TelegramEliza...")

    runtime = AgentRuntime(
        character=character,
        plugins=[get_openai_plugin(), sql_plugin],
    )
    await runtime.initialize()

    telegram_service = TelegramService(TelegramConfig.from_env())
    shutdown = asyncio.Event()

    async def handle_start(update: object) -> None:
        from telegram import Update
        if isinstance(update, Update) and update.message:
            name = update.message.from_user.first_name if update.message.from_user else "friend"
            await telegram_service.send_message(
                update.message.chat_id,
                TelegramContent(text=f"👋 Hey {name}! I'm {character.name}. How can I help?"),
            )

    def on_message(payload: TelegramMessagePayload) -> None:
        asyncio.create_task(process_message(payload))

    async def process_message(payload: TelegramMessagePayload) -> None:
        if not payload.text:
            return

        chat_id = payload.chat.id
        user_id = payload.from_user.id if payload.from_user else 0
        entity_id, room_id = get_ids(chat_id, user_id, payload.thread_id)

        channel_type = (
            ChannelType.DM.value
            if payload.chat.type == TelegramChannelType.PRIVATE
            else ChannelType.GROUP.value
        )

        # Match chat.py pattern: simple Memory with entity_id, room_id, content
        message = Memory(
            entity_id=entity_id,
            room_id=room_id,
            content=Content(text=payload.text, source="telegram", channel_type=channel_type),
        )

        result = await runtime.message_service.handle_message(runtime, message)

        if result and result.response_content and result.response_content.text:
            await telegram_service.send_message(chat_id, TelegramContent(text=result.response_content.text))

    telegram_service.on_event(TelegramEventType.SLASH_START, handle_start)
    telegram_service.on_message(on_message)
    await telegram_service.start()

    logger.info(f"{character.name} is running. Press Ctrl+C to stop.")

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown.set)

    await shutdown.wait()
    await telegram_service.stop()
    await runtime.stop()


if __name__ == "__main__":
    asyncio.run(main())
