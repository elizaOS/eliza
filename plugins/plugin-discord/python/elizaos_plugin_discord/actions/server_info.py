"""Server info action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class ServerInfoAction:
    """Action to get information about the Discord server."""

    @property
    def name(self) -> str:
        return "SERVER_INFO"

    @property
    def description(self) -> str:
        return (
            "Get information about the current Discord server including "
            "member count, channels, and creation date."
        )

    @property
    def similes(self) -> list[str]:
        return [
            "GUILD_INFO",
            "ABOUT_SERVER",
            "SERVER_DETAILS",
            "SERVER_STATS",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        source = context.message.get("source", "")
        if source != "discord":
            return False
        # Need to be in a guild (not DMs)
        return context.guild_id is not None

    async def handler(
        self,
        context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Execute the action."""
        from elizaos_plugin_discord.actions import ActionResult

        if not context.guild_id:
            return ActionResult.failure_result(
                "I can only provide server info when in a server, not in DMs."
            )

        # Get server info
        server_info = await service.get_guild_info(context.guild_id)
        if not server_info:
            return ActionResult.failure_result(
                "I couldn't fetch information about this server."
            )

        # Format the response
        name = server_info.get("name", "Unknown")
        member_count = server_info.get("member_count", 0)
        channel_count = server_info.get("channel_count", 0)
        role_count = server_info.get("role_count", 0)
        created_at = server_info.get("created_at", "Unknown")
        owner = server_info.get("owner", {}).get("username", "Unknown")
        boost_level = server_info.get("premium_tier", 0)
        boost_count = server_info.get("premium_subscription_count", 0)

        response_lines = [
            f"**{name}** Server Information",
            "",
            f"**Owner:** {owner}",
            f"**Created:** {created_at}",
            f"**Members:** {member_count:,}",
            f"**Channels:** {channel_count}",
            f"**Roles:** {role_count}",
            f"**Boost Level:** {boost_level} ({boost_count} boosts)",
        ]

        if server_info.get("description"):
            response_lines.insert(1, f"*{server_info['description']}*")
            response_lines.insert(2, "")

        return ActionResult.success_result(
            "\n".join(response_lines),
            server_info,
        )
