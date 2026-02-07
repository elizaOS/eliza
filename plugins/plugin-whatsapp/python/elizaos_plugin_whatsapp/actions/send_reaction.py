"""Send reaction action for WhatsApp plugin."""
import logging
from dataclasses import dataclass

from elizaos_plugin_whatsapp.client import WhatsAppClient
from elizaos_plugin_whatsapp.types import SendReactionParams, SendReactionResult

logger = logging.getLogger(__name__)

SEND_REACTION_ACTION = "WHATSAPP_SEND_REACTION"

# Map of reaction names to emoji
REACTION_NAME_MAP: dict[str, str] = {
    "like": "👍",
    "thumbsup": "👍",
    "thumbs_up": "👍",
    "dislike": "👎",
    "thumbsdown": "👎",
    "thumbs_down": "👎",
    "heart": "❤️",
    "love": "❤️",
    "laugh": "😂",
    "laughing": "😂",
    "haha": "😂",
    "lol": "😂",
    "wow": "😮",
    "surprised": "😮",
    "sad": "😢",
    "cry": "😢",
    "crying": "😢",
    "pray": "🙏",
    "praying": "🙏",
    "thanks": "🙏",
    "clap": "👏",
    "clapping": "👏",
    "fire": "🔥",
    "hot": "🔥",
    "celebrate": "🎉",
    "celebration": "🎉",
    "party": "🎉",
}


def normalize_reaction(reaction: str) -> str:
    """Normalize a reaction to an emoji.

    Args:
        reaction: Reaction name or emoji.

    Returns:
        Emoji string.
    """
    # If it's already an emoji, return it
    if len(reaction) <= 4 and not reaction.isascii():
        return reaction

    # Look up by name
    lower_reaction = reaction.lower().strip()
    return REACTION_NAME_MAP.get(lower_reaction, reaction)


@dataclass
class SendReactionActionParams:
    """Parameters for sending a WhatsApp reaction."""

    to: str
    message_id: str
    emoji: str


class SendReactionAction:
    """Action to send a WhatsApp reaction."""

    name: str = SEND_REACTION_ACTION
    description: str = "Send a reaction emoji to a WhatsApp message"
    similes: list[str] = [
        "react to whatsapp message",
        "whatsapp reaction",
        "react on whatsapp",
        "like whatsapp message",
    ]

    def __init__(self, client: WhatsAppClient):
        """Initialize the action.

        Args:
            client: WhatsApp client instance.
        """
        self.client = client

    def validate(self, params: SendReactionActionParams) -> tuple[bool, str | None]:
        """Validate action parameters.

        Args:
            params: Parameters to validate.

        Returns:
            Tuple of (is_valid, error_message).
        """
        if not params.to:
            return False, "Recipient phone number is required"
        if not params.message_id:
            return False, "Message ID is required"
        if not params.emoji:
            return False, "Emoji is required"
        return True, None

    async def handler(self, params: SendReactionActionParams) -> SendReactionResult:
        """Execute the action.

        Args:
            params: Action parameters.

        Returns:
            Result of the reaction operation.
        """
        is_valid, error = self.validate(params)
        if not is_valid:
            return SendReactionResult(success=False, error=error)

        normalized_emoji = normalize_reaction(params.emoji)

        result = await self.client.send_reaction(
            SendReactionParams(
                to=params.to,
                message_id=params.message_id,
                emoji=normalized_emoji,
            )
        )

        if result.success:
            logger.info(
                "Sent reaction %s to message %s",
                normalized_emoji,
                params.message_id,
            )
        else:
            logger.error(
                "Failed to send reaction to message %s: %s",
                params.message_id,
                result.error,
            )

        return result


# Action factory
def send_reaction_action(client: WhatsAppClient) -> SendReactionAction:
    """Create a send reaction action instance.

    Args:
        client: WhatsApp client instance.

    Returns:
        SendReactionAction instance.
    """
    return SendReactionAction(client)
