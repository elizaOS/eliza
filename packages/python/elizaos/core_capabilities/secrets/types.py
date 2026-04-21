"""Secrets manager type definitions.

Ported from plugin-secrets-manager TypeScript types.  Defines data structures
for multi-level secret management with encryption, access control, and change
notification support.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SECRET_KEY_MAX_LENGTH = 256
SECRET_VALUE_MAX_LENGTH = 65536
SECRET_DESCRIPTION_MAX_LENGTH = 1024
SECRET_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")
MAX_ACCESS_LOG_ENTRIES = 1000


# ---------------------------------------------------------------------------
# Enums / literal types
# ---------------------------------------------------------------------------


class SecretLevel(StrEnum):
    GLOBAL = "global"
    WORLD = "world"
    USER = "user"


class SecretType(StrEnum):
    API_KEY = "api_key"
    PRIVATE_KEY = "private_key"
    PUBLIC_KEY = "public_key"
    URL = "url"
    CREDENTIAL = "credential"
    TOKEN = "token"
    CONFIG = "config"
    SECRET = "secret"


class SecretStatus(StrEnum):
    MISSING = "missing"
    GENERATING = "generating"
    VALIDATING = "validating"
    INVALID = "invalid"
    VALID = "valid"
    EXPIRED = "expired"
    REVOKED = "revoked"


class SecretPermissionType(StrEnum):
    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    SHARE = "share"


class ValidationStrategy(StrEnum):
    NONE = "none"
    API_KEY_OPENAI = "api_key:openai"
    API_KEY_ANTHROPIC = "api_key:anthropic"
    API_KEY_GROQ = "api_key:groq"
    API_KEY_GOOGLE = "api_key:google"
    URL_VALID = "url:valid"
    URL_REACHABLE = "url:reachable"
    CUSTOM = "custom"


class StorageBackend(StrEnum):
    MEMORY = "memory"
    CHARACTER = "character"
    WORLD = "world"
    COMPONENT = "component"


# ---------------------------------------------------------------------------
# Core secret data classes
# ---------------------------------------------------------------------------


@dataclass
class SecretConfig:
    """Configuration for a single secret/environment variable."""

    type: SecretType
    required: bool
    description: str
    can_generate: bool
    status: SecretStatus
    plugin: str
    level: SecretLevel
    validation_method: ValidationStrategy | None = None
    last_error: str | None = None
    attempts: int = 0
    created_at: float | None = None
    validated_at: float | None = None
    owner_id: str | None = None
    world_id: str | None = None
    encrypted: bool | None = None
    permissions: list[SecretPermission] | None = None
    shared_with: list[str] | None = None
    expires_at: float | None = None


@dataclass
class SecretPermission:
    """Permission grant for a secret."""

    entity_id: str
    permissions: list[SecretPermissionType]
    granted_by: str
    granted_at: float
    expires_at: float | None = None


@dataclass
class SecretContext:
    """Context for secret operations."""

    level: SecretLevel
    agent_id: str
    world_id: str | None = None
    user_id: str | None = None
    requester_id: str | None = None


@dataclass
class SecretAccessLog:
    """Access log entry for auditing."""

    secret_key: str
    accessed_by: str
    action: SecretPermissionType
    timestamp: float
    context: SecretContext
    success: bool
    error: str | None = None


@dataclass
class EncryptedSecret:
    """Encrypted secret container."""

    value: str
    """Encrypted value (base64)."""
    iv: str
    """Initialization vector (base64)."""
    auth_tag: str | None = None
    """Authentication tag for GCM mode (base64)."""
    algorithm: str = "aes-256-gcm"
    key_id: str = "default"


@dataclass
class KeyDerivationParams:
    """Key derivation parameters."""

    salt: str
    """Salt (base64)."""
    iterations: int = 100000
    algorithm: str = "pbkdf2-sha256"
    key_length: int = 32


@dataclass
class PluginSecretRequirement:
    """Secret requirement declared by a plugin."""

    description: str
    type: SecretType
    required: bool
    validation_method: ValidationStrategy | None = None
    env_var: str | None = None
    can_generate: bool = False
    generation_script: str | None = None


@dataclass
class PluginRequirementStatus:
    """Status of plugin requirements."""

    plugin_id: str
    ready: bool
    missing_required: list[str]
    missing_optional: list[str]
    invalid: list[str]
    message: str


@dataclass
class SecretsServiceConfig:
    """Secrets service configuration."""

    enable_encryption: bool = True
    encryption_salt: str | None = None
    enable_access_logging: bool = True
    max_access_log_entries: int = MAX_ACCESS_LOG_ENTRIES


@dataclass
class SecretChangeEvent:
    """Secret change event."""

    type: str  # "created" | "updated" | "deleted" | "expired"
    key: str
    value: str | None
    context: SecretContext
    timestamp: float
    previous_value: str | None = None


@dataclass
class ValidationResult:
    """Result of secret validation."""

    is_valid: bool
    validated_at: float
    error: str | None = None
    details: str | None = None


@dataclass
class PendingPluginActivation:
    """Plugin activation registration."""

    plugin_id: str
    required_secrets: list[str]
    callback: Callable[[], Awaitable[None]]
    registered_at: float


@dataclass
class PluginActivatorConfig:
    """Plugin activator service configuration."""

    enable_auto_activation: bool = True
    polling_interval_ms: int = 5000
    max_wait_ms: int = 0  # 0 = wait forever


# Also define SecretMetadata as a type alias used by storage/service.
SecretMetadata = dict[str, SecretConfig]

# Callback / function types
SecretChangeCallback = Callable[[str, str | None, SecretContext], Awaitable[None]]
CustomValidator = Callable[[str, str], Awaitable[ValidationResult]]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SecretsError(Exception):
    """Base exception for secrets operations."""

    def __init__(
        self,
        message: str,
        code: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


class PermissionDeniedError(SecretsError):
    def __init__(self, key: str, action: str, context: SecretContext) -> None:
        super().__init__(
            f"Permission denied: cannot {action} secret '{key}' at level '{context.level.value}'",
            "PERMISSION_DENIED",
            {"key": key, "action": action},
        )


class SecretNotFoundError(SecretsError):
    def __init__(self, key: str, context: SecretContext) -> None:
        super().__init__(
            f"Secret '{key}' not found at level '{context.level.value}'",
            "SECRET_NOT_FOUND",
            {"key": key},
        )


class EncryptionError(SecretsError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message, "ENCRYPTION_ERROR", details)
