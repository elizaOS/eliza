from __future__ import annotations

import logging

from eth_account import Account
from solders.keypair import Keypair

from elizaos_plugin_tee.errors import KeyDerivationError
from elizaos_plugin_tee.providers.base import DeriveKeyProvider
from elizaos_plugin_tee.providers.remote_attestation import PhalaRemoteAttestationProvider
from elizaos_plugin_tee.types import (
    DeriveKeyAttestationData,
    DeriveKeyResult,
    EcdsaKeypairResult,
    Ed25519KeypairResult,
    RemoteAttestationQuote,
)
from elizaos_plugin_tee.utils import TeeClient, calculate_sha256, get_tee_endpoint

logger = logging.getLogger(__name__)


class PhalaDeriveKeyProvider(DeriveKeyProvider):
    def __init__(self, tee_mode: str) -> None:
        endpoint = get_tee_endpoint(tee_mode)
        logger.info(
            f"TEE: Connecting to key derivation service at {endpoint}"
            if endpoint
            else "TEE: Running key derivation in production mode"
        )
        self._client = TeeClient(endpoint)
        self._ra_provider = PhalaRemoteAttestationProvider(tee_mode)

    async def _generate_derive_key_attestation(
        self,
        agent_id: str,
        public_key: str,
        subject: str | None = None,
    ) -> RemoteAttestationQuote:
        derive_key_data = DeriveKeyAttestationData(
            agent_id=agent_id,
            public_key=public_key,
            subject=subject,
        )
        return await self._ra_provider.generate_attestation(
            derive_key_data.model_dump_json(by_alias=True)
        )

    async def raw_derive_key(self, path: str, subject: str) -> DeriveKeyResult:
        if not path or not subject:
            raise KeyDerivationError("Path and subject are required for key derivation")

        try:
            key_bytes = await self._client.derive_key(path, subject)
            return DeriveKeyResult(
                key=key_bytes,
                certificate_chain=[],
            )
        except Exception as e:
            logger.exception("Error deriving raw key")
            raise KeyDerivationError(str(e)) from e

    async def derive_ed25519_keypair(
        self,
        path: str,
        subject: str,
        agent_id: str,
    ) -> Ed25519KeypairResult:
        if not path or not subject:
            raise KeyDerivationError("Path and subject are required for key derivation")

        try:
            derived_key = await self._client.derive_key(path, subject)
            seed = calculate_sha256(derived_key)[:32]
            keypair = Keypair.from_seed(seed)
            public_key = str(keypair.pubkey())

            attestation = await self._generate_derive_key_attestation(
                agent_id,
                public_key,
                subject,
            )

            return Ed25519KeypairResult(
                public_key=public_key,
                secret_key=bytes(keypair),
                attestation=attestation,
            )
        except KeyDerivationError:
            raise
        except Exception as e:
            logger.exception("Error deriving Ed25519 key")
            raise KeyDerivationError(str(e)) from e

    async def derive_ecdsa_keypair(
        self,
        path: str,
        subject: str,
        agent_id: str,
    ) -> EcdsaKeypairResult:
        if not path or not subject:
            raise KeyDerivationError("Path and subject are required for key derivation")

        try:
            derived_key = await self._client.derive_key(path, subject)
            from eth_hash.auto import keccak

            private_key_bytes = keccak(derived_key)
            account = Account.from_key(private_key_bytes)

            attestation = await self._generate_derive_key_attestation(
                agent_id,
                account.address,
                subject,
            )

            return EcdsaKeypairResult(
                address=account.address,
                private_key=private_key_bytes,
                attestation=attestation,
            )
        except KeyDerivationError:
            raise
        except Exception as e:
            logger.exception("Error deriving ECDSA key")
            raise KeyDerivationError(str(e)) from e

    async def close(self) -> None:
        """Close the underlying HTTP clients."""
        await self._client.close()
        await self._ra_provider.close()


async def get_derived_keys(
    tee_mode: str,
    secret_salt: str,
    agent_id: str,
) -> dict[str, str | dict[str, str] | None]:
    """
    Get derived keys for an agent.

    This is the provider function for elizaOS integration.

    Args:
        tee_mode: The TEE operation mode.
        secret_salt: The secret salt for key derivation.
        agent_id: The agent ID.

    Returns:
        The provider result with wallet data.
    """
    if not tee_mode:
        return {
            "data": None,
            "values": {},
            "text": "TEE_MODE is not configured",
        }

    if not secret_salt:
        logger.error("WALLET_SECRET_SALT is not configured")
        return {
            "data": None,
            "values": {},
            "text": "WALLET_SECRET_SALT is not configured in settings",
        }

    provider = PhalaDeriveKeyProvider(tee_mode)

    try:
        solana_keypair = await provider.derive_ed25519_keypair(secret_salt, "solana", agent_id)
        evm_keypair = await provider.derive_ecdsa_keypair(secret_salt, "evm", agent_id)

        wallet_data = {
            "solana": solana_keypair.public_key,
            "evm": evm_keypair.address,
        }

        values = {
            "solana_public_key": solana_keypair.public_key,
            "evm_address": evm_keypair.address,
        }

        text = f"Solana Public Key: {values['solana_public_key']}\nEVM Address: {values['evm_address']}"

        return {
            "data": wallet_data,
            "values": values,
            "text": text,
        }

    except Exception as e:
        logger.exception("Error in derive key provider")
        return {
            "data": None,
            "values": {},
            "text": f"Failed to derive keys: {e}",
        }

    finally:
        await provider.close()
