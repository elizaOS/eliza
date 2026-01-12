from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_farcaster.config import FarcasterConfig
    from elizaos_plugin_farcaster.service import FarcasterService


class ProfileProvider:
    NAME = "farcaster_profile"
    DESCRIPTION = "Provides the agent's Farcaster profile information"

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

    async def get(self) -> str:
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


class ProfileProviderCamel(ProfileProvider):
    """TS-parity alias provider (camelCase name)."""

    NAME = "farcasterProfile"
