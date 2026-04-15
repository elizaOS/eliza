"""Plugin state provider.

Injects a summary of loaded plugins and their components into the agent
context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

    from ..service import PluginManagerService


async def get_plugin_state(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """Provide summary of loaded plugins and their components."""
    pm_svc: PluginManagerService | None = None
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "plugin_manager":
            pm_svc = svc  # type: ignore[assignment]
            break

    if pm_svc is None:
        return ProviderResult(text="", values={"pluginManagerAvailable": False}, data={})

    plugins = pm_svc.get_all_plugins()
    loaded = pm_svc.get_loaded_plugins()
    component_counts = pm_svc.get_total_component_count()

    lines = [
        "# Plugin State",
        f"Loaded: {len(loaded)}/{len(plugins)} plugins",
        f"Actions: {component_counts['actions']}, "
        f"Providers: {component_counts['providers']}, "
        f"Evaluators: {component_counts['evaluators']}, "
        f"Services: {component_counts['services']}",
    ]

    if plugins:
        lines.append("\nPlugins:")
        for p in sorted(plugins, key=lambda x: x.name):
            lines.append(f"- {p.name}: {p.status.value}")

    text = "\n".join(lines)

    return ProviderResult(
        text=text,
        values={
            "pluginManagerAvailable": True,
            "totalPlugins": len(plugins),
            "loadedPlugins": len(loaded),
            "componentCounts": component_counts,
        },
        data={
            "plugins": [{"name": p.name, "status": p.status.value} for p in plugins],
        },
    )


plugin_state_provider = Provider(
    name="PLUGIN_STATE",
    description="Summary of loaded plugins and their components",
    get=get_plugin_state,
    dynamic=True,
)
