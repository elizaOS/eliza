"""
Secrets Service implementation.

Core service for multi-level secret management in elizaOS.
"""

import time
import logging
from typing import Optional, Dict, List, Callable, Awaitable

from elizaos.runtime import AgentRuntime
from elizaos.types import Service

from .types import (
    SecretConfig,
    SecretContext,
    SecretMetadata,
    SecretAccessLog,
    SecretLevel,
    SecretPermissionType,
    PluginSecretRequirement,
    PluginRequirementStatus,
    SecretsError,
)
from .crypto import KeyManager, is_encrypted_secret
from .storage import (
    SecretStorageInterface,
    MemorySecretStorage,
    CompositeSecretStorage,
)
from .validation import validate_secret


logger = logging.getLogger(__name__)


# Type alias for change callbacks
SecretChangeCallback = Callable[[str, Optional[str], SecretContext], Awaitable[None]]


class SecretsService(Service):
    """
    Secrets Service
    
    Unified service for managing secrets at all levels:
    - Global: Agent-wide secrets (API keys, tokens)
    - World: Server/channel-specific secrets
    - User: Per-user secrets
    """
    
    service_type = "SECRETS"
    
    def __init__(
        self,
        runtime: AgentRuntime,
        enable_encryption: bool = True,
        encryption_salt: Optional[str] = None,
        enable_access_logging: bool = True,
        max_access_log_entries: int = 1000,
    ):
        self.runtime = runtime
        self.enable_encryption = enable_encryption
        self.encryption_salt = encryption_salt
        self.enable_access_logging = enable_access_logging
        self.max_access_log_entries = max_access_log_entries
        
        # Initialize key manager
        self.key_manager = KeyManager()
        salt = encryption_salt or runtime.get_setting("ENCRYPTION_SALT") or "default-salt"
        self.key_manager.initialize_from_agent_id(runtime.agent_id, salt)
        
        # Initialize storage backends (using memory for now)
        self._global_storage = MemorySecretStorage()
        self._world_storage = MemorySecretStorage()
        self._user_storage = MemorySecretStorage()
        
        self._storage = CompositeSecretStorage(
            global_storage=self._global_storage,
            world_storage=self._world_storage,
            user_storage=self._user_storage,
        )
        
        # Access logs
        self._access_logs: List[SecretAccessLog] = []
        
        # Change callbacks
        self._key_callbacks: Dict[str, List[SecretChangeCallback]] = {}
        self._global_callbacks: List[SecretChangeCallback] = []
    
    async def start(self) -> None:
        """Start the service."""
        logger.info("[SecretsService] Starting")
        await self._storage.initialize()
        logger.info("[SecretsService] Started")
    
    async def stop(self) -> None:
        """Stop the service."""
        logger.info("[SecretsService] Stopping")
        self.key_manager.clear()
        self._access_logs.clear()
        self._key_callbacks.clear()
        self._global_callbacks.clear()
        logger.info("[SecretsService] Stopped")
    
    # ========================================================================
    # Core Secret Operations
    # ========================================================================
    
    async def get(self, key: str, context: SecretContext) -> Optional[str]:
        """Get a secret value."""
        self._log_access(key, SecretPermissionType.READ, context, True)
        
        value = await self._storage.get(key, context)
        
        if value is None:
            self._log_access(key, SecretPermissionType.READ, context, False, "Secret not found")
            return None
        
        # Decrypt if necessary
        if is_encrypted_secret(value):
            value = self.key_manager.decrypt(value)
        
        return value
    
    async def set(
        self,
        key: str,
        value: str,
        context: SecretContext,
        config: Optional[Dict] = None,
    ) -> bool:
        """Set a secret value."""
        self._log_access(key, SecretPermissionType.WRITE, context, True)
        
        config = config or {}
        
        # Validate if validation method specified
        validation_method = config.get("validationMethod")
        if validation_method and validation_method != "none":
            validation = await validate_secret(key, value, validation_method)
            if not validation.is_valid:
                self._log_access(
                    key, SecretPermissionType.WRITE, context, False,
                    f"Validation failed: {validation.error}"
                )
                raise SecretsError(
                    f"Validation failed for {key}: {validation.error}",
                    "VALIDATION_FAILED",
                    {"key": key, "error": validation.error},
                )
        
        # Get previous value for change event
        previous_value = await self._storage.get(key, context)
        if previous_value and is_encrypted_secret(previous_value):
            previous_value = self.key_manager.decrypt(previous_value)
        
        # Encrypt if enabled
        stored_value = value
        if self.enable_encryption and config.get("encrypted", True):
            stored_value = self.key_manager.encrypt(value).to_dict()
        
        success = await self._storage.set(key, stored_value, context, config)
        
        if success:
            # Emit change event
            event_type = "created" if previous_value is None else "updated"
            await self._emit_change_event(key, value, context)
            logger.debug(f"[SecretsService] {event_type} secret: {key}")
        else:
            self._log_access(key, SecretPermissionType.WRITE, context, False, "Storage operation failed")
        
        return success
    
    async def delete(self, key: str, context: SecretContext) -> bool:
        """Delete a secret."""
        self._log_access(key, SecretPermissionType.DELETE, context, True)
        
        success = await self._storage.delete(key, context)
        
        if success:
            await self._emit_change_event(key, None, context)
            logger.debug(f"[SecretsService] Deleted secret: {key}")
        else:
            self._log_access(key, SecretPermissionType.DELETE, context, False, "Secret not found")
        
        return success
    
    async def exists(self, key: str, context: SecretContext) -> bool:
        """Check if a secret exists."""
        return await self._storage.exists(key, context)
    
    async def list(self, context: SecretContext) -> SecretMetadata:
        """List secrets (metadata only, no values)."""
        return await self._storage.list(context)
    
    async def get_config(self, key: str, context: SecretContext) -> Optional[SecretConfig]:
        """Get secret configuration."""
        return await self._storage.get_config(key, context)
    
    async def update_config(
        self,
        key: str,
        context: SecretContext,
        config: Dict,
    ) -> bool:
        """Update secret configuration."""
        return await self._storage.update_config(key, context, config)
    
    # ========================================================================
    # Convenience Methods
    # ========================================================================
    
    async def get_global(self, key: str) -> Optional[str]:
        """Get a global secret (agent-level)."""
        context = SecretContext(level=SecretLevel.GLOBAL, agent_id=self.runtime.agent_id)
        return await self.get(key, context)
    
    async def set_global(self, key: str, value: str, config: Optional[Dict] = None) -> bool:
        """Set a global secret (agent-level)."""
        context = SecretContext(level=SecretLevel.GLOBAL, agent_id=self.runtime.agent_id)
        return await self.set(key, value, context, config)
    
    async def get_world(self, key: str, world_id: str) -> Optional[str]:
        """Get a world secret."""
        context = SecretContext(
            level=SecretLevel.WORLD,
            agent_id=self.runtime.agent_id,
            world_id=world_id,
        )
        return await self.get(key, context)
    
    async def set_world(
        self,
        key: str,
        value: str,
        world_id: str,
        config: Optional[Dict] = None,
    ) -> bool:
        """Set a world secret."""
        context = SecretContext(
            level=SecretLevel.WORLD,
            agent_id=self.runtime.agent_id,
            world_id=world_id,
        )
        return await self.set(key, value, context, config)
    
    async def get_user(self, key: str, user_id: str) -> Optional[str]:
        """Get a user secret."""
        context = SecretContext(
            level=SecretLevel.USER,
            agent_id=self.runtime.agent_id,
            user_id=user_id,
            requester_id=user_id,
        )
        return await self.get(key, context)
    
    async def set_user(
        self,
        key: str,
        value: str,
        user_id: str,
        config: Optional[Dict] = None,
    ) -> bool:
        """Set a user secret."""
        context = SecretContext(
            level=SecretLevel.USER,
            agent_id=self.runtime.agent_id,
            user_id=user_id,
            requester_id=user_id,
        )
        return await self.set(key, value, context, config)
    
    # ========================================================================
    # Plugin Requirements
    # ========================================================================
    
    async def check_plugin_requirements(
        self,
        plugin_id: str,
        requirements: Dict[str, PluginSecretRequirement],
    ) -> PluginRequirementStatus:
        """Check which secrets are missing for a plugin."""
        missing_required: List[str] = []
        missing_optional: List[str] = []
        invalid: List[str] = []
        
        for key, requirement in requirements.items():
            value = await self.get_global(key)
            
            if value is None:
                if requirement.required:
                    missing_required.append(key)
                else:
                    missing_optional.append(key)
                continue
            
            # Validate if validation method specified
            if requirement.validation_method and requirement.validation_method != "none":
                validation = await validate_secret(key, value, requirement.validation_method)
                if not validation.is_valid:
                    invalid.append(key)
        
        ready = len(missing_required) == 0 and len(invalid) == 0
        
        message = "Ready" if ready else f"Missing: {', '.join(missing_required)}"
        if invalid:
            message += f"; Invalid: {', '.join(invalid)}"
        
        return PluginRequirementStatus(
            plugin_id=plugin_id,
            ready=ready,
            missing_required=missing_required,
            missing_optional=missing_optional,
            invalid=invalid,
            message=message,
        )
    
    async def get_missing_secrets(
        self,
        keys: List[str],
        level: SecretLevel = SecretLevel.GLOBAL,
    ) -> List[str]:
        """Get missing secrets from a list."""
        missing = []
        
        for key in keys:
            context = SecretContext(level=level, agent_id=self.runtime.agent_id)
            exists = await self.exists(key, context)
            if not exists:
                missing.append(key)
        
        return missing
    
    # ========================================================================
    # Change Notifications
    # ========================================================================
    
    def on_secret_changed(
        self,
        key: str,
        callback: SecretChangeCallback,
    ) -> Callable[[], None]:
        """Register a callback for changes to a specific secret."""
        if key not in self._key_callbacks:
            self._key_callbacks[key] = []
        self._key_callbacks[key].append(callback)
        
        def unsubscribe():
            if key in self._key_callbacks:
                self._key_callbacks[key] = [
                    cb for cb in self._key_callbacks[key] if cb != callback
                ]
        
        return unsubscribe
    
    def on_any_secret_changed(self, callback: SecretChangeCallback) -> Callable[[], None]:
        """Register a callback for all secret changes."""
        self._global_callbacks.append(callback)
        
        def unsubscribe():
            self._global_callbacks[:] = [
                cb for cb in self._global_callbacks if cb != callback
            ]
        
        return unsubscribe
    
    async def _emit_change_event(
        self,
        key: str,
        value: Optional[str],
        context: SecretContext,
    ) -> None:
        """Emit change event to registered callbacks."""
        # Key-specific callbacks
        for callback in self._key_callbacks.get(key, []):
            await callback(key, value, context)
        
        # Global callbacks
        for callback in self._global_callbacks:
            await callback(key, value, context)
    
    # ========================================================================
    # Access Logging
    # ========================================================================
    
    def _log_access(
        self,
        key: str,
        action: SecretPermissionType,
        context: SecretContext,
        success: bool,
        error: Optional[str] = None,
    ) -> None:
        """Log a secret access attempt."""
        if not self.enable_access_logging:
            return
        
        log_entry = SecretAccessLog(
            secret_key=key,
            accessed_by=context.requester_id or context.user_id or context.agent_id,
            action=action,
            timestamp=int(time.time() * 1000),
            context=context,
            success=success,
            error=error,
        )
        
        self._access_logs.append(log_entry)
        
        # Trim if over limit
        if len(self._access_logs) > self.max_access_log_entries:
            self._access_logs = self._access_logs[-self.max_access_log_entries:]
        
        if not success and error:
            logger.debug(f"[SecretsService] Access denied: {action.value} {key} - {error}")
    
    def get_access_logs(
        self,
        key: Optional[str] = None,
        action: Optional[str] = None,
        since: Optional[int] = None,
    ) -> List[SecretAccessLog]:
        """Get access logs with optional filtering."""
        logs = list(self._access_logs)
        
        if key:
            logs = [l for l in logs if l.secret_key == key]
        
        if action:
            logs = [l for l in logs if l.action.value == action]
        
        if since:
            logs = [l for l in logs if l.timestamp >= since]
        
        return logs
    
    def clear_access_logs(self) -> None:
        """Clear access logs."""
        self._access_logs.clear()
    
    # ========================================================================
    # Storage Access
    # ========================================================================
    
    def get_global_storage(self) -> SecretStorageInterface:
        """Get the global storage backend."""
        return self._global_storage
    
    def get_world_storage(self) -> SecretStorageInterface:
        """Get the world storage backend."""
        return self._world_storage
    
    def get_user_storage(self) -> SecretStorageInterface:
        """Get the user storage backend."""
        return self._user_storage
    
    def get_key_manager(self) -> KeyManager:
        """Get the key manager."""
        return self.key_manager
