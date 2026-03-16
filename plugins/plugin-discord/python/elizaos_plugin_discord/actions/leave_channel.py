"""Leave channel action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class LeaveChannelAction:
    """Action to remove a channel from the bot's listening list."""

    @property
    def name(self) -> str:
        return "LEAVE_CHANNEL"

    @property
    def description(self) -> str:
        return (
            "Removes a channel from the list of channels the bot will listen to, "
            "effectively muting the bot in that channel."
        )

    @property
    def similes(self) -> list[str]:
        return [
            "REMOVE_CHANNEL",
            "STOP_LISTENING_CHANNEL",
            "DISABLE_CHANNEL",
            "UNWATCH_CHANNEL",
            "MUTE_CHANNEL",
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

        # Check if this is an env-configured channel
        if service.is_env_channel(channel_id):
            return ActionResult.failure_result(
                "This channel is configured in environment settings "
                "and cannot be removed dynamically."
            )

        # Check if listening
        if not service.is_channel_allowed(channel_id):
            return ActionResult.failure_result("I'm not currently listening to this channel.")

        # Remove channel from allowed list
        success = await service.remove_allowed_channel(channel_id)
        if not success:
            return ActionResult.failure_result("Failed to remove channel from the listening list.")

        channel_name = await service.get_channel_name(channel_id)
        return ActionResult.success_result(
            f'I\'m no longer listening to channel "{channel_name}".',
            {"channel_id": channel_id, "channel_name": channel_name},
        )
