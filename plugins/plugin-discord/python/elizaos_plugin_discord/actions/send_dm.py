"""Send DM action."""

from typing import TYPE_CHECKING

from elizaos_plugin_discord.error import InvalidArgumentError
from elizaos_plugin_discord.types import Snowflake

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class SendDmAction:
    """Action to send a direct message to a Discord user."""

    @property
    def name(self) -> str:
        return "SEND_DM"

    @property
    def description(self) -> str:
        return "Sends a direct message to a Discord user. Use this for private communications."

    @property
    def similes(self) -> list[str]:
        return [
            "SEND_DIRECT_MESSAGE",
            "DM_USER",
            "PRIVATE_MESSAGE",
            "PM_USER",
            "WHISPER",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        # Check source is Discord
        source = context.message.get("source")
        if not isinstance(source, str) or source != "discord":
            return False

        # Check we have a valid target user ID or can use sender
        content = context.message.get("content", {})
        target_id = content.get("target_user_id") if isinstance(content, dict) else None

        try:
            if target_id:
                Snowflake(target_id)
            else:
                Snowflake(context.user_id)
        except Exception:
            return False

        # Check we have content to send
        text = content.get("text", "") if isinstance(content, dict) else ""
        return bool(text)

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Execute the action."""
        from elizaos_plugin_discord.actions import ActionResult

        content = context.message.get("content", {})
        target_id = content.get("target_user_id") if isinstance(content, dict) else None
        text = content.get("text", "") if isinstance(content, dict) else ""

        if not text:
            raise InvalidArgumentError("Missing message content")

        # Use target or sender
        user_id = target_id or context.user_id

        message_id = await service.send_dm(user_id, text)

        return ActionResult.success_result(
            "Direct message sent successfully",
            {
                "message_id": str(message_id),
                "user_id": user_id,
            },
        )
