"""Delete message action for Discord."""

from typing import TYPE_CHECKING

from elizaos_plugin_discord.error import InvalidArgumentError
from elizaos_plugin_discord.types import Snowflake

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class DeleteMessageAction:
    """Action to delete a message from a Discord channel.

    Can delete the bot's own messages unconditionally. For other users'
    messages, the bot needs the Manage Messages permission.
    """

    @property
    def name(self) -> str:
        return "DISCORD_DELETE_MESSAGE"

    @property
    def description(self) -> str:
        return "Delete a message from a Discord channel. Can delete own messages or others' with Manage Messages permission."

    @property
    def similes(self) -> list[str]:
        return [
            "REMOVE_MESSAGE",
            "UNSEND_MESSAGE",
            "DELETE_DISCORD_MESSAGE",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate that the context is from Discord and has a message_id."""
        source = context.message.get("source")
        if not isinstance(source, str) or source != "discord":
            return False

        try:
            Snowflake(context.channel_id)
        except Exception:
            return False

        # Check that we have a message_id to delete
        state = context.state
        content = context.message.get("content", {})
        if not isinstance(content, dict):
            content = {}

        message_id = ""
        if state:
            message_id = state.get("message_id", "")
        if not message_id:
            message_id = content.get("message_id", "")

        return bool(message_id)

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Delete a message from a Discord channel."""
        from elizaos_plugin_discord.actions import ActionResult

        state = context.state or {}
        content = context.message.get("content", {})
        if not isinstance(content, dict):
            content = {}

        # Extract message_id
        message_id = state.get("message_id", "") or content.get("message_id", "")
        if not message_id:
            raise InvalidArgumentError("Missing message_id to delete")

        # Validate message_id as snowflake
        try:
            Snowflake(message_id)
        except Exception:
            raise InvalidArgumentError(f"Invalid message_id: {message_id}")

        channel_id = context.channel_id

        try:
            # Get the channel
            channel = await service._get_text_channel(channel_id)

            # Fetch the message
            target_message = await channel.fetch_message(int(message_id))

            if target_message is None:
                return ActionResult.failure_result(
                    "I couldn't find the message to delete."
                )

            if service._client is None:
                return ActionResult.failure_result(
                    "Discord client is not available."
                )

            bot_user = service._client.user
            is_own_message = (
                bot_user is not None
                and str(target_message.author.id) == str(bot_user.id)
            )

            if not is_own_message:
                # Need Manage Messages permission for other users' messages
                has_perm = await service.has_manage_messages_permission(channel_id)
                if not has_perm:
                    return ActionResult.failure_result(
                        "I don't have permission to delete that message. "
                        "I need the 'Manage Messages' permission to delete "
                        "messages from other users."
                    )

            # Perform the delete
            await target_message.delete()

            return ActionResult.success_result(
                "I've deleted the message.",
                {
                    "message_id": message_id,
                    "channel_id": channel_id,
                },
            )
        except InvalidArgumentError:
            raise
        except Exception as exc:
            return ActionResult.failure_result(f"Failed to delete message: {exc}")
