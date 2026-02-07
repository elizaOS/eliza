"""Edit message action for Discord."""

from typing import TYPE_CHECKING

from elizaos_plugin_discord.error import InvalidArgumentError
from elizaos_plugin_discord.types import Snowflake

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class EditMessageAction:
    """Action to edit an existing message in a Discord channel.

    The bot can only edit its own messages. Requires the message ID,
    channel ID, and new text content.
    """

    @property
    def name(self) -> str:
        return "DISCORD_EDIT_MESSAGE"

    @property
    def description(self) -> str:
        return "Edit an existing message in a Discord channel. Can only edit the bot's own messages."

    @property
    def similes(self) -> list[str]:
        return [
            "UPDATE_MESSAGE",
            "MODIFY_MESSAGE",
            "CHANGE_MESSAGE",
            "EDIT_DISCORD_MESSAGE",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate that the context is from Discord and has required fields."""
        source = context.message.get("source")
        if not isinstance(source, str) or source != "discord":
            return False

        try:
            Snowflake(context.channel_id)
        except Exception:
            return False

        # Check that the state contains a message_id and new text
        content = context.message.get("content", {})
        if not isinstance(content, dict):
            return False

        state = context.state
        message_id = state.get("message_id", "") if state else ""
        new_text = state.get("new_text", "") if state else ""

        # Also accept from content
        if not message_id:
            message_id = content.get("message_id", "")
        if not new_text:
            new_text = content.get("new_text", "") or content.get("text", "")

        return bool(message_id) and bool(new_text)

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Edit a message in a Discord channel."""
        from elizaos_plugin_discord.actions import ActionResult

        state = context.state or {}
        content = context.message.get("content", {})
        if not isinstance(content, dict):
            content = {}

        # Extract message_id from state or content
        message_id = state.get("message_id", "") or content.get("message_id", "")
        if not message_id:
            raise InvalidArgumentError("Missing message_id to edit")

        # Validate message_id as snowflake
        try:
            Snowflake(message_id)
        except Exception:
            raise InvalidArgumentError(f"Invalid message_id: {message_id}")

        # Extract new text
        new_text = state.get("new_text", "") or content.get("new_text", "") or content.get("text", "")
        if not new_text:
            raise InvalidArgumentError("Missing new text content for the edit")

        channel_id = context.channel_id

        try:
            # Get the channel
            channel = await service._get_text_channel(channel_id)

            # Fetch the message
            target_message = await channel.fetch_message(int(message_id))

            if target_message is None:
                return ActionResult.failure_result(
                    "I couldn't find the message to edit."
                )

            # Check if we own this message (can only edit our own)
            if service._client is None:
                return ActionResult.failure_result(
                    "Discord client is not available."
                )

            bot_user = service._client.user
            if bot_user is None or str(target_message.author.id) != str(bot_user.id):
                return ActionResult.failure_result(
                    "I can only edit my own messages."
                )

            # Perform the edit
            await target_message.edit(content=new_text)

            return ActionResult.success_result(
                f'I\'ve edited the message to: "{new_text}"',
                {
                    "message_id": message_id,
                    "channel_id": channel_id,
                    "new_text": new_text,
                },
            )
        except InvalidArgumentError:
            raise
        except Exception as exc:
            return ActionResult.failure_result(f"Failed to edit message: {exc}")
