from typing import TYPE_CHECKING

from elizaos_plugin_discord.error import InvalidArgumentError
from elizaos_plugin_discord.types import Snowflake

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class SendMessageAction:
    @property
    def name(self) -> str:
        return "SEND_MESSAGE"

    @property
    def description(self) -> str:
        return "Sends a message to a Discord channel. Use this to respond to users or post content in a channel."

    @property
    def similes(self) -> list[str]:
        return [
            "SEND_DISCORD_MESSAGE",
            "POST_MESSAGE",
            "REPLY",
            "RESPOND",
            "SAY",
            "CHAT",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        source = context.message.get("source")
        if not isinstance(source, str) or source != "discord":
            return False

        try:
            Snowflake(context.channel_id)
        except Exception:
            return False

        content = context.message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else ""
        return bool(text)

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        from elizaos_plugin_discord.actions import ActionResult

        content = context.message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else ""

        if not text:
            raise InvalidArgumentError("Missing message content")

        message_id = await service.send_message(context.channel_id, text)

        return ActionResult.success_result(
            "Message sent successfully",
            {
                "message_id": str(message_id),
                "channel_id": context.channel_id,
            },
        )
