"""
Storage implementations for secrets.

Provides in-memory storage and interfaces for elizaOS-native storage.
"""

from abc import ABC, abstractmethod
from typing import Optional, Dict
import time

from .types import (
    SecretConfig,
    SecretContext,
    SecretMetadata,
    SecretLevel,
    SecretType,
    SecretStatus,
    StorageBackend,
    StoredSecret,
)


class SecretStorageInterface(ABC):
    """Abstract interface for secret storage backends."""
    
    @property
    @abstractmethod
    def storage_type(self) -> StorageBackend:
        """Get the storage backend type."""
        pass
    
    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the storage backend."""
        pass
    
    @abstractmethod
    async def exists(self, key: str, context: SecretContext) -> bool:
        """Check if a secret exists."""
        pass
    
    @abstractmethod
    async def get(self, key: str, context: SecretContext) -> Optional[str]:
        """Get a secret value."""
        pass
    
    @abstractmethod
    async def set(
        self,
        key: str,
        value: str,
        context: SecretContext,
        config: Optional[Dict] = None,
    ) -> bool:
        """Set a secret value."""
        pass
    
    @abstractmethod
    async def delete(self, key: str, context: SecretContext) -> bool:
        """Delete a secret."""
        pass
    
    @abstractmethod
    async def list(self, context: SecretContext) -> SecretMetadata:
        """List all secrets in a context."""
        pass
    
    @abstractmethod
    async def get_config(self, key: str, context: SecretContext) -> Optional[SecretConfig]:
        """Get secret configuration without value."""
        pass
    
    @abstractmethod
    async def update_config(
        self,
        key: str,
        context: SecretContext,
        config: Dict,
    ) -> bool:
        """Update secret configuration."""
        pass
    
    def _create_default_config(
        self,
        key: str,
        context: SecretContext,
        partial: Optional[Dict] = None,
    ) -> SecretConfig:
        """Create a default secret configuration."""
        partial = partial or {}
        
        return SecretConfig(
            type=SecretType(partial.get("type", "secret")),
            required=partial.get("required", False),
            description=partial.get("description", f"Secret: {key}"),
            can_generate=partial.get("canGenerate", False),
            validation_method=partial.get("validationMethod"),
            status=SecretStatus(partial.get("status", "valid")),
            last_error=partial.get("lastError"),
            attempts=partial.get("attempts", 0),
            created_at=partial.get("createdAt") or int(time.time() * 1000),
            validated_at=partial.get("validatedAt") or int(time.time() * 1000),
            plugin=partial.get("plugin", context.level.value),
            level=context.level,
            owner_id=context.user_id,
            world_id=context.world_id,
            encrypted=partial.get("encrypted", True),
            permissions=[],
            shared_with=[],
            expires_at=partial.get("expiresAt"),
        )


class MemorySecretStorage(SecretStorageInterface):
    """
    In-memory storage backend for secrets.
    
    Useful for testing and ephemeral environments.
    """
    
    def __init__(self):
        self._store: Dict[str, StoredSecret] = {}
    
    @property
    def storage_type(self) -> StorageBackend:
        return StorageBackend.MEMORY
    
    async def initialize(self) -> None:
        """Initialize - nothing to do for memory storage."""
        pass
    
    def _generate_storage_key(self, key: str, context: SecretContext) -> str:
        """Generate a unique storage key from the secret key and context."""
        if context.level == SecretLevel.GLOBAL:
            return f"global:{context.agent_id}:{key}"
        elif context.level == SecretLevel.WORLD:
            return f"world:{context.world_id}:{key}"
        elif context.level == SecretLevel.USER:
            return f"user:{context.user_id}:{key}"
        else:
            return f"unknown:{key}"
    
    def _get_context_prefix(self, context: SecretContext) -> str:
        """Get the storage key prefix for a context level."""
        if context.level == SecretLevel.GLOBAL:
            return f"global:{context.agent_id}:"
        elif context.level == SecretLevel.WORLD:
            return f"world:{context.world_id}:"
        elif context.level == SecretLevel.USER:
            return f"user:{context.user_id}:"
        else:
            return ""
    
    async def exists(self, key: str, context: SecretContext) -> bool:
        storage_key = self._generate_storage_key(key, context)
        return storage_key in self._store
    
    async def get(self, key: str, context: SecretContext) -> Optional[str]:
        storage_key = self._generate_storage_key(key, context)
        entry = self._store.get(storage_key)
        
        if not entry:
            return None
        
        # Check expiration
        if entry.config.expires_at and entry.config.expires_at < int(time.time() * 1000):
            del self._store[storage_key]
            return None
        
        # Return value (may be encrypted - caller handles decryption)
        if isinstance(entry.value, str):
            return entry.value
        
        # Return the encrypted object for caller to decrypt
        return entry.value
    
    async def set(
        self,
        key: str,
        value: str,
        context: SecretContext,
        config: Optional[Dict] = None,
    ) -> bool:
        storage_key = self._generate_storage_key(key, context)
        existing = self._store.get(storage_key)
        existing_config = existing.config if existing else None
        
        # Merge configs
        merged_config = {}
        if existing_config:
            merged_config = existing_config.to_dict()
        if config:
            merged_config.update(config)
        
        full_config = self._create_default_config(key, context, merged_config)
        
        self._store[storage_key] = StoredSecret(
            value=value,
            config=full_config,
        )
        
        return True
    
    async def delete(self, key: str, context: SecretContext) -> bool:
        storage_key = self._generate_storage_key(key, context)
        if storage_key in self._store:
            del self._store[storage_key]
            return True
        return False
    
    async def list(self, context: SecretContext) -> SecretMetadata:
        prefix = self._get_context_prefix(context)
        metadata: SecretMetadata = {}
        
        now = int(time.time() * 1000)
        keys_to_delete = []
        
        for storage_key, entry in self._store.items():
            if not storage_key.startswith(prefix):
                continue
            
            # Check expiration
            if entry.config.expires_at and entry.config.expires_at < now:
                keys_to_delete.append(storage_key)
                continue
            
            # Extract original key
            original_key = storage_key[len(prefix):]
            metadata[original_key] = entry.config
        
        # Clean up expired entries
        for key in keys_to_delete:
            del self._store[key]
        
        return metadata
    
    async def get_config(self, key: str, context: SecretContext) -> Optional[SecretConfig]:
        storage_key = self._generate_storage_key(key, context)
        entry = self._store.get(storage_key)
        
        if not entry:
            return None
        
        return entry.config
    
    async def update_config(
        self,
        key: str,
        context: SecretContext,
        config: Dict,
    ) -> bool:
        storage_key = self._generate_storage_key(key, context)
        entry = self._store.get(storage_key)
        
        if not entry:
            return False
        
        # Update config fields
        for field, value in config.items():
            if hasattr(entry.config, field):
                setattr(entry.config, field, value)
        
        return True
    
    def clear(self) -> None:
        """Clear all stored secrets (for testing)."""
        self._store.clear()
    
    def size(self) -> int:
        """Get the number of stored secrets."""
        return len(self._store)


class CompositeSecretStorage(SecretStorageInterface):
    """
    Composite storage that delegates to different backends based on context.
    """
    
    def __init__(
        self,
        global_storage: SecretStorageInterface,
        world_storage: SecretStorageInterface,
        user_storage: SecretStorageInterface,
    ):
        self._global_storage = global_storage
        self._world_storage = world_storage
        self._user_storage = user_storage
    
    @property
    def storage_type(self) -> StorageBackend:
        return StorageBackend.MEMORY
    
    async def initialize(self) -> None:
        await self._global_storage.initialize()
        await self._world_storage.initialize()
        await self._user_storage.initialize()
    
    def _get_storage_for_context(self, context: SecretContext) -> SecretStorageInterface:
        if context.level == SecretLevel.GLOBAL:
            return self._global_storage
        elif context.level == SecretLevel.WORLD:
            return self._world_storage
        elif context.level == SecretLevel.USER:
            return self._user_storage
        else:
            return self._global_storage
    
    async def exists(self, key: str, context: SecretContext) -> bool:
        storage = self._get_storage_for_context(context)
        return await storage.exists(key, context)
    
    async def get(self, key: str, context: SecretContext) -> Optional[str]:
        storage = self._get_storage_for_context(context)
        return await storage.get(key, context)
    
    async def set(
        self,
        key: str,
        value: str,
        context: SecretContext,
        config: Optional[Dict] = None,
    ) -> bool:
        storage = self._get_storage_for_context(context)
        return await storage.set(key, value, context, config)
    
    async def delete(self, key: str, context: SecretContext) -> bool:
        storage = self._get_storage_for_context(context)
        return await storage.delete(key, context)
    
    async def list(self, context: SecretContext) -> SecretMetadata:
        storage = self._get_storage_for_context(context)
        return await storage.list(context)
    
    async def get_config(self, key: str, context: SecretContext) -> Optional[SecretConfig]:
        storage = self._get_storage_for_context(context)
        return await storage.get_config(key, context)
    
    async def update_config(
        self,
        key: str,
        context: SecretContext,
        config: Dict,
    ) -> bool:
        storage = self._get_storage_for_context(context)
        return await storage.update_config(key, context, config)
