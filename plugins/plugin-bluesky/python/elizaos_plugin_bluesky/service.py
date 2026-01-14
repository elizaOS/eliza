from __future__ import annotations

from elizaos_plugin_bluesky.client import BlueSkyClient
from elizaos_plugin_bluesky.config import BlueSkyConfig


class BlueSkyService:
    """
    Minimal service wrapper for BlueSky (TS parity: `BlueSkyService`).

    The TypeScript plugin integrates deeply with the elizaOS runtime; this Python
    wrapper provides a similar "service" surface for higher-level integrations.
    """

    service_type: str = "bluesky"
    capability_description: str = "Send and receive messages on BlueSky"

    def __init__(self, client: BlueSkyClient) -> None:
        self._client = client

    @classmethod
    def from_env(cls) -> BlueSkyService:
        config = BlueSkyConfig.from_env()
        return cls(BlueSkyClient(config))

    @property
    def client(self) -> BlueSkyClient:
        return self._client

    async def stop(self) -> None:
        await self._client.close()
