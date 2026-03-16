"""Search messages action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class SearchMessagesAction:
    """Action to search for messages in a Discord channel."""

    @property
    def name(self) -> str:
        return "SEARCH_MESSAGES"

    @property
    def description(self) -> str:
        return "Search for messages containing specific content in a Discord channel."

    @property
    def similes(self) -> list[str]:
        return [
            "FIND_MESSAGES",
            "SEARCH_CHANNEL",
            "LOOK_FOR_MESSAGES",
            "FIND_IN_CHANNEL",
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

        # Extract search query
        search_query = await service.extract_search_query(text)
        if not search_query:
            return ActionResult.failure_result(
                "I need a search term to look for messages. What would you like me to search for?"
            )

        # Extract channel (default to current)
        channel_id = await service.extract_channel_id(text)
        if not channel_id:
            channel_id = context.channel_id

        # Check permissions
        if not await service.has_read_message_history_permission(channel_id):
            return ActionResult.failure_result(
                "I don't have permission to read message history in this channel."
            )

        # Search messages
        results = await service.search_messages(channel_id, search_query, limit=50)
        if not results:
            return ActionResult.success_result(
                f'I couldn\'t find any messages containing "{search_query}".',
                {"query": search_query, "results": []},
            )

        # Format results
        formatted_results = []
        for msg in results[:10]:  # Limit to 10 displayed results
            author = msg["author"]["username"]
            msg_content = msg["content"]
            # Truncate long messages
            if len(msg_content) > 100:
                msg_content = msg_content[:100] + "..."
            formatted_results.append(f"**{author}**: {msg_content}")

        channel_name = await service.get_channel_name(channel_id)
        total_found = len(results)
        displayed = min(10, total_found)

        response_text = (
            f'Found {total_found} message(s) containing "{search_query}" '
            f"in #{channel_name}:\n\n" + "\n".join(formatted_results)
        )

        if total_found > 10:
            response_text += f"\n\n*(Showing {displayed} of {total_found} results)*"

        return ActionResult.success_result(
            response_text,
            {
                "query": search_query,
                "channel_id": channel_id,
                "total_results": total_found,
                "results": results[:10],
            },
        )
