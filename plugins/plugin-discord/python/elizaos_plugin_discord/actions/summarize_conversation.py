"""Summarize conversation action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class SummarizeConversationAction:
    """Action to summarize recent conversation in a Discord channel."""

    @property
    def name(self) -> str:
        return "SUMMARIZE_CONVERSATION"

    @property
    def description(self) -> str:
        return (
            "Summarize the recent conversation in a Discord channel, "
            "highlighting key points and decisions."
        )

    @property
    def similes(self) -> list[str]:
        return [
            "SUMMARIZE",
            "RECAP",
            "TLDR",
            "SUMMARY",
            "CONVERSATION_SUMMARY",
            "CHANNEL_SUMMARY",
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

        # Extract channel and message count
        channel_id = await service.extract_channel_id(text)
        if not channel_id:
            channel_id = context.channel_id

        limit = await service.extract_message_limit(text)
        if not limit or limit < 10:
            limit = 50  # Default to last 50 messages
        limit = min(limit, 100)

        # Check permissions
        if not await service.has_read_message_history_permission(channel_id):
            return ActionResult.failure_result(
                "I don't have permission to read message history in this channel."
            )

        # Fetch messages
        messages = await service.get_channel_messages(channel_id, limit)
        if not messages:
            return ActionResult.failure_result("I couldn't fetch any messages to summarize.")

        if len(messages) < 5:
            return ActionResult.failure_result(
                "There aren't enough messages to summarize meaningfully."
            )

        # Format messages for summarization
        messages_text = []
        for msg in messages:
            author = msg["author"]["username"]
            msg_content = msg["content"]
            if msg_content:
                messages_text.append(f"{author}: {msg_content}")

        conversation_text = "\n".join(messages_text)

        # Generate summary using the service's model
        summary = await service.generate_conversation_summary(conversation_text)
        if not summary:
            return ActionResult.failure_result("I couldn't generate a summary. Please try again.")

        channel_name = await service.get_channel_name(channel_id)
        response_text = (
            f"**Summary of #{channel_name}** (last {len(messages)} messages)\n\n{summary}"
        )

        return ActionResult.success_result(
            response_text,
            {
                "channel_id": channel_id,
                "message_count": len(messages),
                "summary": summary,
            },
        )
