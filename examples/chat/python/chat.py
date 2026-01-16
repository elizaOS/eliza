from __future__ import annotations
import asyncio
import logging
import os
import sys
import time
from pathlib import Path

# Load .env file from repo root
from dotenv import load_dotenv
env_path = Path(__file__).resolve().parents[3] / ".env"
load_dotenv(env_path)

logging.getLogger("httpx").setLevel(logging.WARNING)

from uuid6 import uuid7

from elizaos import Character, ChannelType, Content, Memory, MemoryType, MessageMetadata
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_inmemorydb import plugin as inmemorydb_plugin

async def main() -> None:
    character = Character(name="Eliza", username="eliza", bio="A helpful AI assistant.", system="You are helpful and concise.")
    runtime = AgentRuntime(character=character, plugins=[get_openai_plugin(), inmemorydb_plugin])
    user_id = uuid7()
    room_id = uuid7()

    try:
        await runtime.initialize()
        print(f"\n🤖 Chat with {character.name} (type 'quit' to exit)\n")

        while True:
            try:
                user_input = await asyncio.to_thread(input, "You: ")
            except EOFError:
                break
            if not user_input.strip() or user_input.strip().lower() in ("quit", "exit"):
                break

            message = Memory(
                entity_id=user_id,
                room_id=room_id,
                content=Content(text=user_input, source="cli", channel_type=ChannelType.DM.value),
            )

            result = await runtime.message_service.handle_message(runtime, message)

            print(f"\n{character.name}: {result.response_content.text}\n")

        print("\nGoodbye! 👋")
    finally:
        await runtime.stop()

if __name__ == "__main__":
    asyncio.run(main())
