"""Registry plugins provider.

Provides available plugins from the elizaOS registry, installed plugin
status, and searchable plugin knowledge to the agent context.

Ported from plugin-manager/providers/registryPluginsProvider.ts.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

from ..relevance import (
    COMMON_CONNECTOR_KEYWORDS,
    PLUGIN_MANAGER_BASE_KEYWORDS,
    build_provider_keywords,
    is_provider_relevant,
    keywords_from_plugin_names,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

    from ..service import PluginManagerService
    from ..services.plugin_registry_service import PluginRegistryService

logger = logging.getLogger("elizaos.plugin_manager.registry_plugins")

_REGISTRY_EXTRA_KEYWORDS: list[str] = [
    "plugin registry",
    "registry plugin",
    "registry plugins",
    "plugin catalog",
    "plugin marketplace",
    "discover plugins",
    "search plugins",
    "available plugins",
    "installed plugins",
    "plugin directory",
    "integration directory",
    "connector directory",
    "connect plugin",
    "install plugin",
]

REGISTRY_PROVIDER_KEYWORDS: list[str] = build_provider_keywords(
    PLUGIN_MANAGER_BASE_KEYWORDS,
    COMMON_CONNECTOR_KEYWORDS,
    _REGISTRY_EXTRA_KEYWORDS,
)


async def get_registry_plugins(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide available plugins from the registry and installed status."""

    pm_svc: PluginManagerService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "plugin_manager":
            pm_svc = svc  # type: ignore[assignment]
            break

    # Build dynamic keywords
    dynamic_keywords: list[str] = []
    if pm_svc is not None:
        dynamic_keywords = keywords_from_plugin_names([p.name for p in pm_svc.get_all_plugins()])
    relevance_keywords = build_provider_keywords(
        REGISTRY_PROVIDER_KEYWORDS,
        dynamic_keywords,
    )

    if not is_provider_relevant(message, state, relevance_keywords):
        return ProviderResult(text="")

    if pm_svc is None:
        return ProviderResult(
            text="Plugin manager service not available",
            data={"error": "Plugin manager service not available"},
        )

    # Attempt to get the registry service
    registry_svc: PluginRegistryService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "plugin_registry":
            registry_svc = svc  # type: ignore[assignment]
            break

    registry_plugins: list[dict] = []
    registry_error: str | None = None

    if registry_svc is not None:
        try:
            all_metadata = await registry_svc.get_all_plugins()
            registry_plugins = [
                {
                    "name": m.name,
                    "description": m.description,
                    "repository": m.repository,
                    "tags": m.tags or [],
                    "version": m.latest_version,
                }
                for m in all_metadata
            ]
        except Exception as exc:
            msg = str(exc)
            logger.warning("[registryPluginsProvider] Failed to fetch registry: %s", msg)
            registry_error = msg
    else:
        registry_error = "Plugin registry service not available"

    # Installed plugins from plugin manager
    installed_plugins: list[dict] = []
    try:
        ejected = await pm_svc.list_ejected_plugins()
        installed_plugins = [
            {"name": p.name, "version": p.version, "path": p.path} for p in ejected
        ]
    except Exception:
        pass

    text = ""
    if registry_error:
        text += f"**Registry unavailable:** {registry_error}\n"
    elif not registry_plugins:
        text += "No plugins available in registry.\n"
    else:
        text += f"**Available Plugins from Registry ({len(registry_plugins)} total):**\n"
        for plugin in registry_plugins:
            desc = plugin.get("description") or "No description"
            text += f"- **{plugin['name']}**: {desc}\n"
            tags = plugin.get("tags", [])
            if tags:
                text += f"  Tags: {', '.join(tags)}\n"

    if installed_plugins:
        text += "\n**Installed Registry Plugins:**\n"
        for plugin in installed_plugins:
            text += f"- **{plugin['name']}** v{plugin['version']} (Path: {plugin['path']})\n"

    return ProviderResult(
        text=text,
        data={
            "availablePlugins": registry_plugins,
            "installedPlugins": installed_plugins,
            "registryError": registry_error,
        },
        values={
            "availableCount": len(registry_plugins),
            "installedCount": len(installed_plugins),
            "registryAvailable": registry_error is None,
        },
    )


registry_plugins_provider = Provider(
    name="REGISTRY_PLUGINS",
    description=(
        "Provides available plugins from the elizaOS registry, "
        "installed plugin status, and searchable plugin knowledge"
    ),
    get=get_registry_plugins,
    dynamic=True,
)
