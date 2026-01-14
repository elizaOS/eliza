from __future__ import annotations

import json
import logging
import time

from elizaos_plugin_tee.errors import AttestationError
from elizaos_plugin_tee.providers.base import RemoteAttestationProvider
from elizaos_plugin_tee.types import (
    RemoteAttestationQuote,
    TdxQuoteHashAlgorithm,
)
from elizaos_plugin_tee.utils import TeeClient, get_tee_endpoint

logger = logging.getLogger(__name__)


class PhalaRemoteAttestationProvider(RemoteAttestationProvider):
    def __init__(self, tee_mode: str) -> None:
        endpoint = get_tee_endpoint(tee_mode)
        logger.info(
            f"TEE: Connecting to simulator at {endpoint}"
            if endpoint
            else "TEE: Running in production mode without simulator"
        )
        self._client = TeeClient(endpoint)

    async def generate_attestation(
        self,
        report_data: str,
        hash_algorithm: TdxQuoteHashAlgorithm | None = None,
    ) -> RemoteAttestationQuote:
        try:
            hash_algo = hash_algorithm.value if hash_algorithm else None
            result = await self._client.tdx_quote(report_data, hash_algo)

            quote = RemoteAttestationQuote(
                quote=str(result["quote"]),
                timestamp=int(time.time() * 1000),
            )

            return quote
        except Exception as e:
            logger.exception("Error generating remote attestation")
            raise AttestationError(str(e)) from e

    async def close(self) -> None:
        await self._client.close()


async def get_remote_attestation(
    tee_mode: str,
    agent_id: str,
    entity_id: str,
    room_id: str,
    content: str,
) -> dict[str, str | dict[str, str] | None]:
    if not tee_mode:
        return {
            "data": None,
            "values": {},
            "text": "TEE_MODE is not configured",
        }

    provider = PhalaRemoteAttestationProvider(tee_mode)

    try:
        attestation_message = {
            "agentId": agent_id,
            "timestamp": int(time.time() * 1000),
            "message": {
                "entityId": entity_id,
                "roomId": room_id,
                "content": content,
            },
        }

        attestation = await provider.generate_attestation(json.dumps(attestation_message))

        return {
            "data": {
                "quote": attestation.quote,
                "timestamp": str(attestation.timestamp),
            },
            "values": {
                "quote": attestation.quote,
                "timestamp": str(attestation.timestamp),
            },
            "text": f"Remote attestation: {attestation.quote[:64]}...",
        }

    except Exception as e:
        logger.exception("Error in remote attestation provider")
        raise AttestationError(str(e)) from e

    finally:
        await provider.close()
