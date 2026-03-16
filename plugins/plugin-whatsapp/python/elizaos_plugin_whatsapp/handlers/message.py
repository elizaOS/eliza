"""Message handler for WhatsApp plugin."""
import logging

from elizaos_plugin_whatsapp.client import WhatsAppClient, WhatsAppClientError
from elizaos_plugin_whatsapp.types import WhatsAppMessage, WhatsAppMessageResponse

logger = logging.getLogger(__name__)


class MessageHandler:
    """Handler for sending WhatsApp messages."""

    def __init__(self, client: WhatsAppClient):
        """Initialize the message handler.

        Args:
            client: WhatsApp client instance.
        """
        self.client = client

    async def send(self, message: WhatsAppMessage) -> WhatsAppMessageResponse:
        """Send a WhatsApp message.

        Args:
            message: Message to send.

        Returns:
            Response from WhatsApp API.

        Raises:
            WhatsAppClientError: If the message fails to send.
        """
        try:
            response = await self.client.send_message(message)
            logger.info(
                "Message sent successfully to %s, message_id=%s",
                message.to,
                response.messages[0].id if response.messages else "unknown",
            )
            return response
        except WhatsAppClientError as e:
            logger.error("Failed to send WhatsApp message: %s", e)
            raise
        except Exception as e:
            logger.exception("Unexpected error sending WhatsApp message")
            raise WhatsAppClientError(f"Failed to send message: {e}") from e

    async def send_text(self, to: str, text: str) -> WhatsAppMessageResponse:
        """Send a text message.

        Args:
            to: Recipient phone number.
            text: Message text.

        Returns:
            Response from WhatsApp API.
        """
        return await self.client.send_text_message(to, text)

    async def send_image(
        self, to: str, image_url: str, caption: str | None = None
    ) -> WhatsAppMessageResponse:
        """Send an image message.

        Args:
            to: Recipient phone number.
            image_url: URL of the image.
            caption: Optional caption.

        Returns:
            Response from WhatsApp API.
        """
        return await self.client.send_image(to, image_url, caption)

    async def send_video(
        self, to: str, video_url: str, caption: str | None = None
    ) -> WhatsAppMessageResponse:
        """Send a video message.

        Args:
            to: Recipient phone number.
            video_url: URL of the video.
            caption: Optional caption.

        Returns:
            Response from WhatsApp API.
        """
        return await self.client.send_video(to, video_url, caption)

    async def send_document(
        self,
        to: str,
        document_url: str,
        filename: str | None = None,
        caption: str | None = None,
    ) -> WhatsAppMessageResponse:
        """Send a document message.

        Args:
            to: Recipient phone number.
            document_url: URL of the document.
            filename: Optional filename.
            caption: Optional caption.

        Returns:
            Response from WhatsApp API.
        """
        return await self.client.send_document(to, document_url, filename, caption)

    async def send_location(
        self,
        to: str,
        latitude: float,
        longitude: float,
        name: str | None = None,
        address: str | None = None,
    ) -> WhatsAppMessageResponse:
        """Send a location message.

        Args:
            to: Recipient phone number.
            latitude: Location latitude.
            longitude: Location longitude.
            name: Optional location name.
            address: Optional location address.

        Returns:
            Response from WhatsApp API.
        """
        return await self.client.send_location(to, latitude, longitude, name, address)
