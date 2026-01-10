"""
Core types for the TEE (Trusted Execution Environment) plugin.

All types use Pydantic for strong validation and type safety.
No Optional types for required fields - fail fast on missing data.
"""

from __future__ import annotations

from enum import Enum
from typing import TypeAlias

from pydantic import BaseModel, Field


class TeeMode(str, Enum):
    """TEE operation mode."""

    LOCAL = "LOCAL"
    """Local development with simulator at localhost:8090."""

    DOCKER = "DOCKER"
    """Docker development with simulator at host.docker.internal:8090."""

    PRODUCTION = "PRODUCTION"
    """Production mode without simulator."""


class TeeVendor(str, Enum):
    """TEE vendor names."""

    PHALA = "phala"
    """Phala Network TEE."""


class TeeType(str, Enum):
    """TEE type (SGX, TDX, etc.)."""

    SGX_GRAMINE = "sgx_gramine"
    """Intel SGX with Gramine."""

    TDX_DSTACK = "tdx_dstack"
    """Intel TDX with DStack."""


class TdxQuoteHashAlgorithm(str, Enum):
    """Hash algorithms supported for TDX quotes."""

    SHA256 = "sha256"
    SHA384 = "sha384"
    SHA512 = "sha512"
    RAW = "raw"


class RemoteAttestationQuote(BaseModel):
    """Remote attestation quote."""

    quote: str
    """The attestation quote (hex-encoded)."""

    timestamp: int
    """Timestamp when the quote was generated."""


class DeriveKeyAttestationData(BaseModel):
    """Data included in derive key attestation."""

    agent_id: str = Field(alias="agentId")
    """Agent ID that derived the key."""

    public_key: str = Field(alias="publicKey")
    """Public key derived."""

    subject: str | None = None
    """Subject used for derivation."""

    class Config:
        """Pydantic config."""

        populate_by_name = True


class RemoteAttestationMessageContent(BaseModel):
    """Message content to be attested."""

    entity_id: str = Field(alias="entityId")
    """Entity ID in the message."""

    room_id: str = Field(alias="roomId")
    """Room ID where message was sent."""

    content: str
    """Message content."""

    class Config:
        """Pydantic config."""

        populate_by_name = True


class RemoteAttestationMessage(BaseModel):
    """Message to be attested."""

    agent_id: str = Field(alias="agentId")
    """Agent ID generating attestation."""

    timestamp: int
    """Timestamp of attestation request."""

    message: RemoteAttestationMessageContent
    """Message details."""

    class Config:
        """Pydantic config."""

        populate_by_name = True


class DeriveKeyResult(BaseModel):
    """Result of key derivation."""

    key: bytes
    """The derived key as bytes."""

    certificate_chain: list[str]
    """Certificate chain for verification."""


class Ed25519KeypairResult(BaseModel):
    """Ed25519 keypair result from TEE."""

    public_key: str
    """The derived public key (base58 encoded)."""

    secret_key: bytes
    """Secret key (32 bytes)."""

    attestation: RemoteAttestationQuote
    """Attestation quote for verification."""


class EcdsaKeypairResult(BaseModel):
    """ECDSA (secp256k1) keypair result from TEE."""

    address: str
    """The derived address (0x prefixed)."""

    private_key: bytes
    """Private key (32 bytes)."""

    attestation: RemoteAttestationQuote
    """Attestation quote for verification."""


class TeeServiceConfig(BaseModel):
    """TEE Service configuration."""

    mode: TeeMode
    """TEE operation mode."""

    vendor: TeeVendor = TeeVendor.PHALA
    """TEE vendor to use."""

    secret_salt: str | None = None
    """Secret salt for key derivation."""


class TeeProviderResult(BaseModel):
    """Provider result returned by TEE providers."""

    data: dict[str, str] | None = None
    """Data object with key information."""

    values: dict[str, str] = Field(default_factory=dict)
    """Values for template injection."""

    text: str
    """Human-readable text description."""


# Type alias for UUID strings
UUID: TypeAlias = str


def parse_tee_mode(mode: str) -> TeeMode:
    """
    Validate TEE mode string.

    Args:
        mode: The mode string to parse.

    Returns:
        The validated TeeMode enum value.

    Raises:
        ValueError: If the mode is invalid.
    """
    mode_upper = mode.upper()
    if mode_upper == "LOCAL":
        return TeeMode.LOCAL
    if mode_upper == "DOCKER":
        return TeeMode.DOCKER
    if mode_upper == "PRODUCTION":
        return TeeMode.PRODUCTION
    raise ValueError(f"Invalid TEE_MODE: {mode}. Must be one of: LOCAL, DOCKER, PRODUCTION")


def parse_tee_vendor(vendor: str) -> TeeVendor:
    """
    Validate TEE vendor string.

    Args:
        vendor: The vendor string to parse.

    Returns:
        The validated TeeVendor enum value.

    Raises:
        ValueError: If the vendor is invalid.
    """
    vendor_lower = vendor.lower()
    if vendor_lower == "phala":
        return TeeVendor.PHALA
    raise ValueError(f"Invalid TEE_VENDOR: {vendor}. Must be one of: phala")

