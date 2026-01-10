"""
Abstract base classes for TEE providers.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from elizaos_plugin_tee.types import (
    DeriveKeyResult,
    RemoteAttestationQuote,
    TdxQuoteHashAlgorithm,
)


class DeriveKeyProvider(ABC):
    """
    Abstract class for deriving keys from the TEE.

    Implement this class to support different TEE vendors.
    """

    @abstractmethod
    async def raw_derive_key(self, path: str, subject: str) -> DeriveKeyResult:
        """
        Derive a raw key from the TEE.

        Args:
            path: The derivation path.
            subject: The subject for the certificate chain.

        Returns:
            The derived key result.
        """


class RemoteAttestationProvider(ABC):
    """
    Abstract class for remote attestation provider.

    Implement this class to support different TEE vendors.
    """

    @abstractmethod
    async def generate_attestation(
        self,
        report_data: str,
        hash_algorithm: TdxQuoteHashAlgorithm | None = None,
    ) -> RemoteAttestationQuote:
        """
        Generate a remote attestation quote.

        Args:
            report_data: The data to include in the attestation report.
            hash_algorithm: Optional hash algorithm for the quote.

        Returns:
            The remote attestation quote.
        """

