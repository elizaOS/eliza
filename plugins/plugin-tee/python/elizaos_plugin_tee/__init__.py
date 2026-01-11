"""
elizaOS TEE Plugin - Trusted Execution Environment integration.

This package provides TEE integration for secure key management and remote attestation.

Features:
- **Remote Attestation**: Prove the agent is running in a TEE
- **Key Derivation**: Securely derive Ed25519 (Solana) and ECDSA (EVM) keys
- **Vendor Support**: Extensible vendor system (currently supports Phala Network)

Configuration:
- TEE_MODE: LOCAL | DOCKER | PRODUCTION
- WALLET_SECRET_SALT: Secret for key derivation
- TEE_VENDOR: Vendor name (default: "phala")

Example:
    >>> from elizaos_plugin_tee import TEEService, TeeMode
    >>> service = await TEEService.start(tee_mode="LOCAL")
    >>> result = await service.derive_ed25519_keypair("salt", "solana", "agent-id")
    >>> print(result.public_key)
"""

from elizaos_plugin_tee.actions import (
    REMOTE_ATTESTATION_ACTION,
    handle_remote_attestation,
)
from elizaos_plugin_tee.errors import (
    AttestationError,
    ConfigError,
    InvalidModeError,
    InvalidVendorError,
    KeyDerivationError,
    NetworkError,
    TeeError,
)
from elizaos_plugin_tee.providers import (
    DeriveKeyProvider,
    PhalaDeriveKeyProvider,
    PhalaRemoteAttestationProvider,
    RemoteAttestationProvider,
    get_derived_keys,
    get_remote_attestation,
)
from elizaos_plugin_tee.services import TEEService
from elizaos_plugin_tee.types import (
    DeriveKeyAttestationData,
    DeriveKeyResult,
    EcdsaKeypairResult,
    Ed25519KeypairResult,
    RemoteAttestationMessage,
    RemoteAttestationQuote,
    TdxQuoteHashAlgorithm,
    TeeMode,
    TeeProviderResult,
    TeeServiceConfig,
    TeeType,
    TeeVendor,
    parse_tee_mode,
    parse_tee_vendor,
)
from elizaos_plugin_tee.utils import (
    bytes_to_hex,
    calculate_sha256,
    get_tee_endpoint,
    hex_to_bytes,
    upload_attestation_quote,
)
from elizaos_plugin_tee.vendors import (
    PhalaVendor,
    TeeVendorInterface,
    TeeVendorNames,
    get_vendor,
)

__version__ = "1.0.0"

# Plugin metadata
PLUGIN_NAME = "tee"
PLUGIN_DESCRIPTION = (
    "Trusted Execution Environment (TEE) integration plugin for "
    "secure key management and remote attestation"
)

__all__ = [
    # Version
    "__version__",
    # Plugin metadata
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
    # Types
    "TeeMode",
    "TeeVendor",
    "TeeType",
    "TdxQuoteHashAlgorithm",
    "RemoteAttestationQuote",
    "DeriveKeyAttestationData",
    "RemoteAttestationMessage",
    "DeriveKeyResult",
    "Ed25519KeypairResult",
    "EcdsaKeypairResult",
    "TeeServiceConfig",
    "TeeProviderResult",
    "parse_tee_mode",
    "parse_tee_vendor",
    # Errors
    "TeeError",
    "ConfigError",
    "AttestationError",
    "KeyDerivationError",
    "NetworkError",
    "InvalidModeError",
    "InvalidVendorError",
    # Providers
    "DeriveKeyProvider",
    "RemoteAttestationProvider",
    "PhalaDeriveKeyProvider",
    "PhalaRemoteAttestationProvider",
    "get_derived_keys",
    "get_remote_attestation",
    # Actions
    "REMOTE_ATTESTATION_ACTION",
    "handle_remote_attestation",
    # Services
    "TEEService",
    # Vendors
    "TeeVendorNames",
    "TeeVendorInterface",
    "PhalaVendor",
    "get_vendor",
    # Utils
    "hex_to_bytes",
    "bytes_to_hex",
    "calculate_sha256",
    "get_tee_endpoint",
    "upload_attestation_quote",
]


