"""Voice state provider."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_discord.providers import ProviderContext


class VoiceStateProvider:
    """Provider for Discord voice state information."""

    @property
    def name(self) -> str:
        return "voice_state"

    @property
    def description(self) -> str:
        return "Provides information about voice channel state, including connected users and speaking status."

    async def get(self, context: "ProviderContext") -> dict[str, object]:
        """Get the provider's data for the current context."""
        # This would be populated from the Discord service when running
        return {
            "guild_id": context.guild_id,
            "user_id": context.user_id,
            "voice_channel": {
                "connected": False,
                "channel_id": None,
                "channel_name": None,
            },
            "self_state": {
                "muted": False,
                "deafened": False,
                "streaming": False,
                "video": False,
            },
            "members_in_voice": [],
            "speaking_members": [],
        }


class VoiceStateProviderCamel(VoiceStateProvider):
    """TS-parity alias provider (camelCase name)."""

    @property
    def name(self) -> str:
        return "voiceState"
