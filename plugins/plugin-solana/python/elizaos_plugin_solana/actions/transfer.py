"""TRANSFER_SOLANA action implementation."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal

from solders.pubkey import Pubkey

from elizaos_plugin_solana.client import SolanaClient

logger = logging.getLogger(__name__)


@dataclass
class TransferActionResult:
    """Result of a transfer action."""

    success: bool
    text: str
    signature: str | None = None
    amount: str | None = None
    recipient: str | None = None
    error: str | None = None


async def handle_transfer(
    client: SolanaClient,
    token_mint: str | None,
    recipient: str,
    amount: Decimal,
) -> TransferActionResult:
    """Execute a transfer (auto-detects SOL vs SPL token).

    Args:
        client: The Solana client.
        token_mint: Optional token mint address. If None, transfers SOL.
        recipient: Recipient's public key address.
        amount: Amount to transfer.

    Returns:
        The transfer result.
    """
    if token_mint is None:
        return await handle_sol_transfer(client, recipient, amount)
    return await handle_token_transfer(client, token_mint, recipient, amount)


async def handle_sol_transfer(
    client: SolanaClient,
    recipient: str,
    amount: Decimal,
) -> TransferActionResult:
    """Execute a SOL transfer.

    Args:
        client: The Solana client.
        recipient: Recipient's public key address.
        amount: Amount in SOL to transfer.

    Returns:
        The transfer result.
    """
    logger.info("Executing SOL transfer: %s SOL to %s", amount, recipient)

    # Validate recipient address
    try:
        recipient_pubkey = Pubkey.from_string(recipient)
    except Exception:
        return TransferActionResult(
            success=False,
            text=f"Invalid recipient address: {recipient}",
            error="Invalid recipient address",
        )

    try:
        result = await client.transfer_sol(recipient_pubkey, amount)

        text = f"Sent {amount} SOL. Transaction hash: {result.signature or 'unknown'}"
        logger.info("SOL transfer successful: %s", result)

        return TransferActionResult(
            success=True,
            text=text,
            signature=result.signature,
            amount=str(amount),
            recipient=recipient,
        )

    except Exception as e:
        logger.exception("SOL transfer failed")
        return TransferActionResult(
            success=False,
            text=f"Transfer failed: {e}",
            error=str(e),
        )


async def handle_token_transfer(
    client: SolanaClient,
    token_mint: str,
    recipient: str,
    amount: Decimal,
) -> TransferActionResult:
    """Execute an SPL token transfer.

    Args:
        client: The Solana client.
        token_mint: Token mint address.
        recipient: Recipient's public key address.
        amount: Amount in token units to transfer.

    Returns:
        The transfer result.
    """
    logger.info("Executing token transfer: %s of %s to %s", amount, token_mint, recipient)

    # Validate mint address
    try:
        mint_pubkey = Pubkey.from_string(token_mint)
    except Exception:
        return TransferActionResult(
            success=False,
            text=f"Invalid token mint address: {token_mint}",
            error="Invalid token mint address",
        )

    # Validate recipient address
    try:
        recipient_pubkey = Pubkey.from_string(recipient)
    except Exception:
        return TransferActionResult(
            success=False,
            text=f"Invalid recipient address: {recipient}",
            error="Invalid recipient address",
        )

    try:
        result = await client.transfer_token(mint_pubkey, recipient_pubkey, amount)

        text = (
            f"Sent {amount} tokens to {recipient}\n"
            f"Transaction hash: {result.signature or 'unknown'}"
        )
        logger.info("Token transfer successful: %s", result)

        return TransferActionResult(
            success=True,
            text=text,
            signature=result.signature,
            amount=str(amount),
            recipient=recipient,
        )

    except Exception as e:
        logger.exception("Token transfer failed")
        return TransferActionResult(
            success=False,
            text=f"Transfer failed: {e}",
            error=str(e),
        )


# Action definition for elizaOS integration
TRANSFER_ACTION = {
    "name": "TRANSFER_SOLANA",
    "similes": [
        "TRANSFER_SOL",
        "SEND_TOKEN_SOLANA",
        "TRANSFER_TOKEN_SOLANA",
        "SEND_TOKENS_SOLANA",
        "TRANSFER_TOKENS_SOLANA",
        "SEND_SOL",
        "SEND_TOKEN_SOL",
        "PAY_SOL",
        "PAY_TOKEN_SOL",
        "PAY_TOKENS_SOL",
        "PAY_TOKENS_SOLANA",
        "PAY_SOLANA",
    ],
    "description": "Transfer SOL or SPL tokens to another address on Solana.",
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": "Send 1.5 SOL to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
                },
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "Sending SOL now...",
                    "actions": ["TRANSFER_SOLANA"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {
                    "text": "Transfer 100 USDC to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa",
                },
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "I'll send those tokens for you.",
                    "actions": ["TRANSFER_SOLANA"],
                },
            },
        ],
    ],
}
