"""
Remote Attestation Provider for Phala TEE.
"""

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
    """
    Phala Network Remote Attestation Provider.

    Generates TDX attestation quotes for proving TEE execution.
    """

    def __init__(self, tee_mode: str) -> None:
        """
        Initialize the Phala remote attestation provider.

        Args:
            tee_mode: The TEE operation mode (LOCAL, DOCKER, PRODUCTION).
        """
        endpoint = get_tee_endpoint(tee_mode)
        log_msg = (
            f"TEE: Connecting to simulator at {endpoint}"
            if endpoint
            else "TEE: Running in production mode without simulator"
        )
        logger.info(log_msg)
        self._client = TeeClient(endpoint)

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

        Raises:
            AttestationError: If attestation generation fails.
        """
        try:
            logger.debug("Generating attestation for: %s...", report_data[:100])

            hash_algo = hash_algorithm.value if hash_algorithm else None
            result = await self._client.tdx_quote(report_data, hash_algo)

            rtmrs = result.get("rtmrs", [])
            if rtmrs:
                logger.debug(
                    "RTMR values: rtmr0=%s, rtmr1=%s, rtmr2=%s, rtmr3=%s",
                    rtmrs[0] if len(rtmrs) > 0 else "N/A",
                    rtmrs[1] if len(rtmrs) > 1 else "N/A",
                    rtmrs[2] if len(rtmrs) > 2 else "N/A",
                    rtmrs[3] if len(rtmrs) > 3 else "N/A",
                )

            quote = RemoteAttestationQuote(
                quote=str(result["quote"]),
                timestamp=int(time.time() * 1000),
            )

            logger.info("Remote attestation quote generated successfully")
            return quote

        except Exception as e:
            logger.exception("Error generating remote attestation")
            raise AttestationError(str(e)) from e

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.close()


async def get_remote_attestation(
    tee_mode: str,
    agent_id: str,
    entity_id: str,
    room_id: str,
    content: str,
) -> dict[str, str | dict[str, str] | None]:
    """
    Get remote attestation for a message context.

    This is the provider function for elizaOS integration.

    Args:
        tee_mode: The TEE operation mode.
        agent_id: The agent ID.
        entity_id: The entity ID from the message.
        room_id: The room ID from the message.
        content: The message content.

    Returns:
        The provider result with attestation data.
    """
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

        logger.debug("Generating attestation for message: %s", json.dumps(attestation_message))

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
            "text": f"Your Agent's remote attestation is: {attestation.model_dump_json()}",
        }

    except Exception as e:
        logger.exception("Error in remote attestation provider")
        raise AttestationError(str(e)) from e

    finally:
        await provider.close()





