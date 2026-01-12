"""
Discord providers for elizaOS.

Providers supply contextual information for agent decision-making.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass

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


class DiscordProvider(ABC):
    """Base class for Discord providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name."""
        ...

    @property
    @abstractmethod
    def description(self) -> str:
        """Provider description."""
        ...

    @abstractmethod
    async def get(self, context: ProviderContext) -> dict:
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


