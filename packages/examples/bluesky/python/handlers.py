"""
Bluesky Event Handlers

These handlers process Bluesky events through the FULL elizaOS pipeline:
- State composition with providers (CHARACTER, RECENT_MESSAGES, ACTIONS, etc.)
- shouldRespond evaluation
- Action planning and execution
- Response generation via messageHandlerTemplate
- Evaluators

This is the canonical way to handle messages in elizaOS - NO bypassing the pipeline.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from uuid6 import uuid7

from elizaos import ChannelType, Content, Memory, string_to_uuid
from elizaos.types.primitives import UUID

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos_plugin_bluesky import BlueSkyNotification, BlueSkyService

logger = logging.getLogger(__name__)

BLUESKY_SERVICE_NAME = "bluesky"
BLUESKY_WORLD_ID = string_to_uuid("bluesky-world")


def create_unique_uuid(runtime: AgentRuntime, base_id: str) -> UUID:
    """Create a unique UUID by combining base ID with agent ID."""
    if base_id == runtime.agent_id:
        return runtime.agent_id
    combined = f"{base_id}:{runtime.agent_id}"
    return string_to_uuid(combined)


def get_bluesky_service(runtime: AgentRuntime) -> BlueSkyService | None:
    """Get the BlueSky service from the runtime."""
    services = runtime.services.get(BLUESKY_SERVICE_NAME)
    if services and len(services) > 0:
        return services[0]  # type: ignore[return-value]
    return None


async def handle_mention_received(
    runtime: AgentRuntime,
    notification: BlueSkyNotification,
) -> None:
    """
    Handle incoming Bluesky mentions through the FULL elizaOS pipeline.

    This processes mentions through messageService.handleMessage() which runs:
    - State composition with all registered providers
    - shouldRespond evaluation
    - Action planning (if enabled)
    - Response generation via the full messageHandlerTemplate
    - Evaluator execution
    """
    # Skip non-mentions
    if notification.reason not in ("mention", "reply"):
        logger.debug(f"Skipping notification with reason: {notification.reason}")
        return

    # Extract text from notification
    record = notification.record or {}
    mention_text = record.get("text", "")
    if not mention_text or not mention_text.strip():
        logger.debug("Empty mention text, skipping")
        return

    logger.info(
        f"Processing Bluesky mention from @{notification.author.handle}: {mention_text[:50]}..."
    )

    # Create unique IDs for this conversation
    entity_id = create_unique_uuid(runtime, notification.author.did)
    room_id = create_unique_uuid(runtime, notification.uri)

    # Ensure the connection exists
    # Note: ensure_connection signature is (entity_id, room_id, world_id, ...)
    await runtime.ensure_connection(
        entity_id=entity_id,
        room_id=room_id,
        world_id=BLUESKY_WORLD_ID,
        user_name=notification.author.handle,
        name=notification.author.display_name or notification.author.handle,
        source="bluesky",
        channel_id=notification.uri,
        channel_type=ChannelType.GROUP.value,
    )

    # Create the incoming message memory
    message = Memory(
        id=str(uuid7()),
        entity_id=entity_id,
        room_id=room_id,
        content=Content(
            text=mention_text,
            source="bluesky",
            channel_type=ChannelType.GROUP.value,
            # Include mention context for shouldRespond evaluation
            metadata={
                "is_mention": notification.reason == "mention",
                "is_reply": notification.reason == "reply",
                "mention_type": "platform_mention" if notification.reason == "mention" else "reply",
                "uri": notification.uri,
                "cid": notification.cid,
                "author_did": notification.author.did,
                "author_handle": notification.author.handle,
                "platform": "bluesky",
            },
        ),
    )

    # Get the BlueSky service for posting replies
    bluesky_service = get_bluesky_service(runtime)
    if not bluesky_service:
        logger.error("BlueSky service not available, cannot post reply")
        return

    # Define callback to post response to Bluesky
    async def callback(content: Content) -> list[Memory]:
        """Post the response to Bluesky."""
        # Check if response is targeted elsewhere
        if content.target and content.target.lower() != "bluesky":
            logger.debug(f"Response targeted to {content.target}, skipping Bluesky post")
            return []

        if not content.text or not content.text.strip():
            logger.debug("No text in response, skipping Bluesky post")
            return []

        # Truncate to Bluesky's limit (300 chars)
        response_text = content.text.strip()
        if len(response_text) > 300:
            response_text = response_text[:297] + "..."

        try:
            from elizaos_plugin_bluesky import CreatePostRequest

            # Post the reply
            post = await bluesky_service.client.send_post(
                CreatePostRequest(
                    content=Content(text=response_text),
                    reply_to={"uri": notification.uri, "cid": notification.cid},
                )
            )

            logger.info(f"Posted reply to @{notification.author.handle}: {post.uri}")

            # Create memory for the response
            response_memory = Memory(
                id=str(uuid7()),
                entity_id=runtime.agent_id,
                room_id=room_id,
                content=Content(
                    text=response_text,
                    source="bluesky",
                    in_reply_to=message.id,
                    metadata={
                        "uri": post.uri,
                        "cid": post.cid,
                        "platform": "bluesky",
                    },
                ),
            )

            return [response_memory]

        except Exception as e:
            logger.error(f"Failed to post reply: {e}")
            return []

    # Process through the FULL elizaOS pipeline
    if not runtime.message_service:
        logger.error("MessageService not available - cannot process through elizaOS pipeline")
        return

    try:
        result = await runtime.message_service.handle_message(runtime, message, callback)

        logger.debug(
            f"elizaOS pipeline completed: did_respond={result.did_respond}, mode={result.mode}"
        )

    except Exception as e:
        logger.error(f"Error processing message through elizaOS pipeline: {e}")


async def handle_should_respond(
    runtime: AgentRuntime,
    notification: BlueSkyNotification,
) -> None:
    """Handle should_respond events by routing to handle_mention_received."""
    if notification.reason in ("mention", "reply"):
        await handle_mention_received(runtime, notification)


async def handle_create_post(
    runtime: AgentRuntime,
    automated: bool = True,
) -> None:
    """
    Handle automated post creation through the elizaOS pipeline.
    """
    if not automated:
        return

    logger.info("Generating automated Bluesky post via elizaOS pipeline")

    bluesky_service = get_bluesky_service(runtime)
    if not bluesky_service:
        logger.error("BlueSky service not available for automated posting")
        return

    # Create a room for automated posts
    room_id = create_unique_uuid(runtime, "bluesky-automated-posts")

    # Note: ensure_connection signature is (entity_id, room_id, world_id, ...)
    await runtime.ensure_connection(
        entity_id=runtime.agent_id,
        room_id=room_id,
        world_id=BLUESKY_WORLD_ID,
        user_name=runtime.character.name,
        name=runtime.character.name,
        source="bluesky",
        channel_id="automated-posts",
        channel_type=ChannelType.SELF.value,
    )

    # Create trigger message for post generation
    trigger_message = Memory(
        id=str(uuid7()),
        entity_id=runtime.agent_id,
        room_id=room_id,
        content=Content(
            text="Generate a new post for Bluesky",
            source="bluesky",
            metadata={
                "is_automated_post_trigger": True,
                "platform": "bluesky",
                "max_length": 300,
            },
        ),
    )

    async def callback(content: Content) -> list[Memory]:
        """Post the generated content to Bluesky."""
        if not content.text or not content.text.strip():
            logger.debug("No text generated for automated post")
            return []

        post_text = content.text.strip()
        if len(post_text) > 300:
            post_text = post_text[:297] + "..."

        try:
            from elizaos_plugin_bluesky import CreatePostRequest

            post = await bluesky_service.client.send_post(
                CreatePostRequest(content=Content(text=post_text))
            )

            logger.info(f"Created automated post: {post.uri}")

            post_memory = Memory(
                id=str(uuid7()),
                entity_id=runtime.agent_id,
                room_id=room_id,
                content=Content(
                    text=post_text,
                    source="bluesky",
                    metadata={
                        "uri": post.uri,
                        "cid": post.cid,
                        "platform": "bluesky",
                        "automated": True,
                    },
                ),
            )

            return [post_memory]

        except Exception as e:
            logger.error(f"Failed to create automated post: {e}")
            return []

    if not runtime.message_service:
        logger.error("MessageService not available for automated posting")
        return

    try:
        await runtime.message_service.handle_message(runtime, trigger_message, callback)
    except Exception as e:
        logger.error(f"Error generating automated post: {e}")


def register_bluesky_handlers(runtime: AgentRuntime) -> None:
    """
    Register all Bluesky event handlers with the runtime.

    These handlers integrate with the BlueSky plugin's event system:
    - bluesky.mention_received: When the agent is mentioned in a post
    - bluesky.should_respond: Trigger to evaluate and respond to a notification
    - bluesky.create_post: Trigger for automated post generation
    """

    async def on_mention_received(payload: dict[str, Any]) -> None:
        notification = payload.get("notification")
        if notification:
            await handle_mention_received(runtime, notification)

    async def on_should_respond(payload: dict[str, Any]) -> None:
        notification = payload.get("notification")
        if notification:
            await handle_should_respond(runtime, notification)

    async def on_create_post(payload: dict[str, Any]) -> None:
        automated = payload.get("automated", True)
        await handle_create_post(runtime, automated=automated)

    runtime.register_event("bluesky.mention_received", on_mention_received)
    runtime.register_event("bluesky.should_respond", on_should_respond)
    runtime.register_event("bluesky.create_post", on_create_post)

    logger.info("Registered Bluesky event handlers (full elizaOS pipeline)")
