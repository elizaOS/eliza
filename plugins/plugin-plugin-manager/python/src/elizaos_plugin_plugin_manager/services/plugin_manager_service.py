"""Plugin Manager Service - manages dynamic loading/unloading and registry operations."""

from __future__ import annotations

import logging
import re
import time
from urllib.parse import quote

import httpx

from elizaos_plugin_plugin_manager.types import (
    ComponentRegistration,
    ComponentType,
    DynamicPluginInfo,
    DynamicPluginStatus,
    LoadPluginParams,
    PluginComponents,
    PluginManagerConfig,
    PluginState,
    PluginStatus,
    RegistryEntry,
    UnloadPluginParams,
    PROTECTED_PLUGINS,
)

logger = logging.getLogger(__name__)

REGISTRY_URL = (
    "https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json"
)
CACHE_DURATION_MS = 3_600_000  # 1 hour


class PluginManagerService:
    """Manages dynamic loading and unloading of plugins at runtime."""

    service_type = "plugin_manager"

    def __init__(self, config: PluginManagerConfig | None = None) -> None:
        self.config = config or PluginManagerConfig()
        self._plugins: dict[str, PluginState] = {}
        self._original_plugins: set[str] = set()
        self._protected_plugins: set[str] = set(PROTECTED_PLUGINS)
        self._component_registry: dict[str, list[ComponentRegistration]] = {}
        self._installed_plugins: dict[str, DynamicPluginInfo] = {}
        self._registry_cache: dict[str, RegistryEntry] | None = None
        self._registry_cache_timestamp: int = 0
        self._client = httpx.AsyncClient()
        logger.info("[PluginManagerService] Initialized")

    def initialize_with_plugins(self, plugin_names: list[str]) -> None:
        """Initialize the service with a list of original plugin names."""
        for name in plugin_names:
            self._original_plugins.add(name)
            plugin_id = f"plugin-{name}"
            now = int(time.time() * 1000)
            state = PluginState(
                id=plugin_id,
                name=name,
                status=PluginStatus.LOADED,
                created_at=now,
                loaded_at=now,
                components=PluginComponents(),
            )
            self._plugins[plugin_id] = state

    def register_plugin(self, name: str, plugin_id: str) -> str:
        """Register a new plugin. Returns the plugin ID."""
        if plugin_id in self._plugins:
            raise ValueError(f"Plugin {name} already registered")

        if name in self._original_plugins:
            raise ValueError(
                f"Cannot register a plugin with the same name as an original plugin: {name}"
            )

        if self.is_protected_plugin(name):
            raise ValueError(f"Cannot register protected plugin: {name}")

        state = PluginState(
            id=plugin_id,
            name=name,
            status=PluginStatus.READY,
            created_at=int(time.time() * 1000),
            components=PluginComponents(),
        )
        self._plugins[plugin_id] = state
        return plugin_id

    def get_plugin(self, plugin_id: str) -> PluginState | None:
        """Get a plugin state by ID."""
        return self._plugins.get(plugin_id)

    def get_all_plugins(self) -> list[PluginState]:
        """Get all registered plugins."""
        return list(self._plugins.values())

    def get_loaded_plugins(self) -> list[PluginState]:
        """Get all loaded plugins."""
        return [p for p in self._plugins.values() if p.status == PluginStatus.LOADED]

    def update_plugin_state(self, plugin_id: str, status: PluginStatus) -> None:
        """Update a plugin's status."""
        state = self._plugins.get(plugin_id)
        if state is None:
            return
        state.status = status
        now = int(time.time() * 1000)
        if status == PluginStatus.LOADED:
            state.loaded_at = now
            state.error = None
        elif status == PluginStatus.UNLOADED:
            state.unloaded_at = now

    def set_plugin_error(self, plugin_id: str, error: str) -> None:
        """Set a plugin into error state."""
        state = self._plugins.get(plugin_id)
        if state is None:
            return
        state.status = PluginStatus.ERROR
        state.error = error

    def load_plugin(self, params: LoadPluginParams) -> None:
        """Load a plugin by ID."""
        state = self._plugins.get(params.plugin_id)
        if state is None:
            raise ValueError(f"Plugin {params.plugin_id} not found in registry")

        if params.force and self.is_protected_plugin(state.name):
            raise ValueError(f"Cannot force load protected plugin {state.name}")

        if state.status == PluginStatus.LOADED and not params.force:
            logger.info("[PluginManagerService] Plugin %s already loaded", state.name)
            return

        if (
            state.status not in (PluginStatus.READY, PluginStatus.UNLOADED)
            and not params.force
        ):
            raise ValueError(
                f"Plugin {state.name} is not ready to load (status: {state.status.value})"
            )

        logger.info("[PluginManagerService] Loading plugin %s...", state.name)
        self.update_plugin_state(params.plugin_id, PluginStatus.LOADED)
        logger.info("[PluginManagerService] Plugin %s loaded successfully", state.name)

    def unload_plugin(self, params: UnloadPluginParams) -> None:
        """Unload a plugin by ID."""
        state = self._plugins.get(params.plugin_id)
        if state is None:
            raise ValueError(f"Plugin {params.plugin_id} not found in registry")

        if state.status != PluginStatus.LOADED:
            logger.info("[PluginManagerService] Plugin %s is not loaded", state.name)
            return

        if state.name in self._original_plugins:
            raise ValueError(f"Cannot unload original plugin {state.name}")

        if self.is_protected_plugin(state.name):
            raise ValueError(f"Cannot unload protected plugin {state.name}")

        logger.info("[PluginManagerService] Unloading plugin %s...", state.name)
        self.update_plugin_state(params.plugin_id, PluginStatus.UNLOADED)
        logger.info("[PluginManagerService] Plugin %s unloaded successfully", state.name)

    def is_protected_plugin(self, plugin_name: str) -> bool:
        """Check if a plugin is protected."""
        if plugin_name in self._protected_plugins:
            return True

        without_prefix = plugin_name.removeprefix("@elizaos/")
        if without_prefix in self._protected_plugins:
            return True

        with_prefix = f"@elizaos/{plugin_name}"
        if with_prefix in self._protected_plugins:
            return True

        return plugin_name in self._original_plugins

    def can_unload_plugin(self, plugin_name: str) -> bool:
        """Check if a plugin can be unloaded."""
        return not self.is_protected_plugin(plugin_name)

    def get_protection_reason(self, plugin_name: str) -> str | None:
        """Get a human-readable reason why a plugin cannot be unloaded."""
        if plugin_name in self._protected_plugins:
            return f"{plugin_name} is a core system plugin and cannot be unloaded"

        without_prefix = plugin_name.removeprefix("@elizaos/")
        if without_prefix in self._protected_plugins:
            return f"{plugin_name} is a core system plugin and cannot be unloaded"

        with_prefix = f"@elizaos/{plugin_name}"
        if with_prefix in self._protected_plugins:
            return f"{plugin_name} is a core system plugin and cannot be unloaded"

        if plugin_name in self._original_plugins:
            return f"{plugin_name} was loaded at startup and is required for agent operation"

        return None

    def get_protected_plugins(self) -> list[str]:
        """Get list of protected plugin names."""
        return list(self._protected_plugins)

    def get_original_plugins(self) -> list[str]:
        """Get list of original plugin names."""
        return list(self._original_plugins)

    def track_component(
        self,
        plugin_id: str,
        component_type: ComponentType,
        component_name: str,
    ) -> None:
        """Track a component registration."""
        registration = ComponentRegistration(
            plugin_id=plugin_id,
            component_type=component_type,
            component_name=component_name,
            timestamp=int(time.time() * 1000),
        )
        if plugin_id not in self._component_registry:
            self._component_registry[plugin_id] = []
        self._component_registry[plugin_id].append(registration)

    def get_component_registrations(self, plugin_id: str) -> list[ComponentRegistration]:
        """Get component registrations for a plugin."""
        return self._component_registry.get(plugin_id, [])

    async def fetch_registry(self) -> dict[str, RegistryEntry]:
        """Fetch the plugin registry, using cache if available."""
        now = int(time.time() * 1000)
        if (
            self._registry_cache is not None
            and now - self._registry_cache_timestamp < CACHE_DURATION_MS
        ):
            return self._registry_cache

        response = await self._client.get(REGISTRY_URL)
        if response.status_code != 200:
            raise RuntimeError(f"Registry fetch failed: HTTP {response.status_code}")

        raw_data: dict[str, dict[str, str | dict[str, str | dict[str, str | None]] | None]] = (
            response.json()
        )
        registry: dict[str, RegistryEntry] = {}
        for key, val in raw_data.items():
            registry[key] = RegistryEntry(
                name=str(val.get("name", key)),
                repository=str(val.get("repository", "")),
                description=str(val.get("description", "")) if val.get("description") else None,
            )

        self._registry_cache = registry
        self._registry_cache_timestamp = now
        return registry

    def reset_registry_cache(self) -> None:
        """Reset the registry cache."""
        self._registry_cache = None
        self._registry_cache_timestamp = 0

    def get_installed_plugin_info(self, plugin_name: str) -> DynamicPluginInfo | None:
        """Get info about an installed plugin."""
        return self._installed_plugins.get(plugin_name)

    def list_installed_plugins(self) -> list[DynamicPluginInfo]:
        """List all installed plugins."""
        return list(self._installed_plugins.values())

    def record_installed_plugin(self, name: str, info: DynamicPluginInfo) -> None:
        """Record an installed plugin."""
        self._installed_plugins[name] = info

    async def stop(self) -> None:
        """Stop the service and clean up."""
        logger.info("[PluginManagerService] Stopping...")
        self._installed_plugins.clear()
        self._component_registry.clear()
        await self._client.aclose()
        logger.info("[PluginManagerService] Stopped")
