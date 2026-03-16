from __future__ import annotations

from elizaos_plugin_n8n.client import PluginCreationClient
from elizaos_plugin_n8n.config import N8nConfig


class PluginCreationService:
    """
    Minimal service wrapper for plugin creation (TS parity: `PluginCreationService`).
    """

    service_type: str = "plugin_creation"
    capability_description: str = "Plugin creation service"

    def __init__(self, client: PluginCreationClient) -> None:
        self._client = client

    @classmethod
    def from_env(cls) -> PluginCreationService:
        config = N8nConfig.from_env()
        return cls(PluginCreationClient(config))

    @property
    def client(self) -> PluginCreationClient:
        return self._client

    async def stop(self) -> None:
        # Best-effort cleanup; client uses HTTPX under the hood.
        close = getattr(self._client, "close", None)
        if callable(close):
            await close()
