"""Join channel action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class JoinChannelAction:
    """Action to add a channel to the bot's listening list."""

    @property
    def name(self) -> str:
        return "JOIN_CHANNEL"

    @property
    def description(self) -> str:
        return "Adds a channel to the list of channels the bot will listen to and respond in."

    @property
    def similes(self) -> list[str]:
        return [
            "ADD_CHANNEL",
            "LISTEN_TO_CHANNEL",
            "ENABLE_CHANNEL",
            "WATCH_CHANNEL",
            "MONITOR_CHANNEL",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        source = context.message.get("source")
        return isinstance(source, str) and source == "discord"

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Execute the action."""
        from elizaos_plugin_discord.actions import ActionResult

        content = context.message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else ""

        # Extract channel reference from message
        channel_id = await service.extract_channel_id(text)
        if not channel_id:
            # Default to current channel
            channel_id = context.channel_id

        # Check if already listening
        if service.is_channel_allowed(channel_id):
            return ActionResult.failure_result("I'm already listening to this channel.")

        # Add channel to allowed list
        success = await service.add_allowed_channel(channel_id)
        if not success:
            return ActionResult.failure_result("Failed to add channel to the listening list.")

        channel_name = await service.get_channel_name(channel_id)
        return ActionResult.success_result(
            f'I\'m now listening to channel "{channel_name}".',
            {"channel_id": channel_id, "channel_name": channel_name},
        )
