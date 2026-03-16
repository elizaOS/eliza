from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal

from solders.pubkey import Pubkey

from elizaos_plugin_solana.client import SolanaClient
from elizaos_plugin_solana.types import SwapQuoteParams

logger = logging.getLogger(__name__)

WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"


@dataclass
class SwapActionResult:
    success: bool
    text: str
    signature: str | None = None
    in_amount: str | None = None
    out_amount: str | None = None
    error: str | None = None


async def handle_swap(
    client: SolanaClient,
    input_mint: str,
    output_mint: str,
    amount: Decimal,
    slippage_bps: int | None = None,
) -> SwapActionResult:
    logger.info("Executing swap: %s %s -> %s", amount, input_mint, output_mint)

    try:
        Pubkey.from_string(input_mint)
    except Exception:
        return SwapActionResult(
            success=False,
            text=f"Invalid input mint address: {input_mint}",
            error="Invalid input mint address",
        )

    try:
        Pubkey.from_string(output_mint)
    except Exception:
        return SwapActionResult(
            success=False,
            text=f"Invalid output mint address: {output_mint}",
            error="Invalid output mint address",
        )

    decimals = 9
    amount_raw = str(int(amount * Decimal(10**decimals)))

    quote_params = SwapQuoteParams(
        input_mint=input_mint,
        output_mint=output_mint,
        amount=amount_raw,
        slippage_bps=slippage_bps or 50,
    )

    try:
        quote = await client.get_swap_quote(quote_params)
        result = await client.execute_swap(quote)

        text = (
            f"Swap completed successfully! Transaction ID: {result.signature}"
            if result.signature
            else "Swap completed successfully!"
        )

        logger.info("Swap successful: %s", result)

        return SwapActionResult(
            success=True,
            text=text,
            signature=result.signature,
            in_amount=result.in_amount,
            out_amount=result.out_amount,
        )

    except Exception as e:
        logger.exception("Swap failed")
        return SwapActionResult(
            success=False,
            text=f"Swap failed: {e}",
            error=str(e),
        )


def resolve_sol_mint(symbol_or_mint: str) -> str:
    if symbol_or_mint.upper() == "SOL":
        return WRAPPED_SOL_MINT
    return symbol_or_mint


SWAP_ACTION = {
    "name": "SWAP_SOLANA",
    "similes": [
        "SWAP_SOL",
        "SWAP_TOKENS_SOLANA",
        "TOKEN_SWAP_SOLANA",
        "TRADE_TOKENS_SOLANA",
        "EXCHANGE_TOKENS_SOLANA",
    ],
    "description": (
        "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens."
    ),
    "examples": [
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Swap 0.1 SOL for USDC"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "I'll help you swap 0.1 SOL for USDC",
                    "actions": ["SWAP_SOLANA"],
                },
            },
        ],
        [
            {
                "name": "{{name1}}",
                "content": {"text": "Exchange 100 USDC for SOL"},
            },
            {
                "name": "{{name2}}",
                "content": {
                    "text": "Sure, let me execute that swap for you.",
                    "actions": ["SWAP_SOLANA"],
                },
            },
        ],
    ],
}
