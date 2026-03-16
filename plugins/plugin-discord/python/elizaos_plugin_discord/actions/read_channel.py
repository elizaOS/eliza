"""Read channel action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class ReadChannelAction:
    """Action to read recent messages from a Discord channel."""

    @property
    def name(self) -> str:
        return "READ_CHANNEL"

    @property
    def description(self) -> str:
        return "Read recent messages from a Discord channel to understand the conversation context."

    @property
    def similes(self) -> list[str]:
        return [
            "GET_CHANNEL_MESSAGES",
            "FETCH_MESSAGES",
            "CHECK_CHANNEL",
            "CHANNEL_HISTORY",
            "READ_MESSAGES",
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

        # Extract channel reference and limit
        channel_id = await service.extract_channel_id(text)
        if not channel_id:
            channel_id = context.channel_id

        # Default to 10 messages, max 100
        limit = await service.extract_message_limit(text)
        if not limit or limit < 1:
            limit = 10
        limit = min(limit, 100)

        # Check read permissions
        if not await service.has_read_message_history_permission(channel_id):
            return ActionResult.failure_result(
                "I don't have permission to read message history in this channel."
            )

        # Fetch messages
        messages = await service.get_channel_messages(channel_id, limit)
        if not messages:
            return ActionResult.failure_result("I couldn't fetch any messages from the channel.")

        # Format messages
        formatted_messages = []
        for msg in messages:
            author = msg["author"]["username"]
            msg_content = msg["content"]
            timestamp = msg["timestamp"]
            formatted_messages.append(f"[{timestamp}] {author}: {msg_content}")

        channel_name = await service.get_channel_name(channel_id)
        response_text = (
            f"Here are the last {len(messages)} messages from #{channel_name}:\n\n"
            + "\n".join(formatted_messages)
        )

        return ActionResult.success_result(
            response_text,
            {
                "channel_id": channel_id,
                "message_count": len(messages),
                "messages": messages,
            },
        )
