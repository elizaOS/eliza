from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_farcaster.config import FarcasterConfig
    from elizaos_plugin_farcaster.service import FarcasterService


class TimelineProvider:
    NAME = "farcaster_timeline"
    DESCRIPTION = "Provides the agent's recent Farcaster timeline"

    def __init__(
        self,
        service: "FarcasterService",
        config: "FarcasterConfig",
    ) -> None:
        self._service = service
        self._config = config

    @property
    def name(self) -> str:
        return self.NAME

    @property
    def description(self) -> str:
        return self.DESCRIPTION

    async def get(self, limit: int = 10) -> str:
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


class TimelineProviderCamel(TimelineProvider):
    """TS-parity alias provider (camelCase name)."""

    NAME = "farcasterTimeline"
