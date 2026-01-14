"""Guild info provider."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.providers import ProviderContext


class GuildInfoProvider:
    """Provider for Discord guild/server information."""

    @property
    def name(self) -> str:
        return "guild_info"

    @property
    def description(self) -> str:
        return "Provides information about the current Discord guild/server, including name, members, and channels."

    async def get(self, context: "ProviderContext") -> dict[str, object]:
        """Get the provider's data for the current context."""
        if context.guild_id:
            # This would be populated from the Discord service when running
            return {
                "guild_id": context.guild_id,
                "is_in_guild": True,
                "guild": {
                    "name": None,  # Populated at runtime
                    "member_count": None,
                    "owner_id": None,
                    "description": None,
                },
                "channels": {
                    "text": [],
                    "voice": [],
                    "categories": [],
                },
                "roles": [],
                "bot_permissions": {
                    "administrator": False,
                    "manage_messages": False,
                    "manage_channels": False,
                    "manage_roles": False,
                },
            }
        else:
            return {
                "guild_id": None,
                "is_in_guild": False,
                "guild": None,
            }


class GuildInfoProviderCamel(GuildInfoProvider):
    """TS-parity alias provider (camelCase name)."""

    @property
    def name(self) -> str:
        return "guildInfo"
