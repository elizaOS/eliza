"""Send media action for WhatsApp plugin."""
import logging
from dataclasses import dataclass
from typing import Literal

from elizaos_plugin_whatsapp.client import WhatsAppClient
from elizaos_plugin_whatsapp.types import (
    WhatsAppMediaContent,
    WhatsAppMessage,
    WhatsAppMessageResponse,
)

logger = logging.getLogger(__name__)

SEND_MEDIA_ACTION = "WHATSAPP_SEND_MEDIA"

MediaType = Literal["image", "video", "audio", "document"]


@dataclass
class SendMediaParams:
    """Parameters for sending a WhatsApp media message."""

    to: str
    media_type: MediaType
    url: str
    caption: str | None = None
    filename: str | None = None


class SendMediaAction:
    """Action to send a WhatsApp media message."""

    name: str = SEND_MEDIA_ACTION
    description: str = "Send an image, video, audio, or document via WhatsApp"
    similes: list[str] = [
        "send whatsapp image",
        "send whatsapp video",
        "send whatsapp audio",
        "send whatsapp document",
        "share media on whatsapp",
    ]

    def __init__(self, client: WhatsAppClient):
        """Initialize the action.

        Args:
            client: WhatsApp client instance.
        """
        self.client = client

    def validate(self, params: SendMediaParams) -> tuple[bool, str | None]:
        """Validate action parameters.

        Args:
            params: Parameters to validate.

        Returns:
            Tuple of (is_valid, error_message).
        """
        if not params.to:
            return False, "Recipient phone number is required"
        if not params.url:
            return False, "Media URL is required"
        if params.media_type not in ("image", "video", "audio", "document"):
            return False, f"Invalid media type: {params.media_type}"
        return True, None

    async def handler(self, params: SendMediaParams) -> WhatsAppMessageResponse:
        """Execute the action.

        Args:
            params: Action parameters.

        Returns:
            Response from WhatsApp API.
        """
        is_valid, error = self.validate(params)
        if not is_valid:
            raise ValueError(error)

        media_content = WhatsAppMediaContent(
            link=params.url,
            caption=params.caption,
            filename=params.filename,
        )

        message = WhatsAppMessage(
            type=params.media_type,
            to=params.to,
            content=media_content,
        )

        response = await self.client.send_message(message)

        logger.info(
            "Sent WhatsApp %s to %s, message_id=%s",
            params.media_type,
            params.to,
            response.messages[0].id if response.messages else "unknown",
        )

        return response


# Action factory
def send_media_action(client: WhatsAppClient) -> SendMediaAction:
    """Create a send media action instance.

    Args:
        client: WhatsApp client instance.

    Returns:
        SendMediaAction instance.
    """
    return SendMediaAction(client)
