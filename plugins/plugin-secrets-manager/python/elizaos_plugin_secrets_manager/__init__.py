"""
elizaOS Secrets Manager Plugin

Multi-level secrets management with encryption, validation, and dynamic plugin activation.

Usage:
    from elizaos_plugin_secrets_manager import secrets_manager_plugin

    # Register with runtime
    runtime.register_plugin(secrets_manager_plugin)
"""

from .types import (
    SecretLevel,
    SecretType,
    SecretStatus,
    StorageBackend,
    SecretPermissionType,
    SecretConfig,
    SecretContext,
    SecretMetadata,
    SecretAccessLog,
    PluginSecretRequirement,
    PluginRequirementStatus,
    EncryptedSecret,
    SecretsError,
)
from .crypto import (
    KeyManager,
    generate_salt,
    generate_key,
    derive_key_pbkdf2,
    derive_key_from_agent_id,
    encrypt,
    decrypt,
    is_encrypted_secret,
)
from .storage import (
    SecretStorageInterface,
    MemorySecretStorage,
    CompositeSecretStorage,
)
from .validation import (
    ValidationResult,
    validate_secret,
    register_validator,
    get_validator,
    infer_validation_strategy,
)
from .service import SecretsService
from .activator import PluginActivatorService, PluginWithSecrets
from .actions import set_secret_action, manage_secret_action
from .providers import secrets_status_provider, secrets_info_provider
from .plugin import secrets_manager_plugin


__all__ = [
    # Plugin
    "secrets_manager_plugin",
    
    # Types
    "SecretLevel",
    "SecretType",
    "SecretStatus",
    "StorageBackend",
    "SecretPermissionType",
    "SecretConfig",
    "SecretContext",
    "SecretMetadata",
    "SecretAccessLog",
    "PluginSecretRequirement",
    "PluginRequirementStatus",
    "EncryptedSecret",
    "SecretsError",
    
    # Crypto
    "KeyManager",
    "generate_salt",
    "generate_key",
    "derive_key_pbkdf2",
    "derive_key_from_agent_id",
    "encrypt",
    "decrypt",
    "is_encrypted_secret",
    
    # Storage
    "SecretStorageInterface",
    "MemorySecretStorage",
    "CompositeSecretStorage",
    
    # Validation
    "ValidationResult",
    "validate_secret",
    "register_validator",
    "get_validator",
    "infer_validation_strategy",
    
    # Services
    "SecretsService",
    "PluginActivatorService",
    "PluginWithSecrets",
    
    # Actions
    "set_secret_action",
    "manage_secret_action",
    
    # Providers
    "secrets_status_provider",
    "secrets_info_provider",
]
