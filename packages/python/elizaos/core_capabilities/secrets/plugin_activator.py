"""Plugin Activator Service.

Enables dynamic plugin activation when required secrets become available.
Plugins can register for activation with their secret requirements,
and will be activated automatically once all secrets are present.

Ported from secrets/services/plugin-activator.ts.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, ClassVar

from elizaos.types import Service

from .types import (
    PendingPluginActivation,
    PluginRequirementStatus,
    PluginSecretRequirement,
    SecretContext,
    SecretLevel,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

    from .service import SecretsService

logger = logging.getLogger(__name__)

PLUGIN_ACTIVATOR_SERVICE_TYPE = "PLUGIN_ACTIVATOR"


@dataclass
class PluginActivatorConfig:
    """Plugin activator service configuration."""

    enable_auto_activation: bool = True
    polling_interval_ms: int = 5000
    max_wait_ms: int = 0  # 0 = wait forever


@dataclass
class RegisteredPlugin:
    """Registered plugin with callbacks for secret change notifications."""

    plugin: Any
    secret_keys: list[str]
    activation_callback: Callable[[], Awaitable[None]] | None = None


class PluginActivatorService(Service):
    """Plugin Activator Service.

    Manages the lifecycle of plugins that depend on secrets:
    - Tracks plugins waiting for secrets
    - Automatically activates plugins when requirements are met
    - Notifies plugins when their secrets change
    - Supports on_secrets_ready and on_secret_changed callbacks
    """

    service_type: ClassVar[str] = PLUGIN_ACTIVATOR_SERVICE_TYPE
    capability_description: str = (
        "Activate plugins dynamically when their required secrets become available"
    )

    def __init__(
        self,
        runtime: IAgentRuntime | None = None,
        config: PluginActivatorConfig | None = None,
    ) -> None:
        super().__init__(runtime)
        self._config = config or PluginActivatorConfig()
        self._secrets_service: SecretsService | None = None
        self._pending_plugins: dict[str, PendingPluginActivation] = {}
        self._activated_plugins: set[str] = set()
        self._plugin_secret_mapping: dict[str, set[str]] = {}
        self._polling_task: asyncio.Task[None] | None = None
        self._unsubscribe_secret_changes: Callable[[], None] | None = None
        self._registered_plugins: dict[str, RegisteredPlugin] = {}
        self._secrets_ready_listeners: dict[
            str, list[Callable[[IAgentRuntime], Awaitable[None]]]
        ] = {}
        self._secret_changed_listeners: dict[
            str, list[Callable[[str, str | None, IAgentRuntime], Awaitable[None]]]
        ] = {}

    @classmethod
    async def start(
        cls,
        runtime: IAgentRuntime,
        config: PluginActivatorConfig | None = None,
    ) -> PluginActivatorService:
        """Start the service."""
        service = cls(runtime, config)
        await service._initialize()
        return service

    async def _initialize(self) -> None:
        logger.info("[PluginActivator] Initializing")

        if self.runtime is not None:
            for svc in (self.runtime.services or {}).values():
                if getattr(svc, "service_type", None) == "secrets":
                    self._secrets_service = svc  # type: ignore[assignment]
                    break

        if not self._secrets_service:
            await self._wait_for_secrets_service()
        else:
            self._bind_to_secrets_service()

        if self._config.enable_auto_activation and self._config.polling_interval_ms > 0:
            self._start_polling()

        logger.info("[PluginActivator] Initialized")

    async def _wait_for_secrets_service(self) -> None:
        """Wait for SecretsService to become available."""
        max_attempts = 20
        delay_s = 0.25

        for _ in range(max_attempts):
            await asyncio.sleep(delay_s)
            if self.runtime is not None:
                for svc in (self.runtime.services or {}).values():
                    if getattr(svc, "service_type", None) == "secrets":
                        self._secrets_service = svc  # type: ignore[assignment]
                        logger.info("[PluginActivator] SecretsService now available")
                        self._bind_to_secrets_service()
                        return

        logger.warning(
            "[PluginActivator] SecretsService not available after waiting, activation will be limited"
        )

    def _bind_to_secrets_service(self) -> None:
        if not self._secrets_service or self._unsubscribe_secret_changes:
            return

        if hasattr(self._secrets_service, "on_any_secret_changed"):
            self._unsubscribe_secret_changes = self._secrets_service.on_any_secret_changed(
                self._on_secret_changed
            )

    async def stop(self) -> None:
        logger.info("[PluginActivator] Stopping")

        if self._polling_task and not self._polling_task.done():
            self._polling_task.cancel()
            self._polling_task = None

        if self._unsubscribe_secret_changes:
            self._unsubscribe_secret_changes()
            self._unsubscribe_secret_changes = None

        self._pending_plugins.clear()
        self._activated_plugins.clear()
        self._plugin_secret_mapping.clear()
        self._registered_plugins.clear()
        self._secrets_ready_listeners.clear()
        self._secret_changed_listeners.clear()

        logger.info("[PluginActivator] Stopped")

    # ------------------------------------------------------------------
    # Plugin Registration
    # ------------------------------------------------------------------

    async def register_plugin(
        self,
        plugin: Any,
        activation_callback: Callable[[], Awaitable[None]] | None = None,
    ) -> bool:
        """Register a plugin for activation when secrets are ready."""
        plugin_id: str = getattr(plugin, "name", str(plugin))

        if plugin_id in self._activated_plugins:
            logger.debug("[PluginActivator] Plugin %s already activated", plugin_id)
            return True

        required_secrets: dict[str, PluginSecretRequirement] = (
            getattr(plugin, "required_secrets", {}) or {}
        )
        all_secret_keys = list(required_secrets.keys())

        self._registered_plugins[plugin_id] = RegisteredPlugin(
            plugin=plugin,
            secret_keys=all_secret_keys,
            activation_callback=activation_callback,
        )

        if not required_secrets:
            logger.info(
                "[PluginActivator] Plugin %s has no secret requirements, activating",
                plugin_id,
            )
            return await self._activate_plugin(plugin_id, plugin, activation_callback)

        status = await self.check_plugin_requirements(plugin)

        if status.ready:
            logger.info(
                "[PluginActivator] Plugin %s has all required secrets, activating",
                plugin_id,
            )
            return await self._activate_plugin(plugin_id, plugin, activation_callback)

        logger.info(
            "[PluginActivator] Plugin %s queued, waiting for: %s",
            plugin_id,
            ", ".join(status.missing_required),
        )

        required_keys = [key for key, req in required_secrets.items() if req.required]

        async def activate_pending_plugin() -> None:
            await self._activate_plugin(plugin_id, plugin, activation_callback)

        self._pending_plugins[plugin_id] = PendingPluginActivation(
            plugin_id=plugin_id,
            required_secrets=required_keys,
            callback=activate_pending_plugin,
            registered_at=time.time(),
        )

        for secret_key in required_keys:
            if secret_key not in self._plugin_secret_mapping:
                self._plugin_secret_mapping[secret_key] = set()
            self._plugin_secret_mapping[secret_key].add(plugin_id)

        return False

    def unregister_plugin(self, plugin_id: str) -> bool:
        """Unregister a pending plugin."""
        pending = self._pending_plugins.get(plugin_id)
        if not pending:
            return False

        for secret_key in pending.required_secrets:
            plugins = self._plugin_secret_mapping.get(secret_key)
            if plugins:
                plugins.discard(plugin_id)
                if not plugins:
                    del self._plugin_secret_mapping[secret_key]

        del self._pending_plugins[plugin_id]
        logger.info("[PluginActivator] Unregistered plugin %s", plugin_id)
        return True

    # ------------------------------------------------------------------
    # Plugin Activation
    # ------------------------------------------------------------------

    async def _activate_plugin(
        self,
        plugin_id: str,
        plugin: Any,
        callback: Callable[[], Awaitable[None]] | None = None,
    ) -> bool:
        try:
            if callback:
                await callback()

            on_secrets_ready = getattr(plugin, "on_secrets_ready", None)
            if on_secrets_ready:
                await on_secrets_ready(self.runtime)

            self._activated_plugins.add(plugin_id)
            self._pending_plugins.pop(plugin_id, None)

            logger.info("[PluginActivator] Activated plugin %s", plugin_id)

            # Notify listeners
            listeners = self._secrets_ready_listeners.get(plugin_id, [])
            for listener in listeners:
                try:
                    await listener(self.runtime)
                except Exception as exc:
                    logger.error(
                        "[PluginActivator] onSecretsReady listener failed for %s: %s",
                        plugin_id,
                        exc,
                    )

            return True
        except Exception as exc:
            logger.error(
                "[PluginActivator] Failed to activate plugin %s: %s",
                plugin_id,
                exc,
            )
            return False

    async def check_plugin_requirements(self, plugin: Any) -> PluginRequirementStatus:
        """Check requirements for a plugin."""
        plugin_id: str = getattr(plugin, "name", str(plugin))
        required_secrets: dict[str, PluginSecretRequirement] = (
            getattr(plugin, "required_secrets", {}) or {}
        )

        if not required_secrets:
            return PluginRequirementStatus(
                plugin_id=plugin_id,
                ready=True,
                missing_required=[],
                missing_optional=[],
                invalid=[],
                message="No secrets required",
            )

        if not self._secrets_service:
            required_keys = [k for k, r in required_secrets.items() if r.required]
            return PluginRequirementStatus(
                plugin_id=plugin_id,
                ready=len(required_keys) == 0,
                missing_required=required_keys,
                missing_optional=[],
                invalid=[],
                message="SecretsService not available",
            )

        result = await self._secrets_service.check_plugin_requirements(plugin_id, required_secrets)
        return PluginRequirementStatus(
            plugin_id=plugin_id,
            ready=result.ready,
            missing_required=result.missing_required,
            missing_optional=result.missing_optional,
            invalid=result.invalid,
            message="All secrets available"
            if result.ready
            else f"Missing: {', '.join(result.missing_required)}",
        )

    def get_plugin_statuses(
        self,
    ) -> dict[str, dict[str, Any]]:
        """Get status of all registered plugins."""
        statuses: dict[str, dict[str, Any]] = {}

        for plugin_id, pending in self._pending_plugins.items():
            statuses[plugin_id] = {
                "pending": True,
                "activated": False,
                "missing_secrets": pending.required_secrets,
            }

        for plugin_id in self._activated_plugins:
            statuses[plugin_id] = {
                "pending": False,
                "activated": True,
                "missing_secrets": [],
            }

        return statuses

    # ------------------------------------------------------------------
    # Secret Change Handling
    # ------------------------------------------------------------------

    async def _on_secret_changed(
        self,
        key: str,
        value: str | None,
        context: SecretContext,
    ) -> None:
        if context.level != SecretLevel.GLOBAL:
            return

        affected_plugins = self._plugin_secret_mapping.get(key)
        if affected_plugins:
            logger.debug(
                "[PluginActivator] Secret %s changed, checking %d plugins",
                key,
                len(affected_plugins),
            )
            for plugin_id in list(affected_plugins):
                pending = self._pending_plugins.get(plugin_id)
                if not pending:
                    continue
                missing = await self._get_missing_secrets(pending.required_secrets)
                if not missing:
                    logger.info(
                        "[PluginActivator] All secrets available for %s, activating",
                        plugin_id,
                    )
                    await pending.callback()

        await self._notify_secret_changed(key, value)

    async def _notify_secret_changed(self, key: str, value: str | None) -> None:
        """Notify activated plugins about a secret change."""
        for plugin_id, registered in self._registered_plugins.items():
            if key not in registered.secret_keys:
                continue
            if plugin_id not in self._activated_plugins:
                continue
            on_changed = getattr(registered.plugin, "on_secret_changed", None)
            if on_changed:
                try:
                    logger.debug(
                        "[PluginActivator] Notifying plugin %s of secret change: %s",
                        plugin_id,
                        key,
                    )
                    await on_changed(key, value, self.runtime)
                except Exception as exc:
                    logger.error(
                        "[PluginActivator] Plugin %s onSecretChanged failed: %s",
                        plugin_id,
                        exc,
                    )

        # Notify specific listeners
        for listener in self._secret_changed_listeners.get(key, []):
            try:
                await listener(key, value, self.runtime)
            except Exception as exc:
                logger.error(
                    "[PluginActivator] Secret changed listener failed for %s: %s",
                    key,
                    exc,
                )

        # Notify global listeners
        for listener in self._secret_changed_listeners.get("__ALL_SECRETS__", []):
            try:
                await listener(key, value, self.runtime)
            except Exception as exc:
                logger.error(
                    "[PluginActivator] Global secret changed listener failed for %s: %s",
                    key,
                    exc,
                )

    async def _get_missing_secrets(self, keys: list[str]) -> list[str]:
        if not self._secrets_service:
            return list(keys)
        return await self._secrets_service.get_missing_secrets(keys, "global")

    # ------------------------------------------------------------------
    # Polling
    # ------------------------------------------------------------------

    def _start_polling(self) -> None:
        if self._polling_task is not None:
            return

        async def _poll_loop() -> None:
            interval = self._config.polling_interval_ms / 1000.0
            while True:
                await asyncio.sleep(interval)
                await self._check_pending_plugins()

        self._polling_task = asyncio.create_task(_poll_loop())
        logger.debug(
            "[PluginActivator] Started polling every %dms",
            self._config.polling_interval_ms,
        )

    async def _check_pending_plugins(self) -> None:
        if not self._pending_plugins:
            return

        now = time.time()

        for plugin_id in list(self._pending_plugins.keys()):
            pending = self._pending_plugins.get(plugin_id)
            if not pending:
                continue

            if self._config.max_wait_ms > 0:
                elapsed_ms = (now - pending.registered_at) * 1000
                if elapsed_ms > self._config.max_wait_ms:
                    logger.warning(
                        "[PluginActivator] Plugin %s timed out waiting for secrets",
                        plugin_id,
                    )
                    self.unregister_plugin(plugin_id)
                    continue

            missing = await self._get_missing_secrets(pending.required_secrets)
            if not missing:
                logger.info("[PluginActivator] Secrets now available for %s", plugin_id)
                await pending.callback()

    # ------------------------------------------------------------------
    # Utility Methods
    # ------------------------------------------------------------------

    def get_pending_plugins(self) -> list[str]:
        return list(self._pending_plugins.keys())

    def get_activated_plugins(self) -> list[str]:
        return list(self._activated_plugins)

    def is_pending(self, plugin_id: str) -> bool:
        return plugin_id in self._pending_plugins

    def is_activated(self, plugin_id: str) -> bool:
        return plugin_id in self._activated_plugins

    def get_required_secrets(self) -> set[str]:
        secrets: set[str] = set()
        for pending in self._pending_plugins.values():
            secrets.update(pending.required_secrets)
        return secrets

    def get_plugins_waiting_for(self, secret_key: str) -> list[str]:
        plugins = self._plugin_secret_mapping.get(secret_key)
        return list(plugins) if plugins else []

    # ------------------------------------------------------------------
    # Callback Subscription Methods
    # ------------------------------------------------------------------

    def on_secrets_ready(
        self,
        plugin_id: str,
        callback: Callable[[IAgentRuntime], Awaitable[None]],
    ) -> Callable[[], None]:
        """Subscribe to secrets ready event for a specific plugin."""
        if plugin_id not in self._secrets_ready_listeners:
            self._secrets_ready_listeners[plugin_id] = []
        self._secrets_ready_listeners[plugin_id].append(callback)

        if plugin_id in self._activated_plugins:

            async def notify_ready() -> None:
                await callback(self.runtime)

            asyncio.create_task(notify_ready())

        def unsubscribe() -> None:
            listeners = self._secrets_ready_listeners.get(plugin_id, [])
            if callback in listeners:
                listeners.remove(callback)
            if not listeners:
                self._secrets_ready_listeners.pop(plugin_id, None)

        return unsubscribe

    def on_secret_changed_key(
        self,
        secret_key: str,
        callback: Callable[[str, str | None, IAgentRuntime], Awaitable[None]],
    ) -> Callable[[], None]:
        """Subscribe to secret changed events for a specific secret key."""
        if secret_key not in self._secret_changed_listeners:
            self._secret_changed_listeners[secret_key] = []
        self._secret_changed_listeners[secret_key].append(callback)

        def unsubscribe() -> None:
            listeners = self._secret_changed_listeners.get(secret_key, [])
            if callback in listeners:
                listeners.remove(callback)
            if not listeners:
                self._secret_changed_listeners.pop(secret_key, None)

        return unsubscribe

    def on_any_secret_changed(
        self,
        callback: Callable[[str, str | None, IAgentRuntime], Awaitable[None]],
    ) -> Callable[[], None]:
        """Subscribe to all secret changed events."""
        global_key = "__ALL_SECRETS__"
        if global_key not in self._secret_changed_listeners:
            self._secret_changed_listeners[global_key] = []
        self._secret_changed_listeners[global_key].append(callback)

        def unsubscribe() -> None:
            listeners = self._secret_changed_listeners.get(global_key, [])
            if callback in listeners:
                listeners.remove(callback)
            if not listeners:
                self._secret_changed_listeners.pop(global_key, None)

        return unsubscribe

    def get_registered_plugin(self, plugin_id: str) -> Any | None:
        reg = self._registered_plugins.get(plugin_id)
        return reg.plugin if reg else None

    def get_registered_plugin_ids(self) -> list[str]:
        return list(self._registered_plugins.keys())

    def has_secret_changed_callback(self, plugin_id: str) -> bool:
        reg = self._registered_plugins.get(plugin_id)
        return reg is not None and hasattr(reg.plugin, "on_secret_changed")

    def has_secrets_ready_callback(self, plugin_id: str) -> bool:
        reg = self._registered_plugins.get(plugin_id)
        return reg is not None and hasattr(reg.plugin, "on_secrets_ready")
