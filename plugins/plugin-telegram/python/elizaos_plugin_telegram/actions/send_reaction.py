"""Send reaction action for Telegram plugin."""
import logging
from dataclasses import dataclass

from elizaos_plugin_telegram.types import (
    SendReactionParams,
    SendReactionResult,
    TelegramReactions,
)

logger = logging.getLogger(__name__)


@dataclass
class SendReactionAction:
    """Action to send a reaction to a Telegram message."""

    name: str = "SEND_TELEGRAM_REACTION"
    description: str = "Send a reaction emoji to a Telegram message"
    similes: tuple[str, ...] = (
        "TELEGRAM_REACT",
        "TELEGRAM_REACTION",
        "REACT_TO_MESSAGE",
        "ADD_REACTION",
        "SEND_EMOJI",
        "TELEGRAM_EMOJI",
    )

    def validate(self, source: str | None) -> bool:
        """Validate that the action can be performed."""
        return source == "telegram"

    async def handler(
        self,
        service: object,
        chat_id: int | str,
        message_id: int,
        reaction: str,
        is_big: bool = False,
    ) -> SendReactionResult:
        """Handle the send reaction action.
        
        Args:
            service: The TelegramService instance.
            chat_id: The chat ID where the message is.
            message_id: The ID of the message to react to.
            reaction: The emoji to use as a reaction.
            is_big: Whether to use a big/animated reaction.
            
        Returns:
            SendReactionResult with success status and details.
        """
        # Import here to avoid circular imports
        from elizaos_plugin_telegram.service import TelegramService
        
        if not isinstance(service, TelegramService):
            return SendReactionResult(
                success=False,
                chat_id=chat_id,
                message_id=message_id,
                reaction=reaction,
                error="Invalid service type",
            )
        
        params = SendReactionParams(
            chat_id=chat_id,
            message_id=message_id,
            reaction=reaction,
            is_big=is_big,
        )
        
        return await service.send_reaction(params)


# Map common reaction names to emojis
REACTION_NAME_MAP: dict[str, str] = {
    "thumbs_up": TelegramReactions.THUMBS_UP,
    "thumbsup": TelegramReactions.THUMBS_UP,
    "like": TelegramReactions.THUMBS_UP,
    "+1": TelegramReactions.THUMBS_UP,
    "thumbs_down": TelegramReactions.THUMBS_DOWN,
    "thumbsdown": TelegramReactions.THUMBS_DOWN,
    "dislike": TelegramReactions.THUMBS_DOWN,
    "-1": TelegramReactions.THUMBS_DOWN,
    "heart": TelegramReactions.HEART,
    "love": TelegramReactions.HEART,
    "fire": TelegramReactions.FIRE,
    "lit": TelegramReactions.FIRE,
    "hot": TelegramReactions.FIRE,
    "celebration": TelegramReactions.CELEBRATION,
    "party": TelegramReactions.CELEBRATION,
    "tada": TelegramReactions.CELEBRATION,
    "crying": TelegramReactions.CRYING,
    "sad": TelegramReactions.CRYING,
    "thinking": TelegramReactions.THINKING,
    "hmm": TelegramReactions.THINKING,
    "exploding_head": TelegramReactions.EXPLODING_HEAD,
    "mindblown": TelegramReactions.EXPLODING_HEAD,
    "screaming": TelegramReactions.SCREAMING,
    "scared": TelegramReactions.SCREAMING,
    "angry": TelegramReactions.ANGRY,
    "skull": TelegramReactions.SKULL,
    "dead": TelegramReactions.SKULL,
    "poop": TelegramReactions.POOP,
    "clown": TelegramReactions.CLOWN,
    "eyes": TelegramReactions.EYES,
    "look": TelegramReactions.EYES,
    "hundred": TelegramReactions.HUNDRED,
    "100": TelegramReactions.HUNDRED,
    "perfect": TelegramReactions.HUNDRED,
    "tears_of_joy": TelegramReactions.TEARS_OF_JOY,
    "lol": TelegramReactions.TEARS_OF_JOY,
    "laugh": TelegramReactions.TEARS_OF_JOY,
    "lightning": TelegramReactions.LIGHTNING,
    "zap": TelegramReactions.LIGHTNING,
    "trophy": TelegramReactions.TROPHY,
    "win": TelegramReactions.TROPHY,
    "winner": TelegramReactions.TROPHY,
    "broken_heart": TelegramReactions.BROKEN_HEART,
    "heartbroken": TelegramReactions.BROKEN_HEART,
    "ghost": TelegramReactions.GHOST,
    "boo": TelegramReactions.GHOST,
    "unicorn": TelegramReactions.UNICORN,
}


def normalize_reaction(reaction: str) -> str:
    """Normalize a reaction string to an emoji.
    
    If the input is already an emoji, return it as-is.
    If it's a name, look it up in the map.
    """
    if not reaction:
        return TelegramReactions.THUMBS_UP
    
    # Already an emoji (check if it starts with a non-ASCII char)
    if ord(reaction[0]) > 127:
        return reaction
    
    # Look up by name (case-insensitive)
    normalized = reaction.lower().replace(" ", "_").replace("-", "_")
    return REACTION_NAME_MAP.get(normalized, TelegramReactions.THUMBS_UP)


# Action instance for export
send_reaction_action = SendReactionAction()
