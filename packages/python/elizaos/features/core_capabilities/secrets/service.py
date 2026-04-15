"""Secrets service.

Core service for multi-level secret management.  Provides a unified API
for accessing global, world, and user secrets with encryption, access
control, and change notification support.

Ported from plugin-secrets-manager TypeScript ``SecretsService``.
"""

from __future__ import annotations

import builtins
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, ClassVar

from elizaos.types import Service

from .crypto import KeyManager
from .storage import (
    CharacterSettingsStorage,
    ComponentSecretStorage,
    CompositeSecretStorage,
    WorldMetadataStorage,
)
from .types import (
    PluginRequirementStatus,
    PluginSecretRequirement,
    SecretAccessLog,
    SecretChangeCallback,
    SecretChangeEvent,
    SecretConfig,
    SecretContext,
    SecretLevel,
    SecretMetadata,
    SecretsServiceConfig,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


class SecretsService(Service):
    """Multi-level secret management with encryption and access control."""

    service_type: ClassVar[str] = "secrets"

    def __init__(
        self,
        config: SecretsServiceConfig | None = None,
    ) -> None:
        super().__init__()
        self._secrets_config = config or SecretsServiceConfig()
        self._key_manager = KeyManager()
        self._global_storage: CharacterSettingsStorage | None = None
        self._world_storage: WorldMetadataStorage | None = None
        self._user_storage: ComponentSecretStorage | None = None
        self._storage: CompositeSecretStorage | None = None
        self._access_logs: list[SecretAccessLog] = []
        self._change_callbacks: dict[str, list[SecretChangeCallback]] = {}
        self._global_change_callbacks: list[SecretChangeCallback] = []

    @property
    def capability_description(self) -> str:
        return "Manage secrets at global, world, and user levels with encryption and access control"

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> SecretsService:
        service = cls()
        service._runtime = runtime
        await service._initialize(runtime)
        return service

    async def _initialize(self, runtime: IAgentRuntime) -> None:
        """Set up storage backends and key manager."""
        self._key_manager.initialize_from_agent_id(
            str(runtime.agent_id),
            self._secrets_config.encryption_salt,
        )

        self._global_storage = CharacterSettingsStorage(self._key_manager)
        self._world_storage = WorldMetadataStorage(self._key_manager)
        self._user_storage = ComponentSecretStorage(self._key_manager)
        self._storage = CompositeSecretStorage(
            global_storage=self._global_storage,
            world_storage=self._world_storage,
            user_storage=self._user_storage,
        )
        await self._storage.initialize()

        runtime.logger.info(
            "SecretsService initialized",
            src="service:secrets",
            agentId=str(runtime.agent_id),
        )

    async def stop(self) -> None:
        self._key_manager.clear()
        self._access_logs.clear()
        self._change_callbacks.clear()
        self._global_change_callbacks.clear()
        if self._runtime:
            self._runtime.logger.info("SecretsService stopped", src="service:secrets")

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    async def get(self, key: str, context: SecretContext) -> str | None:
        """Get a secret value."""
        if self._storage is None:
            return None
        self._log_access(key, "read", context, True)
        value = await self._storage.get(key, context)
        if value is None:
            self._log_access(key, "read", context, False, "Secret not found")
        return value

    async def set(
        self,
        key: str,
        value: str,
        context: SecretContext,
        config: dict[str, Any] | None = None,
    ) -> bool:
        """Set a secret value."""
        if self._storage is None:
            return False
        self._log_access(key, "write", context, True)
        previous = await self._storage.get(key, context)
        success = await self._storage.set(key, value, context, config)
        if success:
            await self._emit_change_event(
                SecretChangeEvent(
                    type="created" if previous is None else "updated",
                    key=key,
                    value=value,
                    previous_value=previous,
                    context=context,
                    timestamp=time.time(),
                )
            )
        return success

    async def delete(self, key: str, context: SecretContext) -> bool:
        """Delete a secret."""
        if self._storage is None:
            return False
        self._log_access(key, "delete", context, True)
        previous = await self._storage.get(key, context)
        success = await self._storage.delete(key, context)
        if success:
            await self._emit_change_event(
                SecretChangeEvent(
                    type="deleted",
                    key=key,
                    value=None,
                    previous_value=previous,
                    context=context,
                    timestamp=time.time(),
                )
            )
        return success

    async def exists(self, key: str, context: SecretContext) -> bool:
        if self._storage is None:
            return False
        return await self._storage.exists(key, context)

    async def list(self, context: SecretContext) -> SecretMetadata:
        if self._storage is None:
            return {}
        return await self._storage.list(context)

    async def get_config(self, key: str, context: SecretContext) -> SecretConfig | None:
        if self._storage is None:
            return None
        return await self._storage.get_config(key, context)

    async def update_config(self, key: str, context: SecretContext, config: dict[str, Any]) -> bool:
        if self._storage is None:
            return False
        return await self._storage.update_config(key, context, config)

    # ------------------------------------------------------------------
    # Convenience methods
    # ------------------------------------------------------------------

    async def get_global(self, key: str) -> str | None:
        ctx = SecretContext(level=SecretLevel.GLOBAL, agent_id=str(self.runtime.agent_id))
        return await self.get(key, ctx)

    async def set_global(self, key: str, value: str, config: dict[str, Any] | None = None) -> bool:
        ctx = SecretContext(level=SecretLevel.GLOBAL, agent_id=str(self.runtime.agent_id))
        return await self.set(key, value, ctx, config)

    async def get_world(self, key: str, world_id: str) -> str | None:
        ctx = SecretContext(
            level=SecretLevel.WORLD, world_id=world_id, agent_id=str(self.runtime.agent_id)
        )
        return await self.get(key, ctx)

    async def set_world(
        self, key: str, value: str, world_id: str, config: dict[str, Any] | None = None
    ) -> bool:
        ctx = SecretContext(
            level=SecretLevel.WORLD, world_id=world_id, agent_id=str(self.runtime.agent_id)
        )
        return await self.set(key, value, ctx, config)

    async def get_user(self, key: str, user_id: str) -> str | None:
        ctx = SecretContext(
            level=SecretLevel.USER,
            user_id=user_id,
            agent_id=str(self.runtime.agent_id),
            requester_id=user_id,
        )
        return await self.get(key, ctx)

    async def set_user(
        self, key: str, value: str, user_id: str, config: dict[str, Any] | None = None
    ) -> bool:
        ctx = SecretContext(
            level=SecretLevel.USER,
            user_id=user_id,
            agent_id=str(self.runtime.agent_id),
            requester_id=user_id,
        )
        return await self.set(key, value, ctx, config)

    # ------------------------------------------------------------------
    # Plugin requirements
    # ------------------------------------------------------------------

    async def check_plugin_requirements(
        self,
        plugin_id: str,
        requirements: dict[str, PluginSecretRequirement],
    ) -> PluginRequirementStatus:
        """Check which secrets are missing for a plugin."""
        missing_required: list[str] = []
        missing_optional: list[str] = []
        invalid: list[str] = []

        for key, req in requirements.items():
            value = await self.get_global(key)
            if value is None:
                if req.required:
                    missing_required.append(key)
                else:
                    missing_optional.append(key)
                continue

        ready = len(missing_required) == 0 and len(invalid) == 0
        return PluginRequirementStatus(
            plugin_id=plugin_id,
            ready=ready,
            missing_required=missing_required,
            missing_optional=missing_optional,
            invalid=invalid,
            message="All secrets available" if ready else f"Missing: {', '.join(missing_required)}",
        )

    async def get_missing_secrets(
        self, keys: builtins.list[str], level: str = "global"
    ) -> builtins.list[str]:
        """Get missing secrets for a set of keys."""
        missing: builtins.list[str] = []
        for key in keys:
            ctx = SecretContext(level=SecretLevel(level), agent_id=str(self.runtime.agent_id))
            if not await self.exists(key, ctx):
                missing.append(key)
        return missing

    # ------------------------------------------------------------------
    # Change notifications
    # ------------------------------------------------------------------

    def on_secret_changed(self, key: str, callback: SecretChangeCallback) -> Callable[[], None]:
        cbs = self._change_callbacks.setdefault(key, [])
        cbs.append(callback)

        def unsubscribe() -> None:
            callbacks = self._change_callbacks.get(key, [])
            if callback in callbacks:
                callbacks.remove(callback)
            if not callbacks:
                self._change_callbacks.pop(key, None)

        return unsubscribe

    def on_any_secret_changed(self, callback: SecretChangeCallback) -> Callable[[], None]:
        self._global_change_callbacks.append(callback)

        def unsubscribe() -> None:
            if callback in self._global_change_callbacks:
                self._global_change_callbacks.remove(callback)

        return unsubscribe

    async def _emit_change_event(self, event: SecretChangeEvent) -> None:
        for cb in self._change_callbacks.get(event.key, []):
            await cb(event.key, event.value, event.context)
        for cb in self._global_change_callbacks:
            await cb(event.key, event.value, event.context)

    # ------------------------------------------------------------------
    # Access logging
    # ------------------------------------------------------------------

    def _log_access(
        self,
        key: str,
        action: str,
        context: SecretContext,
        success: bool,
        error: str | None = None,
    ) -> None:
        if not self._secrets_config.enable_access_logging:
            return
        from .types import SecretPermissionType

        log = SecretAccessLog(
            secret_key=key,
            accessed_by=context.requester_id or context.user_id or context.agent_id,
            action=SecretPermissionType(action),
            timestamp=time.time(),
            context=context,
            success=success,
            error=error,
        )
        self._access_logs.append(log)
        if len(self._access_logs) > self._secrets_config.max_access_log_entries:
            self._access_logs = self._access_logs[-self._secrets_config.max_access_log_entries :]

    def get_access_logs(
        self,
        key: str | None = None,
        action: str | None = None,
        since: float | None = None,
    ) -> builtins.list[SecretAccessLog]:
        logs = builtins.list(self._access_logs)
        if key:
            logs = [l for l in logs if l.secret_key == key]
        if action:
            logs = [l for l in logs if l.action.value == action]
        if since:
            logs = [l for l in logs if l.timestamp >= since]
        return logs

    def clear_access_logs(self) -> None:
        self._access_logs.clear()

    # ------------------------------------------------------------------
    # Storage accessors
    # ------------------------------------------------------------------

    def get_global_storage(self) -> CharacterSettingsStorage | None:
        return self._global_storage

    def get_world_storage(self) -> WorldMetadataStorage | None:
        return self._world_storage

    def get_user_storage(self) -> ComponentSecretStorage | None:
        return self._user_storage

    def get_key_manager(self) -> KeyManager:
        return self._key_manager
