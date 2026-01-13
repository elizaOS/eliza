"""List channels action."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.actions import ActionContext, ActionResult
    from elizaos_plugin_discord.service import DiscordService


class ListChannelsAction:
    """Action to list all channels the bot is listening to."""

    @property
    def name(self) -> str:
        return "LIST_CHANNELS"

    @property
    def description(self) -> str:
        return "Lists all Discord channels the bot is currently listening to and responding in."

    @property
    def similes(self) -> list[str]:
        return [
            "SHOW_CHANNELS",
            "LIST_LISTENING_CHANNELS",
            "SHOW_MONITORED_CHANNELS",
            "GET_CHANNELS",
            "WHICH_CHANNELS",
            "CHANNELS_LIST",
        ]

    async def validate(self, context: "ActionContext") -> bool:
        """Validate the action can be executed."""
        source = context.message.get("source")
        return isinstance(source, str) and source == "discord"

    async def handler(
        self,
        _context: "ActionContext",
        service: "DiscordService",
    ) -> "ActionResult":
        """Execute the action."""
        from elizaos_plugin_discord.actions import ActionResult

        # Get all allowed channels
        allowed_channel_ids = service.get_allowed_channels()

        if not allowed_channel_ids:
            return ActionResult.success_result(
                "I'm currently listening to all channels (no restrictions are set).",
                {"channels": [], "unrestricted": True},
            )

        # Fetch channel information
        channel_infos: list[dict[str, object]] = []
        for channel_id in allowed_channel_ids:
            try:
                info = await service.get_channel_info(channel_id)
                if info:
                    channel_infos.append(dict(info))
            except Exception:
                # Channel might have been deleted
                channel_infos.append(
                    {
                        "id": channel_id,
                        "name": "Unknown",
                        "server": "Unknown or Deleted",
                        "mention": f"<#{channel_id}>",
                    }
                )

        # Format response grouped by server
        channels_by_server: dict[str, list[dict[str, object]]] = {}
        for channel in channel_infos:
            server_obj = channel.get("server", "Unknown")
            server = server_obj if isinstance(server_obj, str) else "Unknown"
            if server not in channels_by_server:
                channels_by_server[server] = []
            channels_by_server[server].append(channel)

        response_lines = [
            f"I'm currently listening to {len(channel_infos)} channel"
            f"{'s' if len(channel_infos) != 1 else ''}:",
            "",
        ]

        for server_name, channels in channels_by_server.items():
            response_lines.append(f"**{server_name}**")
            for channel in channels:
                name = channel.get("name", "Unknown")
                mention = channel.get("mention", channel.get("id", ""))
                response_lines.append(f"• {name} ({mention})")
            response_lines.append("")

        if service.has_env_channels():
            response_lines.append(
                "*Some channels are configured in environment settings "
                "and cannot be removed dynamically.*"
            )

        return ActionResult.success_result(
            "\n".join(response_lines).strip(),
            {"channels": channel_infos, "count": len(channel_infos)},
        )
