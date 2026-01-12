"""Send cast action for Farcaster."""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_farcaster.service import FarcasterService
    from elizaos_plugin_farcaster.types import Cast


@dataclass
class ActionResult:
    """Result of an action execution."""

    success: bool
    text: str | None = None
    error: str | None = None
    data: dict[str, object] = field(default_factory=dict)


@dataclass
class ActionExample:
    """Example of action usage."""

    name: str
    content: dict[str, object]


class SendCastAction:
    """Action for sending a cast on Farcaster.

    Posts a new cast (message) to Farcaster.
    """

    name = "SEND_CAST"
    similes = ["POST_CAST", "FARCASTER_POST", "CAST", "SHARE_ON_FARCASTER", "ANNOUNCE"]
    description = "Posts a cast (message) on Farcaster"

    examples: list[list[ActionExample]] = [
        [
            ActionExample(
                name="User",
                content={
                    "text": "Post 'Hello Farcaster!' to my timeline",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "I've posted your message to Farcaster!",
                    "actions": ["SEND_CAST"],
                },
            ),
        ],
        [
            ActionExample(
                name="User",
                content={
                    "text": "Share this announcement on Farcaster",
                    "source": "user",
                },
            ),
            ActionExample(
                name="Agent",
                content={
                    "text": "Your announcement has been posted to Farcaster.",
                    "actions": ["SEND_CAST"],
                },
            ),
        ],
    ]

    @staticmethod
    def _has_cast_intent(text: str) -> bool:
        """Check if the message indicates intent to post a cast."""
        keywords = ["post", "cast", "share", "announce", "farcaster"]
        lower = text.lower()
        return any(keyword in lower for keyword in keywords)

    async def validate(
        self,
        message: dict[str, object],
        service: "FarcasterService | None" = None,
    ) -> bool:
        """Validate if the action can run.

        Args:
            message: The incoming message
            service: The Farcaster service

        Returns:
            True if the action can run
        """
        # Need service to be available
        if not service or not service.is_running:
            return False

        # Check for cast intent keywords
        content = message.get("content", {})
        text = str(content.get("text", "") if isinstance(content, dict) else "")

        return self._has_cast_intent(text)

    async def handler(
        self,
        message: dict[str, object],
        service: "FarcasterService",
        text_to_cast: str,
    ) -> ActionResult:
        """Handle the SEND_CAST action.

        Args:
            message: The incoming message
            service: The Farcaster service
            text_to_cast: The text to post as a cast

        Returns:
            Action result
        """
        if not service.is_running:
            return ActionResult(
                success=False,
                text="Farcaster service is not running",
                error="Service not started",
            )

        # Truncate if needed (Farcaster limit is 320 characters)
        if len(text_to_cast) > 320:
            text_to_cast = text_to_cast[:317] + "..."

        # Send the cast
        casts: list[Cast] = await service.send_cast(text_to_cast, reply_to=None)

        if not casts:
            return ActionResult(
                success=False,
                text="Failed to send cast",
                error="No cast returned",
            )

        cast = casts[0]
        return ActionResult(
            success=True,
            text="Cast posted successfully!",
            data={
                "cast_hash": cast.hash,
                "text": cast.text,
                "author_fid": cast.author_fid,
            },
        )
