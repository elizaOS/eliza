"""Send interactive message action for WhatsApp plugin."""
import logging
from dataclasses import dataclass, field
from typing import Literal

from elizaos_plugin_whatsapp.client import WhatsAppClient
from elizaos_plugin_whatsapp.types import (
    WhatsAppInteractiveAction,
    WhatsAppInteractiveContent,
    WhatsAppMessage,
    WhatsAppMessageResponse,
)

logger = logging.getLogger(__name__)

SEND_INTERACTIVE_ACTION = "WHATSAPP_SEND_INTERACTIVE"

InteractiveType = Literal["button", "list"]


@dataclass
class InteractiveButton:
    """Interactive button definition."""

    id: str
    title: str


@dataclass
class ListRow:
    """List row definition."""

    id: str
    title: str
    description: str | None = None


@dataclass
class ListSection:
    """List section definition."""

    title: str
    rows: list[ListRow] = field(default_factory=list)


@dataclass
class SendInteractiveParams:
    """Parameters for sending a WhatsApp interactive message."""

    to: str
    interactive_type: InteractiveType
    body_text: str
    buttons: list[InteractiveButton] | None = None
    sections: list[ListSection] | None = None
    list_button_text: str | None = None
    header_text: str | None = None
    footer_text: str | None = None


class SendInteractiveAction:
    """Action to send a WhatsApp interactive message."""

    name: str = SEND_INTERACTIVE_ACTION
    description: str = "Send an interactive button or list message via WhatsApp"
    similes: list[str] = [
        "send whatsapp buttons",
        "send whatsapp list",
        "interactive whatsapp message",
        "whatsapp menu",
    ]

    def __init__(self, client: WhatsAppClient):
        """Initialize the action.

        Args:
            client: WhatsApp client instance.
        """
        self.client = client

    def validate(self, params: SendInteractiveParams) -> tuple[bool, str | None]:
        """Validate action parameters.

        Args:
            params: Parameters to validate.

        Returns:
            Tuple of (is_valid, error_message).
        """
        if not params.to:
            return False, "Recipient phone number is required"
        if not params.body_text:
            return False, "Body text is required"

        if params.interactive_type == "button":
            if not params.buttons:
                return False, "Buttons are required for button type"
            if len(params.buttons) > 3:
                return False, "Maximum 3 buttons allowed"
            for button in params.buttons:
                if len(button.title) > 20:
                    return False, f"Button title too long: {button.title}"

        elif params.interactive_type == "list":
            if not params.sections:
                return False, "Sections are required for list type"
            if not params.list_button_text:
                return False, "List button text is required for list type"
            total_rows = sum(len(section.rows) for section in params.sections)
            if total_rows > 10:
                return False, "Maximum 10 rows allowed across all sections"

        else:
            return False, f"Invalid interactive type: {params.interactive_type}"

        return True, None

    async def handler(self, params: SendInteractiveParams) -> WhatsAppMessageResponse:
        """Execute the action.

        Args:
            params: Action parameters.

        Returns:
            Response from WhatsApp API.
        """
        is_valid, error = self.validate(params)
        if not is_valid:
            raise ValueError(error)

        # Build action based on type
        if params.interactive_type == "button":
            action = WhatsAppInteractiveAction(
                buttons=[
                    {
                        "type": "reply",
                        "reply": {"id": btn.id, "title": btn.title},
                    }
                    for btn in params.buttons or []
                ]
            )
        else:
            action = WhatsAppInteractiveAction(
                button=params.list_button_text,
                sections=[
                    {
                        "title": section.title,
                        "rows": [
                            {
                                "id": row.id,
                                "title": row.title,
                                "description": row.description,
                            }
                            for row in section.rows
                        ],
                    }
                    for section in params.sections or []
                ],
            )

        interactive = WhatsAppInteractiveContent(
            type=params.interactive_type,
            body={"text": params.body_text},
            action=action,
        )

        if params.header_text:
            interactive.header = {"type": "text", "text": params.header_text}
        if params.footer_text:
            interactive.footer = {"text": params.footer_text}

        message = WhatsAppMessage(
            type="interactive",
            to=params.to,
            content=interactive,
        )

        response = await self.client.send_message(message)

        logger.info(
            "Sent WhatsApp interactive %s to %s, message_id=%s",
            params.interactive_type,
            params.to,
            response.messages[0].id if response.messages else "unknown",
        )

        return response


# Action factory
def send_interactive_action(client: WhatsAppClient) -> SendInteractiveAction:
    """Create a send interactive action instance.

    Args:
        client: WhatsApp client instance.

    Returns:
        SendInteractiveAction instance.
    """
    return SendInteractiveAction(client)
