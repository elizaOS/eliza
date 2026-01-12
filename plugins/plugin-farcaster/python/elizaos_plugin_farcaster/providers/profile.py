"""Profile provider for Farcaster."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_farcaster.config import FarcasterConfig
    from elizaos_plugin_farcaster.service import FarcasterService


class ProfileProvider:
    """Provider for Farcaster profile information.

    Exposes the agent's Farcaster profile to the context.
    """

    NAME = "farcaster_profile"
    DESCRIPTION = "Provides the agent's Farcaster profile information"

    def __init__(
        self,
        service: "FarcasterService",
        config: "FarcasterConfig",
    ) -> None:
        """Initialize the profile provider.

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

    async def get(self) -> str:
        """Get the profile information as a formatted string.

        Returns:
            Formatted profile information
        """
        try:
            profile = await self._service.get_profile(self._config.fid)

            return (
                f"Farcaster Profile:\n"
                f"- Username: @{profile.username}\n"
                f"- Name: {profile.name}\n"
                f"- FID: {profile.fid}\n"
                f"- Bio: {profile.bio or 'N/A'}"
            )

        except Exception as e:
            return f"Error fetching Farcaster profile: {e!s}"
