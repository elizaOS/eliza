"""Send message action for BlueBubbles."""

import logging
from typing import Any

from elizaos.types import Action, ActionExample, Content, Memory, State

logger = logging.getLogger(__name__)

BLUEBUBBLES_SERVICE_NAME = "bluebubbles"


async def validate(runtime: Any, message: Memory) -> bool:
    """Validates if the action can be executed."""
    service = runtime.get_service(BLUEBUBBLES_SERVICE_NAME)
    return service is not None and service.is_running


async def handler(
    runtime: Any,
    message: Memory,
    state: State | None = None,
    options: dict[str, Any] | None = None,
    callback: Any = None,
) -> Content | None:
    """Handles the send message action."""
    service = runtime.get_service(BLUEBUBBLES_SERVICE_NAME)

    if not service or not service.is_running:
        logger.error("BlueBubbles service is not available")
        if callback:
            callback(
                Content(
                    text="Sorry, the iMessage service is currently unavailable.",
                    error="BlueBubbles service not available",
                )
            )
        return None

    try:
        # Get the room to find the target
        room = await runtime.get_room(message.room_id)
        if not room or not room.channel_id:
            logger.error("No channel ID found for room")
            if callback:
                callback(
                    Content(
                        text="Unable to determine the message recipient.",
                        error="No channel ID",
                    )
                )
            return None

        text = message.content.text
        if not text or not text.strip():
            logger.warning("Empty message text, skipping send")
            return None

        reply_to = message.content.in_reply_to

        # Send the message
        guid = await service.send_message(room.channel_id, text, reply_to)

        logger.info("Sent BlueBubbles message: %s", guid)

        content = Content(
            text=text,
            source="bluebubbles",
            metadata={
                "messageGuid": guid,
                "chatGuid": room.channel_id,
            },
        )

        if callback:
            callback(content)

        return content

    except Exception as e:
        logger.error("Failed to send BlueBubbles message: %s", e)
        if callback:
            callback(
                Content(
                    text="Failed to send the iMessage. Please try again.",
                    error=str(e),
                )
            )
        return None


send_message_action = Action(
    name="SEND_BLUEBUBBLES_MESSAGE",
    description="Send a message via iMessage through BlueBubbles",
    similes=[
        "SEND_IMESSAGE",
        "TEXT_MESSAGE",
        "IMESSAGE_REPLY",
        "BLUEBUBBLES_SEND",
        "APPLE_MESSAGE",
    ],
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content=Content(
                    text="Can you send a message to John saying I'll be late?"
                ),
            ),
            ActionExample(
                name="{{agentName}}",
                content=Content(
                    text="I'll send that message to John for you.",
                    action="SEND_BLUEBUBBLES_MESSAGE",
                ),
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content=Content(text="Reply to this iMessage for me"),
            ),
            ActionExample(
                name="{{agentName}}",
                content=Content(
                    text="I'll compose and send a reply for you.",
                    action="SEND_BLUEBUBBLES_MESSAGE",
                ),
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
