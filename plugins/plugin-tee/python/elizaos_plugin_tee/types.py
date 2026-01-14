"""Core types for the TEE plugin."""

from __future__ import annotations

from enum import Enum
from typing import TypeAlias

from pydantic import BaseModel, ConfigDict, Field


class TeeMode(str, Enum):
    LOCAL = "LOCAL"
    DOCKER = "DOCKER"
    PRODUCTION = "PRODUCTION"


class TeeVendor(str, Enum):
    PHALA = "phala"


class TeeType(str, Enum):
    SGX_GRAMINE = "sgx_gramine"
    TDX_DSTACK = "tdx_dstack"


class TdxQuoteHashAlgorithm(str, Enum):
    SHA256 = "sha256"
    SHA384 = "sha384"
    SHA512 = "sha512"
    RAW = "raw"


class RemoteAttestationQuote(BaseModel):
    quote: str
    timestamp: int


class DeriveKeyAttestationData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agent_id: str = Field(alias="agentId")
    public_key: str = Field(alias="publicKey")
    subject: str | None = None


class RemoteAttestationMessageContent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    entity_id: str = Field(alias="entityId")
    room_id: str = Field(alias="roomId")
    content: str


class RemoteAttestationMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    agent_id: str = Field(alias="agentId")
    timestamp: int
    message: RemoteAttestationMessageContent


class DeriveKeyResult(BaseModel):
    key: bytes
    certificate_chain: list[str]


class Ed25519KeypairResult(BaseModel):
    public_key: str
    secret_key: bytes
    attestation: RemoteAttestationQuote


class EcdsaKeypairResult(BaseModel):
    address: str
    private_key: bytes
    attestation: RemoteAttestationQuote


class TeeServiceConfig(BaseModel):
    mode: TeeMode
    vendor: TeeVendor = TeeVendor.PHALA
    secret_salt: str | None = None


class TeeProviderResult(BaseModel):
    data: dict[str, str] | None = None
    values: dict[str, str] = Field(default_factory=dict)
    text: str


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
    vendor_lower = vendor.lower()
    if vendor_lower == "phala":
        return TeeVendor.PHALA
    raise ValueError(f"Invalid TEE_VENDOR: {vendor}. Must be one of: phala")
