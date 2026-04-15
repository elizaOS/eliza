"""Secrets sub-module.

Multi-level secret management with encryption, access control, and change
notification support.  Ported from plugin-secrets-manager TypeScript.
"""

from .actions import manage_secret_action, request_secret_action, secrets_actions, set_secret_action
from .crypto import (
    KeyManager,
    decrypt,
    decrypt_gcm,
    derive_key_from_agent_id,
    derive_key_pbkdf2,
    encrypt,
    encrypt_gcm,
    generate_key,
    generate_salt,
    generate_secure_token,
    hash_value,
    is_encrypted_secret,
    secure_compare,
)
from .onboarding import (
    ONBOARDING_SERVICE_TYPE,
    OnboardingConfig,
    OnboardingService,
    OnboardingSetting,
    missing_secrets_provider,
    onboarding_settings_provider,
    update_settings_action,
)
from .plugin_activator import (
    PLUGIN_ACTIVATOR_SERVICE_TYPE,
    PluginActivatorConfig,
    PluginActivatorService,
)
from .providers import secrets_providers, secrets_status_provider
from .service import SecretsService
from .storage import (
    CharacterSettingsStorage,
    ComponentSecretStorage,
    CompositeSecretStorage,
    WorldMetadataStorage,
)
from .types import (
    CustomValidator,
    EncryptedSecret,
    EncryptionError,
    KeyDerivationParams,
    PendingPluginActivation,
    PermissionDeniedError,
    PluginRequirementStatus,
    PluginSecretRequirement,
    SecretAccessLog,
    SecretChangeCallback,
    SecretChangeEvent,
    SecretConfig,
    SecretContext,
    SecretLevel,
    SecretMetadata,
    SecretNotFoundError,
    SecretPermission,
    SecretPermissionType,
    SecretsError,
    SecretsServiceConfig,
    SecretStatus,
    SecretType,
    StorageBackend,
    ValidationResult,
    ValidationStrategy,
)
from .validation import (
    VALIDATION_STRATEGIES,
    get_validator,
    infer_validation_strategy,
    register_validator,
    unregister_validator,
    validate_secret,
)

__all__ = [
    # Service
    "SecretsService",
    # Actions
    "secrets_actions",
    "set_secret_action",
    "manage_secret_action",
    "request_secret_action",
    "update_settings_action",
    # Providers
    "secrets_providers",
    "secrets_status_provider",
    "onboarding_settings_provider",
    "missing_secrets_provider",
    # Onboarding
    "OnboardingService",
    "ONBOARDING_SERVICE_TYPE",
    "OnboardingConfig",
    "OnboardingSetting",
    # Plugin Activator
    "PluginActivatorService",
    "PLUGIN_ACTIVATOR_SERVICE_TYPE",
    "PluginActivatorConfig",
    # Validation
    "VALIDATION_STRATEGIES",
    "validate_secret",
    "get_validator",
    "register_validator",
    "unregister_validator",
    "infer_validation_strategy",
    # Crypto
    "KeyManager",
    "encrypt",
    "encrypt_gcm",
    "decrypt",
    "decrypt_gcm",
    "derive_key_pbkdf2",
    "derive_key_from_agent_id",
    "generate_key",
    "generate_salt",
    "generate_secure_token",
    "hash_value",
    "is_encrypted_secret",
    "secure_compare",
    # Storage
    "CharacterSettingsStorage",
    "WorldMetadataStorage",
    "ComponentSecretStorage",
    "CompositeSecretStorage",
    # Types
    "SecretLevel",
    "SecretType",
    "SecretStatus",
    "SecretPermissionType",
    "ValidationStrategy",
    "StorageBackend",
    "SecretConfig",
    "SecretPermission",
    "SecretContext",
    "SecretAccessLog",
    "EncryptedSecret",
    "KeyDerivationParams",
    "PluginSecretRequirement",
    "PluginRequirementStatus",
    "PendingPluginActivation",
    "SecretsServiceConfig",
    "SecretChangeEvent",
    "SecretChangeCallback",
    "CustomValidator",
    "SecretMetadata",
    "ValidationResult",
    "SecretsError",
    "PermissionDeniedError",
    "SecretNotFoundError",
    "EncryptionError",
]
