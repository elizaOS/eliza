#!/usr/bin/env python3
"""
Farcaster Agent - OpenAI + Neynar API using the full elizaOS pipeline.

This example:
- Uses OpenAI for TEXT_SMALL/TEXT_LARGE/TEXT_EMBEDDING via elizaos-plugin-openai
- Polls Farcaster mentions and replies via the callback pattern
- Persists memories via elizaos-plugin-sql

Safety:
- Set FARCASTER_DRY_RUN=true to avoid posting.
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
from elizaos_plugin_openai import get_openai_plugin
from elizaos_plugin_farcaster import (
    FarcasterClient,
    FarcasterConfig,
    FarcasterError,
    FidRequest,
    CastId,
)

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
    _require_env("OPENAI_API_KEY")
    _require_env("FARCASTER_FID")
    _require_env("FARCASTER_SIGNER_UUID")
    _require_env("FARCASTER_NEYNAR_API_KEY")


def _truncate_to_320(text: str) -> str:
    if len(text) <= 320:
        return text
    trimmed = text.strip()
    if len(trimmed) <= 320:
        return trimmed
    return trimmed[:317] + "..."


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
class FarcasterWorldIds:
    world_id: UUID


async def _ensure_world(runtime: AgentRuntime, ids: FarcasterWorldIds) -> None:
    world = World(id=ids.world_id, name="Farcaster", agentId=runtime.agent_id, messageServerId=ids.world_id)
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
        source="farcaster",
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
    client: FarcasterClient,
    my_fid: int,
    cast_hash: str,
    cast_text: str,
    author_fid: int,
    author_username: str,
    author_display_name: str,
    parent_hash: str | None,
    world_id: UUID,
    dry_run: bool = True,
) -> None:
    # Skip self-casts.
    if author_fid == my_fid:
        return

    incoming_memory_id = string_to_uuid(f"farcaster-cast:{cast_hash}")
    existing = await runtime.get_memory_by_id(incoming_memory_id)
    if existing is not None:
        return

    room_key = parent_hash or cast_hash
    room_id = string_to_uuid(f"farcaster-room:{room_key}")

    user_entity = Entity(
        id=string_to_uuid(f"farcaster-user:{author_fid}"),
        names=[n for n in [author_display_name, author_username] if n],
        metadata={"farcaster": {"fid": author_fid, "username": author_username}},
        agentId=runtime.agent_id,
    )
    await _ensure_room_and_participants(
        runtime,
        world_id=world_id,
        room_id=room_id,
        room_name=f"farcaster:{room_key}",
        user_entity=user_entity,
    )

    url = f"https://warpcast.com/{author_username}/{cast_hash[:10]}"
    message = Memory(
        id=incoming_memory_id,
        entityId=user_entity.id,
        agentId=runtime.agent_id,
        roomId=room_id,
        worldId=world_id,
        content=Content(
            text=cast_text,
            source="farcaster",
            url=url,
            channelType=ChannelType.FEED.value,
            mentionContext=MentionContext(isMention=True, isReply=False, isThread=False, mentionType="platform_mention"),
        ),
        createdAt=int(time.time() * 1000),
    )

    async def callback(content: Content) -> list[Memory]:
        if content.target and content.target.lower() != "farcaster":
            return []

        if content.text is None or content.text.strip() == "":
            return []

        reply_text = _truncate_to_320(content.text)

        if dry_run:
            logger.info("[DRY RUN] Would reply: %s", reply_text[:100])
            return []

        try:
            # Use send_cast with in_reply_to to reply
            result = await client.send_cast(
                reply_text,
                in_reply_to=CastId(hash=cast_hash, fid=author_fid),
            )
            if not result:
                logger.error("Failed to reply to %s: empty result", cast_hash)
                return []
            reply_cast = result[0]
        except FarcasterError as e:
            logger.error("Failed to reply to %s: %s", cast_hash, str(e))
            return []

        response_memory = Memory(
            id=string_to_uuid(f"farcaster-cast:{reply_cast.hash}"),
            entityId=runtime.agent_id,
            agentId=runtime.agent_id,
            roomId=room_id,
            worldId=world_id,
            content=Content(
                text=reply_text,
                source="farcaster",
                inReplyTo=incoming_memory_id,
                channelType=ChannelType.FEED.value,
            ),
        )
        return [response_memory]

    await runtime.message_service.handle_message(runtime, message, callback)


async def main() -> None:
    print("🟣 Starting Farcaster Agent...\n")

    _load_environment()
    try:
        _validate_environment()
    except ValueError as e:
        logger.error(str(e))
        logger.error("Copy examples/farcaster/env.example to examples/farcaster/.env and fill in credentials.")
        sys.exit(1)

    runtime = AgentRuntime(
        character=character,
        plugins=[sql_plugin, get_openai_plugin()],
        log_level="INFO",
    )
    await runtime.initialize()

    # Fail fast if SQL persistence is not available.
    if runtime._adapter is None:  # noqa: SLF001
        raise RuntimeError("SQL adapter not initialized (plugin-sql failed to register an adapter)")

    config = FarcasterConfig.from_env()
    config.validate()

    ids = FarcasterWorldIds(world_id=string_to_uuid("farcaster-world"))
    await _ensure_world(runtime, ids)

    shutdown = asyncio.Event()

    def _signal_handler(sig: int, _frame: object) -> None:
        logger.info("Received signal %s, shutting down...", sig)
        shutdown.set()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    dry_run = os.getenv("FARCASTER_DRY_RUN", "true").lower() == "true"
    poll_interval = int(os.getenv("FARCASTER_POLL_INTERVAL", "120"))
    logger.info("FARCASTER_DRY_RUN=%s FARCASTER_POLL_INTERVAL=%s", dry_run, poll_interval)

    cursor_file = Path(__file__).parent / ".farcaster_cursor"
    last_seen_timestamp = 0
    if cursor_file.exists():
        raw = cursor_file.read_text(encoding="utf-8").strip()
        try:
            last_seen_timestamp = int(raw)
        except ValueError:
            last_seen_timestamp = 0

    client = FarcasterClient(config)

    logger.info("Authenticated to Farcaster as FID %s", config.fid)

    while not shutdown.is_set():
        try:
            # Use FidRequest to get mentions
            request = FidRequest(fid=config.fid, page_size=50)
            mentions = await client.get_mentions(request)
        except FarcasterError as e:
            if "429" in str(e) or "rate" in str(e).lower():
                logger.warning("Rate limited. Backing off for 60s.")
                try:
                    await asyncio.wait_for(shutdown.wait(), timeout=60.0)
                except asyncio.TimeoutError:
                    pass
                continue
            logger.error("Farcaster API error: %s", str(e))
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                pass
            continue

        candidates = []
        for cast in mentions:
            # Use timestamp from Cast object (datetime)
            cast_timestamp = int(cast.timestamp.timestamp() * 1000) if cast.timestamp else 0
            if cast_timestamp <= last_seen_timestamp:
                continue
            candidates.append((cast_timestamp, cast))

        candidates.sort(key=lambda t: t[0])

        for cast_timestamp, cast in candidates:
            if shutdown.is_set():
                break

            await _process_mention(
                runtime=runtime,
                client=client,
                my_fid=config.fid,
                cast_hash=cast.hash,
                cast_text=cast.text,
                author_fid=cast.author_fid,
                author_username=cast.profile.username if cast.profile else "",
                author_display_name=cast.profile.name if cast.profile else "",
                parent_hash=cast.in_reply_to.hash if cast.in_reply_to else None,
                world_id=ids.world_id,
                dry_run=dry_run,
            )
            last_seen_timestamp = max(last_seen_timestamp, cast_timestamp)

        cursor_file.write_text(str(last_seen_timestamp), encoding="utf-8")

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=float(poll_interval))
        except asyncio.TimeoutError:
            pass

    await client.close()
    await runtime.stop()


if __name__ == "__main__":
    asyncio.run(main())
