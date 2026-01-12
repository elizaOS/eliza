"""Timeline provider for Farcaster."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_farcaster.config import FarcasterConfig
    from elizaos_plugin_farcaster.service import FarcasterService


class TimelineProvider:
    """Provider for Farcaster timeline.

    Exposes the agent's recent Farcaster timeline to the context.
    """

    NAME = "farcaster_timeline"
    DESCRIPTION = "Provides the agent's recent Farcaster timeline"

    def __init__(
        self,
        service: "FarcasterService",
        config: "FarcasterConfig",
    ) -> None:
        """Initialize the timeline provider.

        Args:
            service: The Farcaster service
            config: The Farcaster configuration
        """
        self._service = service
        self._config = config

    @property
    def name(self) -> str:
        """Get the provider name."""
        return self.NAME

    @property
    def description(self) -> str:
        """Get the provider description."""
        return self.DESCRIPTION

    async def get(self, limit: int = 10) -> str:
        """Get the timeline as a formatted string.

        Args:
            limit: Maximum number of casts to return

        Returns:
            Formatted timeline information
        """
        try:
            casts, _ = await self._service.get_timeline(limit)

            if not casts:
                return "No recent casts in timeline."

            lines = ["Recent Farcaster timeline:"]
            for cast in casts[:limit]:
                timestamp = cast.timestamp.strftime("%Y-%m-%d %H:%M")
                text = cast.text[:100] + "..." if len(cast.text) > 100 else cast.text
                lines.append(f"- [{timestamp}] @{cast.profile.username}: {text}")

            return "\n".join(lines)

        except Exception as e:
            return f"Error fetching Farcaster timeline: {e!s}"
