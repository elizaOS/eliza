"""Plugin configuration status provider.

Checks actual plugin config schemas against the runtime environment and
reports which plugins are fully configured vs. which are missing keys.

Ported from plugin-manager/providers/pluginConfigurationStatus.ts.
"""

from __future__ import annotations

import os
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

_CONFIGURATION_EXTRA_KEYWORDS: list[str] = [
    "plugin configuration",
    "configuration status",
    "config status",
    "schema",
    "config schema",
    "missing keys",
    "missing env",
    "environment variable",
    "environment variables",
    "env var",
    "env vars",
    "setup",
    "configure plugin",
    "plugin settings",
    "integration config",
    "connector config",
    "credential",
    "credentials",
    "secret",
    "secrets",
]

PLUGIN_CONFIGURATION_STATUS_KEYWORDS: list[str] = build_provider_keywords(
    PLUGIN_MANAGER_BASE_KEYWORDS,
    COMMON_CONNECTOR_KEYWORDS,
    _CONFIGURATION_EXTRA_KEYWORDS,
)


def _get_missing_config_keys(plugin: object) -> list[str]:
    """Check which env vars from a plugin's config dict are missing.

    Uses the plugin's ``config`` attribute (a dict mapping env-var names to
    default values).  A key is considered missing when the default is ``None``
    or ``""`` and no matching environment variable is set.
    """
    config = getattr(plugin, "config", None)
    if not isinstance(config, dict):
        return []

    missing: list[str] = []
    for key, default in config.items():
        if default is None or default == "":
            if not os.environ.get(key):
                missing.append(key)
    return missing


def _get_plugin_config_status(plugin: object) -> dict:
    config = getattr(plugin, "config", None)
    if not isinstance(config, dict):
        return {"configured": True, "missingKeys": [], "totalKeys": 0}

    missing = _get_missing_config_keys(plugin)
    return {
        "configured": len(missing) == 0,
        "missingKeys": missing,
        "totalKeys": len(config),
    }


async def get_plugin_configuration_status(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide plugin configuration status based on actual plugin config schemas."""

    pm_svc: PluginManagerService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "plugin_manager":
            pm_svc = svc  # type: ignore[assignment]
            break

    # Build dynamic keywords from loaded plugin names
    dynamic_keywords: list[str] = []
    if pm_svc is not None:
        dynamic_keywords = keywords_from_plugin_names([p.name for p in pm_svc.get_all_plugins()])
    relevance_keywords = build_provider_keywords(
        PLUGIN_CONFIGURATION_STATUS_KEYWORDS,
        dynamic_keywords,
    )

    if not is_provider_relevant(message, state, relevance_keywords):
        return ProviderResult(text="")

    if pm_svc is None:
        return ProviderResult(
            text="Configuration or plugin manager service not available",
            data={"available": False},
            values={"configurationServicesAvailable": False},
        )

    all_plugins = pm_svc.get_all_plugins()

    configured_count = 0
    needs_config_count = 0
    plugin_statuses: list[dict] = []

    for plugin_state in all_plugins:
        # If the underlying plugin object is not available, assume configured
        plugin_obj = getattr(plugin_state, "plugin", None)
        if plugin_obj is None:
            plugin_statuses.append(
                {
                    "name": plugin_state.name,
                    "status": plugin_state.status.value,
                    "configured": True,
                    "missingKeys": [],
                    "totalKeys": 0,
                }
            )
            configured_count += 1
            continue

        config_status = _get_plugin_config_status(plugin_obj)
        plugin_statuses.append(
            {
                "name": plugin_state.name,
                "status": plugin_state.status.value,
                "configured": config_status["configured"],
                "missingKeys": config_status["missingKeys"],
                "totalKeys": config_status["totalKeys"],
            }
        )
        if config_status["configured"]:
            configured_count += 1
        else:
            needs_config_count += 1

    if not all_plugins:
        status_text = "No plugins registered."
    else:
        status_text = "Plugin Configuration Status:\n"
        status_text += (
            f"Total: {len(all_plugins)}, "
            f"Configured: {configured_count}, "
            f"Needs config: {needs_config_count}\n"
        )
        if needs_config_count > 0:
            status_text += "\nPlugins needing configuration:\n"
            for ps in plugin_statuses:
                if not ps["configured"]:
                    missing_str = ", ".join(ps["missingKeys"])
                    status_text += f"- {ps['name']}: missing {missing_str}\n"

    return ProviderResult(
        text=status_text,
        data={"plugins": plugin_statuses},
        values={
            "configurationServicesAvailable": True,
            "totalPlugins": len(all_plugins),
            "configuredPlugins": configured_count,
            "needsConfiguration": needs_config_count,
            "hasUnconfiguredPlugins": needs_config_count > 0,
        },
    )


plugin_configuration_status_provider = Provider(
    name="PLUGIN_CONFIGURATION_STATUS",
    description="Provides plugin configuration status based on actual plugin config schemas",
    get=get_plugin_configuration_status,
    dynamic=True,
)
