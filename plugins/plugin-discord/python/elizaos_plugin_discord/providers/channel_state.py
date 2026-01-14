"""Channel state provider."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.providers import ProviderContext


class ChannelStateProvider:
    """Provider for Discord channel state information."""

    @property
    def name(self) -> str:
        return "channel_state"

    @property
    def description(self) -> str:
        return "Provides information about the current Discord channel, including type, permissions, and activity."

    async def get(self, context: "ProviderContext") -> dict[str, object]:
        """Get the provider's data for the current context."""
        is_dm = context.guild_id is None

        return {
            "channel_id": context.channel_id,
            "guild_id": context.guild_id,
            "is_dm": is_dm,
            "room_id": context.room_id,
            "channel_type": "dm" if is_dm else "guild_text",
            # Additional fields would be populated from service when running
            "permissions": {
                "can_send_messages": True,
                "can_add_reactions": True,
                "can_attach_files": True,
                "can_embed_links": True,
            },
        }


class ChannelStateProviderCamel(ChannelStateProvider):
    """TS-parity alias provider (camelCase name)."""

    @property
    def name(self) -> str:
        return "channelState"
