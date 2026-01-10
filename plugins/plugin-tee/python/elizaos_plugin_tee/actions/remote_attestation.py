"""
Remote Attestation Action for TEE.
"""

from __future__ import annotations

import json
import logging
import time

from elizaos_plugin_tee.providers.remote_attestation import PhalaRemoteAttestationProvider
from elizaos_plugin_tee.types import RemoteAttestationMessage, RemoteAttestationMessageContent
from elizaos_plugin_tee.utils import hex_to_bytes, upload_attestation_quote

logger = logging.getLogger(__name__)


async def handle_remote_attestation(
    tee_mode: str,
    agent_id: str,
    entity_id: str,
    room_id: str,
    content: str,
) -> dict[str, bool | str]:
    """
    Handle remote attestation action.

    Generates a remote attestation quote and uploads it to the proof service.

    Args:
        tee_mode: The TEE operation mode.
        agent_id: The agent ID.
        entity_id: The entity ID from the message.
        room_id: The room ID from the message.
        content: The message content.

    Returns:
        A result dict with success status and text/error message.
    """
    try:
        if not tee_mode:
            logger.error("TEE_MODE is not configured")
            return {
                "success": False,
                "text": "TEE_MODE is not configured. Cannot generate attestation.",
            }

        # Build attestation message
        attestation_message = RemoteAttestationMessage(
            agent_id=agent_id,
            timestamp=int(time.time() * 1000),
            message=RemoteAttestationMessageContent(
                entity_id=entity_id,
                room_id=room_id,
                content=content,
            ),
        )

        logger.debug("Generating attestation for: %s", attestation_message.model_dump_json())

        # Generate attestation
        provider = PhalaRemoteAttestationProvider(tee_mode)
        try:
            attestation = await provider.generate_attestation(
                attestation_message.model_dump_json(by_alias=True)
            )
        finally:
            await provider.close()

        # Upload to proof service
        attestation_data = hex_to_bytes(attestation.quote)
        upload_result = await upload_attestation_quote(attestation_data)

        proof_url = f"https://proof.t16z.com/reports/{upload_result['checksum']}"

        logger.info("Attestation uploaded: %s", proof_url)

        return {
            "success": True,
            "text": f"Here's my 🧾 RA Quote 🫡\n{proof_url}",
        }

    except Exception as e:
        error_message = str(e)
        logger.exception("Failed to generate remote attestation")
        return {
            "success": False,
            "text": f"Failed to generate attestation: {error_message}",
        }


# Action definition for elizaOS integration
REMOTE_ATTESTATION_ACTION = {
    "name": "REMOTE_ATTESTATION",
    "similes": [
        "REMOTE_ATTESTATION",
        "TEE_REMOTE_ATTESTATION",
        "TEE_ATTESTATION",
        "TEE_QUOTE",
        "ATTESTATION",
        "TEE_ATTESTATION_QUOTE",
        "PROVE_TEE",
        "VERIFY_TEE",
    ],
    "description": (
        "Generate a remote attestation to prove that the agent is running in "
        "a TEE (Trusted Execution Environment)"
    ),
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": "If you are running in a TEE, generate a remote attestation",
                },
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "Of course, one second...",
                    "actions": ["REMOTE_ATTESTATION"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": "Can you prove you're running in a trusted execution environment?",
                },
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "Absolutely! Let me generate a TEE attestation quote for you.",
                    "actions": ["REMOTE_ATTESTATION"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": (
                        "I need verification that this conversation is happening "
                        "in a secure enclave"
                    ),
                },
            },
            {
                "name": "{{agentName}}",
                "content": {
                    "text": "I'll generate a remote attestation to prove I'm running in a TEE.",
                    "actions": ["REMOTE_ATTESTATION"],
                },
            },
        ],
    ],
}

