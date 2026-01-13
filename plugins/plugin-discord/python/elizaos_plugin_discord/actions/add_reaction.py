"""Add reaction action."""

from typing import TYPE_CHECKING

from elizaos_plugin_discord.error import InvalidArgumentError
from elizaos_plugin_discord.types import Snowflake

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class AddReactionAction:
    """Action to add a reaction to a Discord message."""

    @property
    def name(self) -> str:
        return "ADD_REACTION"

    @property
    def description(self) -> str:
        return "Adds an emoji reaction to a Discord message. Use this to express emotions or provide quick feedback."

    @property
    def similes(self) -> list[str]:
        return [
            "REACT",
            "ADD_EMOJI",
            "EMOJI_REACTION",
            "REACT_TO_MESSAGE",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        # Check source is Discord
        source = context.message.get("source")
        if not isinstance(source, str) or source != "discord":
            return False

        # Check we have a valid channel ID
        try:
            Snowflake(context.channel_id)
        except Exception:
            return False

        # Check we have a message ID and emoji
        content = context.message.get("content", {})
        if not isinstance(content, dict):
            return False

        message_id = content.get("message_id", "")
        emoji = content.get("emoji", "")

        if not message_id or not emoji:
            return False

        try:
            Snowflake(message_id)
        except Exception:
            return False

        return True

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Execute the action."""
        from elizaos_plugin_discord.actions import ActionResult

        content = context.message.get("content", {})
        message_id = content.get("message_id", "") if isinstance(content, dict) else ""
        emoji = content.get("emoji", "") if isinstance(content, dict) else ""

        if not message_id:
            raise InvalidArgumentError("Missing message_id")
        if not emoji:
            raise InvalidArgumentError("Missing emoji")

        await service.add_reaction(context.channel_id, message_id, emoji)

        return ActionResult.success_result(
            "Reaction added successfully",
            {
                "channel_id": context.channel_id,
                "message_id": message_id,
                "emoji": emoji,
            },
        )
