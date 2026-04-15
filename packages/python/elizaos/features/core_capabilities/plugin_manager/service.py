"""Plugin manager service.

Read-only plugin discovery and plugin/core status introspection.
Ported from plugin-plugin-manager TypeScript ``PluginManagerService``.

The Python port focuses on plugin state tracking and introspection.
Dynamic loading/unloading is environment-specific and not fully portable,
so the service provides registry management and status reporting.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, ClassVar

from elizaos.types import Service

from .types import (
    PROTECTED_PLUGINS,
    ComponentRegistration,
    EjectedPluginInfo,
    PluginComponents,
    PluginManagerConfig,
    PluginState,
    PluginStatus,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class PluginManagerService(Service):
    """Manages plugin state tracking and introspection.

    Provides a read-only registry of loaded plugins, their components,
    and status information.
    """

    service_type: ClassVar[str] = "plugin_manager"

    def __init__(
        self,
        config: PluginManagerConfig | None = None,
    ) -> None:
        super().__init__()
        self._plugin_config = config or PluginManagerConfig()
        self._plugins: dict[str, PluginState] = {}
        self._component_registry: dict[str, list[ComponentRegistration]] = {}

    @property
    def capability_description(self) -> str:
        return "Read-only plugin discovery and plugin/core status introspection"

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> PluginManagerService:
        service = cls()
        service._runtime = runtime
        service._initialize_registry(runtime)
        runtime.logger.info(
            "PluginManagerService initialized",
            src="service:plugin_manager",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        self._plugins.clear()
        self._component_registry.clear()
        if self._runtime:
            self._runtime.logger.info("PluginManagerService stopped", src="service:plugin_manager")

    # ------------------------------------------------------------------
    # Registry
    # ------------------------------------------------------------------

    def _initialize_registry(self, runtime: IAgentRuntime) -> None:
        """Populate registry from the runtime's currently loaded plugins."""
        plugins = getattr(runtime, "plugins", None) or []
        for plugin in plugins:
            name = getattr(plugin, "name", "unknown")
            plugin_id = name
            components = PluginComponents()

            # Track actions
            for action in getattr(plugin, "actions", []) or []:
                action_name = getattr(action, "name", str(action))
                components.actions.add(action_name)
                self._register_component(plugin_id, "action", action_name)

            # Track providers
            for provider in getattr(plugin, "providers", []) or []:
                provider_name = getattr(provider, "name", str(provider))
                components.providers.add(provider_name)
                self._register_component(plugin_id, "provider", provider_name)

            # Track evaluators
            for evaluator in getattr(plugin, "evaluators", []) or []:
                evaluator_name = getattr(evaluator, "name", str(evaluator))
                components.evaluators.add(evaluator_name)
                self._register_component(plugin_id, "evaluator", evaluator_name)

            # Track services
            for svc_cls in getattr(plugin, "services", []) or []:
                svc_type = getattr(svc_cls, "service_type", str(svc_cls))
                components.services.add(svc_type)
                self._register_component(plugin_id, "service", svc_type)

            now = time.time()
            self._plugins[plugin_id] = PluginState(
                id=plugin_id,
                name=name,
                status=PluginStatus.LOADED,
                created_at=now,
                loaded_at=now,
                components=components,
            )

    def _register_component(self, plugin_id: str, component_type: str, component_name: str) -> None:
        entry = ComponentRegistration(
            plugin_id=plugin_id,
            component_type=component_type,
            component_name=component_name,
            timestamp=time.time(),
        )
        self._component_registry.setdefault(plugin_id, []).append(entry)

    # ------------------------------------------------------------------
    # Query API
    # ------------------------------------------------------------------

    def get_plugin(self, plugin_id: str) -> PluginState | None:
        """Get a plugin's state by ID."""
        return self._plugins.get(plugin_id)

    def get_all_plugins(self) -> list[PluginState]:
        """Get all registered plugins."""
        return list(self._plugins.values())

    def get_loaded_plugins(self) -> list[PluginState]:
        """Get all currently loaded plugins."""
        return [p for p in self._plugins.values() if p.status == PluginStatus.LOADED]

    def get_plugin_components(self, plugin_id: str) -> list[ComponentRegistration]:
        """Get all registered components for a plugin."""
        return self._component_registry.get(plugin_id, [])

    def is_protected(self, plugin_name: str) -> bool:
        """Check if a plugin is protected from external manipulation."""
        return plugin_name in PROTECTED_PLUGINS

    def get_status_summary(self) -> dict[str, int]:
        """Get a summary of plugin statuses."""
        counts: dict[str, int] = {}
        for plugin in self._plugins.values():
            status = plugin.status.value
            counts[status] = counts.get(status, 0) + 1
        return counts

    def update_plugin_state(self, plugin_id: str, update: dict) -> None:
        """Update a plugin's state."""
        plugin = self._plugins.get(plugin_id)
        if plugin is None:
            return
        for key, value in update.items():
            if hasattr(plugin, key):
                setattr(plugin, key, value)

    def register_plugin(self, state: PluginState) -> None:
        """Register a new plugin in the manager."""
        if state.name in PROTECTED_PLUGINS and state.id in self._plugins:
            return  # Don't allow re-registration of protected plugins
        self._plugins[state.id] = state

    def get_total_component_count(self) -> dict[str, int]:
        """Get total count of each component type across all plugins."""
        counts: dict[str, int] = {"actions": 0, "providers": 0, "evaluators": 0, "services": 0}
        for plugin in self._plugins.values():
            if plugin.components:
                counts["actions"] += len(plugin.components.actions)
                counts["providers"] += len(plugin.components.providers)
                counts["evaluators"] += len(plugin.components.evaluators)
                counts["services"] += len(plugin.components.services)
        return counts

    async def list_ejected_plugins(self) -> list[EjectedPluginInfo]:
        """List all ejected plugins.

        Delegates to the CoreManagerService if available; otherwise returns
        an empty list.
        """
        if self._runtime is None:
            return []

        core_mgr = self._runtime.get_service("core_manager")

        if core_mgr is None:
            return []

        try:
            get_core_status = getattr(core_mgr, "get_core_status", None)
            if not callable(get_core_status):
                return []
            status = await get_core_status()
            if status.ejected:
                return [
                    EjectedPluginInfo(
                        name="@elizaos/core",
                        path=status.ejected_path,
                        version=status.version,
                        upstream=status.upstream,
                    )
                ]
        except Exception:
            pass

        return []
