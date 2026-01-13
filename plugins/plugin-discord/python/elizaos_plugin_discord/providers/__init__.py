"""
Discord providers for elizaOS.

Providers supply contextual information for agent decision-making.
"""

from dataclasses import dataclass
from typing import Protocol

from elizaos_plugin_discord.providers.channel_state import (
    ChannelStateProvider,
    ChannelStateProviderCamel,
)
from elizaos_plugin_discord.providers.guild_info import (
    GuildInfoProvider,
    GuildInfoProviderCamel,
)
from elizaos_plugin_discord.providers.voice_state import (
    VoiceStateProvider,
    VoiceStateProviderCamel,
)


@dataclass(frozen=True)
class ProviderContext:
    """Context provided to providers."""

    channel_id: str | None = None
    guild_id: str | None = None
    user_id: str | None = None
    room_id: str | None = None


class DiscordProvider(Protocol):
    """Base class for Discord providers."""

    @property
    def name(self) -> str:
        """Provider name."""
        ...

    @property
    def description(self) -> str:
        """Provider description."""
        ...

    async def get(self, context: ProviderContext) -> dict[str, object]:
        """Get the provider's data for the current context."""
        ...


def get_all_providers() -> list[DiscordProvider]:
    """Get all available providers."""
    return [
        ChannelStateProvider(),
        VoiceStateProvider(),
        GuildInfoProvider(),
    ]


__all__ = [
    "ProviderContext",
    "DiscordProvider",
    "ChannelStateProvider",
    "ChannelStateProviderCamel",
    "VoiceStateProvider",
    "VoiceStateProviderCamel",
    "GuildInfoProvider",
    "GuildInfoProviderCamel",
    "get_all_providers",
]
