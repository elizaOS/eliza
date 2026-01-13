#!/usr/bin/env python3
"""
X (Twitter) Agent - Grok (xAI) + X API v2 using the full elizaOS pipeline.

This example:
- Uses Grok for TEXT_SMALL/TEXT_LARGE/TEXT_EMBEDDING via elizaos-plugin-xai
- Polls X mentions (search @me) and replies via the callback pattern
- Persists memories via elizaos-plugin-sql

Safety:
- Set X_DRY_RUN=true to avoid posting.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from elizaos import Content, Memory, MentionContext, string_to_uuid
from elizaos.runtime import AgentRuntime
from elizaos.types.environment import ChannelType, Entity, Room, World
from elizaos.types.primitives import UUID
from elizaos_plugin_sql import sql_plugin
from elizaos_plugin_xai import TwitterClient, TwitterConfig, XClientError
from elizaos_plugin_xai.plugin import get_xai_elizaos_plugin

from character import character

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def _load_environment() -> None:
    parent_env = Path(__file__).parent.parent / ".env"
    local_env = Path(__file__).parent / ".env"

    if parent_env.exists():
        load_dotenv(parent_env)
    if local_env.exists():
        load_dotenv(local_env, override=True)


def _require_env(key: str) -> str:
    value = os.getenv(key)
    if value is None or value.strip() == "":
        raise ValueError(f"Missing required environment variable: {key}")
    return value


def _validate_environment() -> None:
    _require_env("XAI_API_KEY")

    auth_mode = (os.getenv("X_AUTH_MODE") or "env").lower()
    if auth_mode != "env":
        raise ValueError(f"This example expects X_AUTH_MODE=env (OAuth 1.0a). Got {auth_mode}")

    _require_env("X_API_KEY")
    _require_env("X_API_SECRET")
    _require_env("X_ACCESS_TOKEN")
    _require_env("X_ACCESS_TOKEN_SECRET")


def _truncate_to_280(text: str) -> str:
    if len(text) <= 280:
        return text
    trimmed = text.strip()
    if len(trimmed) <= 280:
        return trimmed
    return trimmed[:277] + "..."


def _int_from_snowflake(value: str) -> int:
    # X post IDs are snowflake-like numeric strings; store as int for monotonic comparisons.
    # If conversion fails, treat as 0 so we don't break the polling loop.
    try:
        return int(value)
    except ValueError:
        return 0


def _random_minutes(min_key: str, max_key: str, default_min: int, default_max: int) -> float:
    try:
        min_val = int(os.getenv(min_key, str(default_min)))
        max_val = int(os.getenv(max_key, str(default_max)))
    except ValueError:
        return float(default_min)

    if min_val >= max_val:
        return float(min_val)
    return random.random() * (max_val - min_val) + min_val


@dataclass(frozen=True)
class XWorldIds:
    world_id: UUID


async def _ensure_world(runtime: AgentRuntime, ids: XWorldIds) -> None:
    world = World(id=ids.world_id, name="X", agentId=runtime.agent_id, messageServerId=ids.world_id)
    await runtime.ensure_world_exists(world)

    # Ensure agent entity exists so it can participate in rooms.
    agent_entity = Entity(id=runtime.agent_id, names=[runtime.character.name], agentId=runtime.agent_id)
    await runtime.create_entities([agent_entity])


async def _ensure_room_and_participants(
    runtime: AgentRuntime,
    *,
    world_id: UUID,
    room_id: UUID,
    room_name: str,
    user_entity: Entity,
) -> None:
    await runtime.create_entities([user_entity])

    room = Room(
        id=room_id,
        name=room_name,
        agentId=runtime.agent_id,
        source="x",
        type=ChannelType.FEED,
        channelId=room_name,
        messageServerId=world_id,
        worldId=world_id,
    )
    await runtime.ensure_room_exists(room)

    await runtime.ensure_participant_in_room(user_entity.id or runtime.agent_id, room_id)
    await runtime.ensure_participant_in_room(runtime.agent_id, room_id)


async def _process_mention(
    *,
    runtime: AgentRuntime,
    x: TwitterClient,
    me_user_id: str,
    me_username: str,
    post_id: str,
    post_text: str,
    author_id: str,
    author_username: str,
    author_name: str,
    conversation_id: str | None,
    world_id: UUID,
) -> None:
    # Skip self-posts.
    if author_id == me_user_id or author_username.lower() == me_username.lower():
        return

    incoming_memory_id = string_to_uuid(f"x-post:{post_id}")
    existing = await runtime.get_memory_by_id(incoming_memory_id)
    if existing is not None:
        return

    room_key = conversation_id or post_id
    room_id = string_to_uuid(f"x-room:{room_key}")

    user_entity = Entity(
        id=string_to_uuid(f"x-user:{author_id}"),
        names=[n for n in [author_name, author_username] if n],
        metadata={"x": {"id": author_id, "username": author_username}},
        agentId=runtime.agent_id,
    )
    await _ensure_room_and_participants(
        runtime,
        world_id=world_id,
        room_id=room_id,
        room_name=f"x:{room_key}",
        user_entity=user_entity,
    )

    url = f"https://x.com/i/status/{post_id}"
    message = Memory(
        id=incoming_memory_id,
        entityId=user_entity.id,
        agentId=runtime.agent_id,
        roomId=room_id,
        worldId=world_id,
        content=Content(
            text=post_text,
            source="x",
            url=url,
            channelType=ChannelType.FEED.value,
            mentionContext=MentionContext(isMention=True, isReply=False, isThread=False, mentionType="platform_mention"),
        ),
        createdAt=int(time.time() * 1000),
    )

    async def callback(content: Content) -> list[Memory]:
        if content.target and content.target.lower() != "x":
            return []

        if content.text is None or content.text.strip() == "":
            return []

        reply_text = _truncate_to_280(content.text)

        try:
            result = await x.create_post(reply_text, reply_to=post_id)
        except XClientError as e:
            logger.error("Failed to reply to %s: %s", post_id, str(e))
            return []

        response_url = f"https://x.com/{me_username}/status/{result.id}"
        response_memory = Memory(
            id=string_to_uuid(f"x-post:{result.id}"),
            entityId=runtime.agent_id,
            agentId=runtime.agent_id,
            roomId=room_id,
            worldId=world_id,
            content=Content(
                text=reply_text,
                source="x",
                url=response_url,
                inReplyTo=incoming_memory_id,
                channelType=ChannelType.FEED.value,
            ),
        )
        return [response_memory]

    await runtime.message_service.handle_message(runtime, message, callback)


async def main() -> None:
    print("𝕏 Starting X (Grok) Agent...\n")

    _load_environment()
    try:
        _validate_environment()
    except ValueError as e:
        logger.error(str(e))
        logger.error("Copy examples/twitter-xai/env.example to examples/twitter-xai/.env and fill in credentials.")
        sys.exit(1)

    runtime = AgentRuntime(
        character=character,
        plugins=[sql_plugin, get_xai_elizaos_plugin()],
        log_level="INFO",
    )
    await runtime.initialize()

    # Fail fast if SQL persistence is not available. The Python message service can
    # run without an adapter (benchmark mode), but this example is intended to be
    # production-like and must persist dedupe state.
    if runtime._adapter is None:  # noqa: SLF001
        raise RuntimeError("SQL adapter not initialized (plugin-sql failed to register an adapter)")

    config = TwitterConfig.from_env()
    config.validate_credentials()

    ids = XWorldIds(world_id=string_to_uuid("x-world"))
    await _ensure_world(runtime, ids)

    shutdown = asyncio.Event()

    def _signal_handler(sig: int, _frame: object) -> None:
        logger.info("Received signal %s, shutting down...", sig)
        shutdown.set()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    dry_run = os.getenv("X_DRY_RUN", "false").lower() == "true"
    replies_enabled = os.getenv("X_ENABLE_REPLIES", "true").lower() != "false"
    logger.info("X_DRY_RUN=%s X_ENABLE_REPLIES=%s", dry_run, replies_enabled)

    cursor_file = Path(__file__).parent / ".x_last_seen_id"
    last_seen = 0
    if cursor_file.exists():
        raw = cursor_file.read_text(encoding="utf-8").strip()
        last_seen = _int_from_snowflake(raw)

    async with TwitterClient(config) as x:
        me = await x.me()
        logger.info("Authenticated to X as @%s (%s)", me.username, me.id)

        while not shutdown.is_set():
            if not replies_enabled:
                await asyncio.wait_for(shutdown.wait(), timeout=5.0)
                continue

            try:
                posts = []
                async for post in x.search_posts(f"@{me.username}", 50, sort_order="recency"):
                    posts.append(post)
            except XClientError as e:
                if e.status_code == 429:
                    logger.warning("Rate limited (429). Backing off for 60s.")
                    try:
                        await asyncio.wait_for(shutdown.wait(), timeout=60.0)
                    except asyncio.TimeoutError:
                        pass
                    continue
                logger.error("X API error: %s", str(e))
                try:
                    await asyncio.wait_for(shutdown.wait(), timeout=15.0)
                except asyncio.TimeoutError:
                    pass
                continue

            candidates = []
            for post in posts:
                post_num = _int_from_snowflake(post.id)
                if post_num <= last_seen:
                    continue
                if post.author_id is None or post.username is None:
                    continue
                candidates.append((post_num, post))

            candidates.sort(key=lambda t: t[0])

            for post_num, post in candidates:
                if shutdown.is_set():
                    break

                await _process_mention(
                    runtime=runtime,
                    x=x,
                    me_user_id=me.id,
                    me_username=me.username,
                    post_id=post.id,
                    post_text=post.text,
                    author_id=post.author_id or "",
                    author_username=post.username or "",
                    author_name=post.name or post.username or "",
                    conversation_id=post.conversation_id,
                    world_id=ids.world_id,
                )
                last_seen = max(last_seen, post_num)

            cursor_file.write_text(str(last_seen), encoding="utf-8")

            sleep_minutes = _random_minutes("X_ENGAGEMENT_INTERVAL_MIN", "X_ENGAGEMENT_INTERVAL_MAX", 20, 40)
            sleep_seconds = max(30.0, sleep_minutes * 60.0)
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=sleep_seconds)
            except asyncio.TimeoutError:
                pass

    await runtime.stop()


if __name__ == "__main__":
    asyncio.run(main())

