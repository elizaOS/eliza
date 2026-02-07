"""
Type definitions for the Secrets Manager plugin.

These types mirror the TypeScript definitions to ensure
cross-language compatibility.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Dict, List, Union, Any
from datetime import datetime


# ============================================================================
# Enums
# ============================================================================

class SecretLevel(str, Enum):
    """Storage level for secrets."""
    GLOBAL = "global"
    WORLD = "world"
    USER = "user"


class SecretType(str, Enum):
    """Type classification for secrets."""
    API_KEY = "api_key"
    PRIVATE_KEY = "private_key"
    PUBLIC_KEY = "public_key"
    URL = "url"
    CREDENTIAL = "credential"
    CONFIG = "config"
    SECRET = "secret"


class SecretStatus(str, Enum):
    """Current status of a secret."""
    MISSING = "missing"
    GENERATING = "generating"
    VALIDATING = "validating"
    INVALID = "invalid"
    VALID = "valid"
    EXPIRED = "expired"
    REVOKED = "revoked"


class SecretPermissionType(str, Enum):
    """Types of permissions for secret access."""
    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    SHARE = "share"


class ValidationStrategy(str, Enum):
    """Validation strategies for secrets."""
    NONE = "none"
    API_KEY_OPENAI = "api_key:openai"
    API_KEY_ANTHROPIC = "api_key:anthropic"
    API_KEY_GROQ = "api_key:groq"
    API_KEY_GOOGLE = "api_key:google"
    API_KEY_MISTRAL = "api_key:mistral"
    API_KEY_COHERE = "api_key:cohere"
    URL_VALID = "url:valid"
    URL_REACHABLE = "url:reachable"
    CUSTOM = "custom"


class StorageBackend(str, Enum):
    """Storage backend types."""
    MEMORY = "memory"
    CHARACTER = "character"
    WORLD = "world"
    COMPONENT = "component"


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class SecretPermission:
    """Permission grant for a secret."""
    entity_id: str
    permissions: List[SecretPermissionType]
    granted_by: str
    granted_at: int
    expires_at: Optional[int] = None


@dataclass
class SecretConfig:
    """Configuration for a single secret."""
    type: SecretType
    required: bool
    description: str
    can_generate: bool
    status: SecretStatus
    plugin: str
    level: SecretLevel
    validation_method: Optional[str] = None
    last_error: Optional[str] = None
    attempts: int = 0
    created_at: Optional[int] = None
    validated_at: Optional[int] = None
    owner_id: Optional[str] = None
    world_id: Optional[str] = None
    encrypted: bool = True
    permissions: List[SecretPermission] = field(default_factory=list)
    shared_with: List[str] = field(default_factory=list)
    expires_at: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": self.type.value if isinstance(self.type, SecretType) else self.type,
            "required": self.required,
            "description": self.description,
            "canGenerate": self.can_generate,
            "status": self.status.value if isinstance(self.status, SecretStatus) else self.status,
            "plugin": self.plugin,
            "level": self.level.value if isinstance(self.level, SecretLevel) else self.level,
            "validationMethod": self.validation_method,
            "lastError": self.last_error,
            "attempts": self.attempts,
            "createdAt": self.created_at,
            "validatedAt": self.validated_at,
            "ownerId": self.owner_id,
            "worldId": self.world_id,
            "encrypted": self.encrypted,
            "expiresAt": self.expires_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SecretConfig":
        """Create from dictionary."""
        return cls(
            type=SecretType(data.get("type", "secret")),
            required=data.get("required", False),
            description=data.get("description", ""),
            can_generate=data.get("canGenerate", False),
            status=SecretStatus(data.get("status", "valid")),
            plugin=data.get("plugin", ""),
            level=SecretLevel(data.get("level", "global")),
            validation_method=data.get("validationMethod"),
            last_error=data.get("lastError"),
            attempts=data.get("attempts", 0),
            created_at=data.get("createdAt"),
            validated_at=data.get("validatedAt"),
            owner_id=data.get("ownerId"),
            world_id=data.get("worldId"),
            encrypted=data.get("encrypted", True),
            expires_at=data.get("expiresAt"),
        )


@dataclass
class SecretContext:
    """Context for secret operations."""
    level: SecretLevel
    agent_id: str
    world_id: Optional[str] = None
    user_id: Optional[str] = None
    requester_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "level": self.level.value if isinstance(self.level, SecretLevel) else self.level,
            "agentId": self.agent_id,
            "worldId": self.world_id,
            "userId": self.user_id,
            "requesterId": self.requester_id,
        }


@dataclass
class EncryptedSecret:
    """Encrypted secret container."""
    value: str  # base64 encrypted value
    iv: str  # base64 initialization vector
    algorithm: str  # e.g., "aes-256-gcm"
    key_id: str
    auth_tag: Optional[str] = None  # base64 auth tag for GCM

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = {
            "value": self.value,
            "iv": self.iv,
            "algorithm": self.algorithm,
            "keyId": self.key_id,
        }
        if self.auth_tag:
            result["authTag"] = self.auth_tag
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EncryptedSecret":
        """Create from dictionary."""
        return cls(
            value=data["value"],
            iv=data["iv"],
            algorithm=data["algorithm"],
            key_id=data.get("keyId", "default"),
            auth_tag=data.get("authTag"),
        )


@dataclass
class StoredSecret:
    """Stored secret with value and config."""
    value: Union[str, EncryptedSecret]
    config: SecretConfig

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "value": self.value.to_dict() if isinstance(self.value, EncryptedSecret) else self.value,
            "config": self.config.to_dict(),
        }


@dataclass
class SecretAccessLog:
    """Access log entry for auditing."""
    secret_key: str
    accessed_by: str
    action: SecretPermissionType
    timestamp: int
    context: SecretContext
    success: bool
    error: Optional[str] = None


# Type alias for secret metadata collection
SecretMetadata = Dict[str, SecretConfig]


# ============================================================================
# Plugin Activation Types
# ============================================================================

@dataclass
class PluginSecretRequirement:
    """Secret requirement declared by a plugin."""
    description: str
    type: SecretType
    required: bool
    validation_method: Optional[str] = None
    env_var: Optional[str] = None
    can_generate: bool = False
    generation_script: Optional[str] = None


@dataclass
class PluginRequirementStatus:
    """Status of plugin requirements."""
    plugin_id: str
    ready: bool
    missing_required: List[str]
    missing_optional: List[str]
    invalid: List[str]
    message: str


# ============================================================================
# Validation Types
# ============================================================================

@dataclass
class ValidationResult:
    """Result of secret validation."""
    is_valid: bool
    validated_at: int
    error: Optional[str] = None
    details: Optional[str] = None


# ============================================================================
# Exceptions
# ============================================================================

class SecretsError(Exception):
    """Base exception for secrets errors."""
    def __init__(self, message: str, code: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class PermissionDeniedError(SecretsError):
    """Permission denied for secret access."""
    def __init__(self, key: str, action: SecretPermissionType, context: SecretContext):
        super().__init__(
            f"Permission denied: cannot {action.value} secret '{key}' at level '{context.level.value}'",
            "PERMISSION_DENIED",
            {"key": key, "action": action.value, "context": context.to_dict()},
        )


class SecretNotFoundError(SecretsError):
    """Secret not found."""
    def __init__(self, key: str, context: SecretContext):
        super().__init__(
            f"Secret '{key}' not found at level '{context.level.value}'",
            "SECRET_NOT_FOUND",
            {"key": key, "context": context.to_dict()},
        )


class ValidationError(SecretsError):
    """Validation failed for secret."""
    def __init__(self, key: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            f"Validation failed for secret '{key}': {message}",
            "VALIDATION_FAILED",
            {"key": key, **(details or {})},
        )


class EncryptionError(SecretsError):
    """Encryption/decryption error."""
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message, "ENCRYPTION_ERROR", details)


class StorageError(SecretsError):
    """Storage operation error."""
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message, "STORAGE_ERROR", details)
