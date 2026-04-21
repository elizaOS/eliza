"""Secret storage backends.

Provides in-memory implementations for the three storage levels (global,
world, user).  In a full deployment these would be backed by character
settings, world metadata, and component stores respectively.
"""

from __future__ import annotations

import time
from typing import Any

from .crypto import KeyManager
from .types import (
    EncryptedSecret,
    SecretConfig,
    SecretContext,
    SecretLevel,
    SecretMetadata,
    SecretStatus,
    SecretType,
    StorageBackend,
)

# ---------------------------------------------------------------------------
# Base storage interface
# ---------------------------------------------------------------------------


class BaseSecretStorage:
    """Abstract base for secret storage backends."""

    storage_type: StorageBackend = StorageBackend.MEMORY

    def __init__(self, key_manager: KeyManager | None = None) -> None:
        self._key_manager = key_manager
        self._store: dict[str, _StoredEntry] = {}

    async def initialize(self) -> None:
        """Initialize the storage backend."""

    async def exists(self, key: str, context: SecretContext) -> bool:
        scope_key = self._scope_key(key, context)
        return scope_key in self._store

    async def get(self, key: str, context: SecretContext) -> str | None:
        scope_key = self._scope_key(key, context)
        entry = self._store.get(scope_key)
        if entry is None:
            return None
        # Decrypt if needed
        if isinstance(entry.value, EncryptedSecret) and self._key_manager:
            return self._key_manager.decrypt(entry.value)
        if isinstance(entry.value, str):
            return entry.value
        return None

    async def set(
        self,
        key: str,
        value: str,
        context: SecretContext,
        config: dict[str, Any] | None = None,
    ) -> bool:
        scope_key = self._scope_key(key, context)
        # Encrypt if key manager is available
        stored_value: str | EncryptedSecret = value
        if self._key_manager:
            try:
                stored_value = self._key_manager.encrypt(value)
            except Exception:
                stored_value = value  # Fallback to plaintext

        self._store[scope_key] = _StoredEntry(
            value=stored_value,
            config=SecretConfig(
                type=SecretType.SECRET,
                required=False,
                description="",
                can_generate=False,
                status=SecretStatus.VALID,
                plugin="",
                level=context.level,
                encrypted=isinstance(stored_value, EncryptedSecret),
                created_at=time.time(),
            ),
        )
        return True

    async def delete(self, key: str, context: SecretContext) -> bool:
        scope_key = self._scope_key(key, context)
        if scope_key in self._store:
            del self._store[scope_key]
            return True
        return False

    async def list(self, context: SecretContext) -> SecretMetadata:
        prefix = self._scope_prefix(context)
        result: SecretMetadata = {}
        for scope_key, entry in self._store.items():
            if scope_key.startswith(prefix):
                bare_key = scope_key[len(prefix) :]
                result[bare_key] = entry.config
        return result

    async def get_config(self, key: str, context: SecretContext) -> SecretConfig | None:
        scope_key = self._scope_key(key, context)
        entry = self._store.get(scope_key)
        return entry.config if entry else None

    async def update_config(self, key: str, context: SecretContext, config: dict[str, Any]) -> bool:
        scope_key = self._scope_key(key, context)
        entry = self._store.get(scope_key)
        if entry is None:
            return False
        for k, v in config.items():
            if hasattr(entry.config, k):
                setattr(entry.config, k, v)
        return True

    def _scope_key(self, key: str, context: SecretContext) -> str:
        return f"{self._scope_prefix(context)}{key}"

    def _scope_prefix(self, context: SecretContext) -> str:
        return f"{context.level.value}:{context.agent_id}:"


class _StoredEntry:
    __slots__ = ("value", "config")

    def __init__(self, value: str | EncryptedSecret, config: SecretConfig) -> None:
        self.value = value
        self.config = config


# ---------------------------------------------------------------------------
# Concrete storage classes
# ---------------------------------------------------------------------------


class CharacterSettingsStorage(BaseSecretStorage):
    """Global (agent-wide) secret storage backed by character settings."""

    storage_type = StorageBackend.CHARACTER

    def _scope_prefix(self, context: SecretContext) -> str:
        return f"global:{context.agent_id}:"


class WorldMetadataStorage(BaseSecretStorage):
    """World-level secret storage backed by world metadata."""

    storage_type = StorageBackend.WORLD

    def _scope_prefix(self, context: SecretContext) -> str:
        return f"world:{context.agent_id}:{context.world_id or 'default'}:"


class ComponentSecretStorage(BaseSecretStorage):
    """User-level secret storage backed by components."""

    storage_type = StorageBackend.COMPONENT

    def _scope_prefix(self, context: SecretContext) -> str:
        return f"user:{context.agent_id}:{context.user_id or 'default'}:"


class CompositeSecretStorage:
    """Routes operations to the correct storage backend based on secret level."""

    def __init__(
        self,
        global_storage: CharacterSettingsStorage,
        world_storage: WorldMetadataStorage,
        user_storage: ComponentSecretStorage,
    ) -> None:
        self._global = global_storage
        self._world = world_storage
        self._user = user_storage

    async def initialize(self) -> None:
        await self._global.initialize()
        await self._world.initialize()
        await self._user.initialize()

    def _backend(self, context: SecretContext) -> BaseSecretStorage:
        if context.level == SecretLevel.WORLD:
            return self._world
        if context.level == SecretLevel.USER:
            return self._user
        return self._global

    async def exists(self, key: str, context: SecretContext) -> bool:
        return await self._backend(context).exists(key, context)

    async def get(self, key: str, context: SecretContext) -> str | None:
        return await self._backend(context).get(key, context)

    async def set(
        self,
        key: str,
        value: str,
        context: SecretContext,
        config: dict[str, Any] | None = None,
    ) -> bool:
        return await self._backend(context).set(key, value, context, config)

    async def delete(self, key: str, context: SecretContext) -> bool:
        return await self._backend(context).delete(key, context)

    async def list(self, context: SecretContext) -> SecretMetadata:
        return await self._backend(context).list(context)

    async def get_config(self, key: str, context: SecretContext) -> SecretConfig | None:
        return await self._backend(context).get_config(key, context)

    async def update_config(self, key: str, context: SecretContext, config: dict[str, Any]) -> bool:
        return await self._backend(context).update_config(key, context, config)
