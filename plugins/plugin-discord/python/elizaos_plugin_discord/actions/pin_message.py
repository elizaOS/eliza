"""Pin message action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class PinMessageAction:
    """Action to pin a message in a Discord channel."""

    @property
    def name(self) -> str:
        return "PIN_MESSAGE"

    @property
    def description(self) -> str:
        return "Pin an important message in a Discord channel."

    @property
    def similes(self) -> list[str]:
        return [
            "PIN_MSG",
            "PIN_THIS",
            "PIN_THAT",
            "MAKE_PINNED",
            "ADD_PIN",
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

        # Parse message reference from the text
        message_ref = await service.extract_message_reference(text)
        if not message_ref:
            return ActionResult.failure_result(
                "I couldn't understand which message you want to pin. Please be more specific."
            )

        # Check permissions
        if not await service.has_manage_messages_permission(context.channel_id):
            return ActionResult.failure_result(
                "I don't have permission to pin messages in this channel. "
                "I need the 'Manage Messages' permission."
            )

        # Find the message
        target_message = await service.find_message(context.channel_id, message_ref)
        if not target_message:
            return ActionResult.failure_result(
                "I couldn't find the message you want to pin. "
                "Try being more specific or use 'last message'."
            )

        # Check if already pinned
        if target_message["pinned"]:
            return ActionResult.failure_result("That message is already pinned.")

        # Pin the message
        success = await service.pin_message(context.channel_id, target_message["id"])
        if not success:
            return ActionResult.failure_result(
                "I couldn't pin that message. The channel might have reached "
                "the maximum number of pinned messages (50)."
            )

        author = target_message["author"]["username"]
        return ActionResult.success_result(
            f"I've pinned the message from {author}.",
            {"message_id": target_message["id"], "author": author},
        )
