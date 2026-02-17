"""Plugin Registry Service - communicates with the elizaOS plugin registry API."""

from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from elizaos_plugin_plugin_manager.types import (
    CloneResult,
    PluginMetadata,
    PluginSearchResult,
    RegistryResult,
)

logger = logging.getLogger(__name__)

API_SERVICE_URL_DEFAULT = "https://www.dev.elizacloud.ai/api"


class PluginRegistryService:
    """Communicates with the elizaOS plugin registry API."""

    service_type = "registry"

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.api_url = api_url or API_SERVICE_URL_DEFAULT
        self.api_key = api_key or ""
        self._client = httpx.AsyncClient()

    async def _api_fetch(
        self,
        endpoint: str,
        method: str = "GET",
        body: dict[str, str | int | list[str]] | None = None,
    ) -> dict[str, str | int | float | list[dict[str, str]] | dict[str, str] | None] | None:
        """Make an API request to the registry service."""
        url = f"{self.api_url}{endpoint}"
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        if method == "POST":
            response = await self._client.post(url, headers=headers, json=body)
        else:
            response = await self._client.get(url, headers=headers)

        if response.status_code != 200:
            error_body = response.text
            raise RuntimeError(
                f"API request to {endpoint} failed ({response.status_code}): {error_body}"
            )

        result: dict[
            str, str | int | float | list[dict[str, str]] | dict[str, str] | None
        ] = response.json()
        return result.get("data")  # type: ignore[return-value]

    async def search_plugins(self, query: str) -> RegistryResult[list[PluginSearchResult]]:
        """Search for plugins in the registry."""
        logger.info("[PluginRegistryService] Searching for plugins matching: %s", query)

        try:
            raw_data = await self._api_fetch(
                "/plugins/search",
                method="POST",
                body={"query": query, "limit": 10},
            )
            results: list[PluginSearchResult] = []
            if isinstance(raw_data, list):
                for item in raw_data:
                    if isinstance(item, dict):
                        results.append(
                            PluginSearchResult(
                                name=str(item.get("name", "")),
                                description=str(item.get("description", "")),
                                id=item.get("id"),  # type: ignore[arg-type]
                                score=item.get("score"),  # type: ignore[arg-type]
                                tags=item.get("tags"),  # type: ignore[arg-type]
                                version=item.get("version"),  # type: ignore[arg-type]
                                repository=item.get("repository"),  # type: ignore[arg-type]
                                relevant_section=item.get("relevantSection"),  # type: ignore[arg-type]
                            )
                        )
            return RegistryResult(data=results, from_api=True)
        except Exception as e:
            message = str(e)
            logger.warning("[PluginRegistryService] Search failed: %s", message)
            return RegistryResult(data=[], from_api=False, error=message)

    async def get_plugin_details(
        self, name: str
    ) -> RegistryResult[PluginMetadata | None]:
        """Get details for a specific plugin."""
        logger.info("[PluginRegistryService] Getting details for plugin: %s", name)

        try:
            encoded_name = quote(name, safe="")
            raw_data = await self._api_fetch(f"/plugins/{encoded_name}", method="GET")
            if raw_data is None or not isinstance(raw_data, dict):
                return RegistryResult(data=None, from_api=True)

            metadata = PluginMetadata(
                name=str(raw_data.get("name", name)),
                description=str(raw_data.get("description", "")),
                author=str(raw_data.get("author", "")),
                repository=str(raw_data.get("repository", "")),
                versions=raw_data.get("versions", []),  # type: ignore[arg-type]
                latest_version=str(raw_data.get("latestVersion", "")),
                runtime_version=str(raw_data.get("runtimeVersion", "")),
                maintainer=str(raw_data.get("maintainer", "")),
                tags=raw_data.get("tags"),  # type: ignore[arg-type]
                categories=raw_data.get("categories"),  # type: ignore[arg-type]
            )
            return RegistryResult(data=metadata, from_api=True)
        except Exception as e:
            message = str(e)
            logger.warning("[PluginRegistryService] Get details failed: %s", message)
            return RegistryResult(data=None, from_api=False, error=message)

    async def get_all_plugins(self) -> RegistryResult[list[PluginMetadata]]:
        """Get all plugins from the registry."""
        logger.info("[PluginRegistryService] Getting all plugins from registry")

        try:
            raw_data = await self._api_fetch("/plugins", method="GET")
            results: list[PluginMetadata] = []
            if isinstance(raw_data, list):
                for item in raw_data:
                    if isinstance(item, dict):
                        results.append(
                            PluginMetadata(
                                name=str(item.get("name", "")),
                                description=str(item.get("description", "")),
                                author=str(item.get("author", "")),
                                repository=str(item.get("repository", "")),
                                versions=item.get("versions", []),  # type: ignore[arg-type]
                                latest_version=str(item.get("latestVersion", "")),
                                runtime_version=str(item.get("runtimeVersion", "")),
                                maintainer=str(item.get("maintainer", "")),
                                tags=item.get("tags"),  # type: ignore[arg-type]
                                categories=item.get("categories"),  # type: ignore[arg-type]
                            )
                        )
            return RegistryResult(data=results, from_api=True)
        except Exception as e:
            message = str(e)
            logger.warning("[PluginRegistryService] Get all plugins failed: %s", message)
            return RegistryResult(data=[], from_api=False, error=message)

    async def clone_plugin(self, plugin_name: str) -> CloneResult:
        """Clone a plugin repository for local development."""
        logger.info("[PluginRegistryService] Cloning plugin: %s", plugin_name)

        details_result = await self.get_plugin_details(plugin_name)
        if not details_result.from_api:
            return CloneResult(
                success=False,
                error=f"Cannot reach plugin registry: {details_result.error or ''}",
            )

        plugin = details_result.data
        if plugin is None or not plugin.repository:
            return CloneResult(
                success=False,
                error=f'Plugin "{plugin_name}" not found in registry or has no repository',
            )

        short_name = plugin.name.replace("@elizaos/", "")
        clone_dir = f"cloned-plugins/{short_name}"

        return CloneResult(
            success=True,
            plugin_name=plugin.name,
            local_path=clone_dir,
            has_tests=False,
            dependencies={},
        )

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()
