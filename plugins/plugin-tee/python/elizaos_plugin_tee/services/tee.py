from __future__ import annotations

import logging

from elizaos_plugin_tee.providers.derive_key import PhalaDeriveKeyProvider
from elizaos_plugin_tee.types import (
    DeriveKeyResult,
    EcdsaKeypairResult,
    Ed25519KeypairResult,
    TeeMode,
    TeeServiceConfig,
    TeeVendor,
)

logger = logging.getLogger(__name__)


class TEEService:
    service_type = "tee"
    capability_description = "Trusted Execution Environment for secure key management"

    def __init__(
        self,
        mode: TeeMode | str = TeeMode.LOCAL,
        vendor: TeeVendor = TeeVendor.PHALA,
        secret_salt: str | None = None,
    ) -> None:
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
    ) -> TEEService:
        mode = TeeMode(tee_mode.upper()) if tee_mode else TeeMode.LOCAL
        logger.info("Starting TEE service with mode: %s", mode.value)
        return cls(mode=mode, secret_salt=secret_salt)

    async def stop(self) -> None:
        logger.info("Stopping TEE service")
        await self._provider.close()

    async def derive_ecdsa_keypair(
        self,
        path: str,
        subject: str,
        agent_id: str,
    ) -> EcdsaKeypairResult:
        return await self._provider.derive_ecdsa_keypair(path, subject, agent_id)

    async def derive_ed25519_keypair(
        self,
        path: str,
        subject: str,
        agent_id: str,
    ) -> Ed25519KeypairResult:
        return await self._provider.derive_ed25519_keypair(path, subject, agent_id)

    async def raw_derive_key(self, path: str, subject: str) -> DeriveKeyResult:
        return await self._provider.raw_derive_key(path, subject)
