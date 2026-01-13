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
        source = context.message.get("source")
        if not isinstance(source, str) or source != "discord":
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

        # Format the response
        name = server_info.guild_name
        member_count = server_info.member_count
        channel_count = server_info.channel_count or (
            len(server_info.text_channels) + len(server_info.voice_channels)
        )
        role_count = server_info.role_count or 0
        created_at = server_info.created_at or "Unknown"
        owner = server_info.owner_name or server_info.owner_id or "Unknown"
        boost_level = server_info.premium_tier or 0
        boost_count = server_info.premium_subscription_count or 0

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

        if server_info.description:
            response_lines.insert(1, f"*{server_info.description}*")
            response_lines.insert(2, "")

        return ActionResult.success_result(
            "\n".join(response_lines),
            server_info.model_dump(),
        )
