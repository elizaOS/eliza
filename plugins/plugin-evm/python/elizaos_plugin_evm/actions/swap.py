import logging
from decimal import Decimal
from typing import TypedDict

import httpx

from elizaos_plugin_evm.constants import (
    DEFAULT_SLIPPAGE_PERCENT,
    LIFI_API_URL,
    MAX_SLIPPAGE_PERCENT,
)
from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import SwapParams, SwapQuote

logger = logging.getLogger(__name__)


class LiFiQuoteResponse(TypedDict):
    action: dict
    estimate: dict
    transactionRequest: dict


async def get_lifi_quote(
    params: SwapParams,
    from_address: str,
) -> SwapQuote:
    slippage = params.slippage or DEFAULT_SLIPPAGE_PERCENT

    if slippage > MAX_SLIPPAGE_PERCENT:
        raise EVMError.invalid_params(f"Slippage {slippage} exceeds maximum {MAX_SLIPPAGE_PERCENT}")

    url = f"{LIFI_API_URL}/quote"
    query_params = {
        "fromChain": params.chain.chain_id,
        "toChain": params.chain.chain_id,
        "fromToken": params.from_token,
        "toToken": params.to_token,
        "fromAmount": params.amount,
        "fromAddress": from_address,
        "slippage": slippage,
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=query_params, timeout=30.0)
            response.raise_for_status()
            data: LiFiQuoteResponse = response.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise EVMError.route_not_found("No swap route found for this pair") from e
            raise EVMError.network_error(f"LiFi API error: {e}") from e
        except Exception as e:
            raise EVMError.network_error(f"Failed to get quote: {e}") from e

    tx_request = data["transactionRequest"]
    estimate = data["estimate"]

    return SwapQuote(
        aggregator="lifi",
        min_output_amount=estimate.get("toAmountMin", "0"),
        to=tx_request["to"],
        value=int(tx_request.get("value", "0"), 16)
        if isinstance(tx_request.get("value"), str)
        else tx_request.get("value", 0),
        data=tx_request["data"],
        gas_limit=int(tx_request.get("gasLimit", "0"), 16)
        if isinstance(tx_request.get("gasLimit"), str)
        else tx_request.get("gasLimit"),
    )


async def execute_swap(
    provider: EVMWalletProvider,
    params: SwapParams,
) -> str:
    logger.info(
        "Executing swap: %s %s -> %s on %s",
        params.amount,
        params.from_token,
        params.to_token,
        params.chain.value,
    )

    quote = await get_lifi_quote(params, provider.address)

    if not params.from_token.lower().startswith("0x000000"):
        current_allowance = await provider.get_allowance(
            chain=params.chain,
            token_address=params.from_token,
            spender=quote.to,
        )

        amount_int = int(Decimal(params.amount))
        if current_allowance < amount_int:
            logger.info("Approving token spend...")
            approve_tx = await provider.approve_token(
                chain=params.chain,
                token_address=params.from_token,
                spender=quote.to,
                amount=2**256 - 1,
            )
            await provider.wait_for_transaction(params.chain, approve_tx)
            logger.info("Approval confirmed: %s", approve_tx)

    tx_hash = await provider.send_transaction(
        chain=params.chain,
        to=quote.to,
        value=quote.value,
        data=quote.data,
    )

    await provider.wait_for_transaction(params.chain, tx_hash)

    logger.info("Swap confirmed: %s", tx_hash)
    return tx_hash


swap_action = {
    "name": "SWAP_TOKEN",
    "description": "Swap one token for another on the same chain",
    "similes": [
        "swap",
        "exchange",
        "trade",
        "convert",
    ],
    "examples": [
        "Swap 0.1 ETH for USDC on mainnet",
        "Exchange 100 USDC for DAI on base",
    ],
    "handler": execute_swap,
}

# TS parity aliases (keep legacy names too)
evm_swap_tokens_action = {
    **swap_action,
    "name": "EVM_SWAP_TOKENS",
}
