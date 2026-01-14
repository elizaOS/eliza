"""Unpin message action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class UnpinMessageAction:
    """Action to unpin a message in a Discord channel."""

    @property
    def name(self) -> str:
        return "UNPIN_MESSAGE"

    @property
    def description(self) -> str:
        return "Unpin a previously pinned message in a Discord channel."

    @property
    def similes(self) -> list[str]:
        return [
            "UNPIN_MSG",
            "REMOVE_PIN",
            "UNPIN_THAT",
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

        # Parse message reference
        message_ref = await service.extract_message_reference(text)
        if not message_ref:
            return ActionResult.failure_result(
                "I couldn't understand which message you want to unpin. Please be more specific."
            )

        # Check permissions
        if not await service.has_manage_messages_permission(context.channel_id):
            return ActionResult.failure_result(
                "I don't have permission to unpin messages in this channel. "
                "I need the 'Manage Messages' permission."
            )

        # Find the message
        target_message = await service.find_message(context.channel_id, message_ref)
        if not target_message:
            return ActionResult.failure_result("I couldn't find the message you want to unpin.")

        # Check if pinned
        if not target_message["pinned"]:
            return ActionResult.failure_result("That message is not pinned.")

        # Unpin the message
        success = await service.unpin_message(context.channel_id, target_message["id"])
        if not success:
            return ActionResult.failure_result("I couldn't unpin that message. Please try again.")

        author = target_message["author"]["username"]
        return ActionResult.success_result(
            f"I've unpinned the message from {author}.",
            {"message_id": target_message["id"], "author": author},
        )
