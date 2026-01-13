"""React to message action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class ReactToMessageAction:
    """Action to add an emoji reaction to a specific message."""

    @property
    def name(self) -> str:
        return "REACT_TO_MESSAGE"

    @property
    def description(self) -> str:
        return "Add an emoji reaction to a specific message in Discord."

    @property
    def similes(self) -> list[str]:
        return [
            "ADD_REACTION_TO",
            "REACT_MESSAGE",
            "EMOJI_REACT",
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

        # Extract emoji and message reference
        reaction_info = await service.extract_reaction_info(text)
        if not reaction_info:
            return ActionResult.failure_result(
                "I couldn't understand what emoji to use or which message to react to."
            )

        emoji = reaction_info.get("emoji", "")
        message_ref = reaction_info.get("message_ref", "last")

        # Find the target message
        target_message = await service.find_message(context.channel_id, message_ref)
        if not target_message:
            return ActionResult.failure_result("I couldn't find the message to react to.")

        # Add reaction
        success = await service.add_reaction(context.channel_id, target_message["id"], emoji)
        if not success:
            return ActionResult.failure_result(
                "I couldn't add the reaction. The emoji might be invalid "
                "or I might not have permission."
            )

        return ActionResult.success_result(
            f"I've added {emoji} to the message.",
            {"message_id": target_message["id"], "emoji": emoji},
        )
