"""Send message action for WhatsApp."""

import logging
from typing import Any

from elizaos.types import Action, ActionExample, Content, Memory, State

logger = logging.getLogger(__name__)

WHATSAPP_SERVICE_NAME = "whatsapp"


async def validate(runtime: Any, message: Memory) -> bool:
    """Validates if the action can be executed."""
    service = runtime.get_service(WHATSAPP_SERVICE_NAME)
    return service is not None and service.is_running


async def handler(
    runtime: Any,
    message: Memory,
    state: State | None = None,
    options: dict[str, Any] | None = None,
    callback: Any = None,
) -> Content | None:
    """Handles the send message action."""
    service = runtime.get_service(WHATSAPP_SERVICE_NAME)

    if not service or not service.is_running:
        logger.error("WhatsApp service is not available")
        if callback:
            callback(
                Content(
                    text="Sorry, WhatsApp is currently unavailable.",
                )
            )
        return None

    try:
        room = await runtime.get_room(message.room_id)
        if not room or not room.channel_id:
            logger.error("No channel ID found for room")
            if callback:
                callback(
                    Content(
                        text="Unable to determine the message recipient.",
                    )
                )
            return None

        text = message.content.text
        if not text or not text.strip():
            logger.warning("Empty message text, skipping send")
            return None

        result = await service.send_message(room.channel_id, text)
        message_id = result.messages[0].id if result.messages else None

        logger.info("Sent WhatsApp message: %s", message_id)

        content = Content(
            text=text,
            source="whatsapp",
            metadata={
                "messageId": message_id,
                "to": room.channel_id,
            },
        )

        if callback:
            callback(content)

        return content

    except Exception as e:
        logger.error("Failed to send WhatsApp message: %s", e)
        if callback:
            callback(
                Content(
                    text="Failed to send WhatsApp message.",
                )
            )
        return None


send_message_action = Action(
    name="SEND_WHATSAPP_MESSAGE",
    description="Send a message via WhatsApp Cloud API",
    similes=["WHATSAPP_SEND", "TEXT_WHATSAPP", "MESSAGE_WHATSAPP"],
    examples=[
        [
            ActionExample(
                name="{{user1}}",
                content=Content(text="Send a WhatsApp message to John"),
            ),
            ActionExample(
                name="{{agentName}}",
                content=Content(
                    text="I'll send that WhatsApp message for you.",
                    actions=["SEND_WHATSAPP_MESSAGE"],
                ),
            ),
        ],
    ],
    validate=validate,
    handler=handler,
)
