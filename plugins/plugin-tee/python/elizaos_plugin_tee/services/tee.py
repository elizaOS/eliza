"""
TEE Service for elizaOS.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos_plugin_tee.providers.derive_key import PhalaDeriveKeyProvider
from elizaos_plugin_tee.types import (
    DeriveKeyResult,
    EcdsaKeypairResult,
    Ed25519KeypairResult,
    TeeMode,
    TeeServiceConfig,
    TeeVendor,
)

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class TEEService:
    """
    TEE Service for secure key management within a Trusted Execution Environment.

    This service provides:
    - Ed25519 key derivation (for Solana)
    - ECDSA key derivation (for EVM chains)
    - Raw key derivation for custom use cases
    - Remote attestation for all derived keys
    """

    service_type = "tee"
    capability_description = "Trusted Execution Environment for secure key management"

    def __init__(
        self,
        mode: TeeMode | str = TeeMode.LOCAL,
        vendor: TeeVendor = TeeVendor.PHALA,
        secret_salt: str | None = None,
    ) -> None:
        """
        Initialize the TEE service.

        Args:
            mode: The TEE operation mode.
            vendor: The TEE vendor to use.
            secret_salt: The secret salt for key derivation.
        """
        if isinstance(mode, str):
            mode = TeeMode(mode.upper())

        self.config = TeeServiceConfig(
            mode=mode,
            vendor=vendor,
            secret_salt=secret_salt,
        )

        self._provider = PhalaDeriveKeyProvider(mode.value)
        logger.info("TEE service initialized with mode: %s, vendor: %s", mode.value, vendor.value)

    @classmethod
    async def start(
        cls,
        tee_mode: str | None = None,
        secret_salt: str | None = None,
    ) -> "TEEService":
        """
        Start the TEE service.

        Args:
            tee_mode: The TEE operation mode (defaults to LOCAL).
            secret_salt: The secret salt for key derivation.

        Returns:
            The initialized TEE service.
        """
        mode = TeeMode(tee_mode.upper()) if tee_mode else TeeMode.LOCAL
        logger.info("Starting TEE service with mode: %s", mode.value)
        return cls(mode=mode, secret_salt=secret_salt)

    async def stop(self) -> None:
        """Stop the TEE service."""
        logger.info("Stopping TEE service")
        await self._provider.close()

    async def derive_ecdsa_keypair(
        self,
        path: str,
        subject: str,
        agent_id: str,
    ) -> EcdsaKeypairResult:
        """
        Derive an ECDSA keypair for EVM chains.

        Args:
            path: The derivation path (e.g., secret salt).
            subject: The subject for the certificate chain (e.g., "evm").
            agent_id: The agent ID for attestation.

        Returns:
            The keypair result with address, private key, and attestation.
        """
        logger.debug("TEE Service: Deriving ECDSA keypair")
        return await self._provider.derive_ecdsa_keypair(path, subject, agent_id)

    async def derive_ed25519_keypair(
        self,
        path: str,
        subject: str,
        agent_id: str,
    ) -> Ed25519KeypairResult:
        """
        Derive an Ed25519 keypair for Solana.

        Args:
            path: The derivation path (e.g., secret salt).
            subject: The subject for the certificate chain (e.g., "solana").
            agent_id: The agent ID for attestation.

        Returns:
            The keypair result with public key, secret key, and attestation.
        """
        logger.debug("TEE Service: Deriving Ed25519 keypair")
        return await self._provider.derive_ed25519_keypair(path, subject, agent_id)

    async def raw_derive_key(self, path: str, subject: str) -> DeriveKeyResult:
        """
        Derive a raw key for custom use cases.

        Args:
            path: The derivation path.
            subject: The subject for the certificate chain.

        Returns:
            The raw key derivation result.
        """
        logger.debug("TEE Service: Deriving raw key")
        return await self._provider.raw_derive_key(path, subject)


