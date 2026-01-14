from __future__ import annotations

from abc import ABC, abstractmethod

from elizaos_plugin_tee.types import (
    DeriveKeyResult,
    RemoteAttestationQuote,
    TdxQuoteHashAlgorithm,
)


class DeriveKeyProvider(ABC):
    @abstractmethod
    async def raw_derive_key(self, path: str, subject: str) -> DeriveKeyResult:
        pass


class RemoteAttestationProvider(ABC):
    @abstractmethod
    async def generate_attestation(
        self,
        report_data: str,
        hash_algorithm: TdxQuoteHashAlgorithm | None = None,
    ) -> RemoteAttestationQuote:
        pass
