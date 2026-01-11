"""
Transfer action for sending native tokens and ERC20 tokens.
"""

import logging
from decimal import Decimal

from elizaos_plugin_evm.constants import DEFAULT_DECIMALS, NATIVE_TOKEN_ADDRESS
from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import TransferParams

logger = logging.getLogger(__name__)


async def execute_transfer(
    provider: EVMWalletProvider,
    params: TransferParams,
) -> str:
    """
    Execute a token transfer.

    Args:
        provider: The wallet provider to use.
        params: The transfer parameters.

    Returns:
        The transaction hash.

    Raises:
        EVMError: If the transfer fails.
    """
    logger.info(
        "Executing transfer: %s %s -> %s on %s",
        params.amount,
        params.token or "native",
        params.to_address,
        params.from_chain.value,
    )

    # Parse amount
    amount_decimal = Decimal(params.amount)

    # Handle native token transfer
    if params.token is None or params.token.lower() == NATIVE_TOKEN_ADDRESS.lower():
        # Convert to wei (18 decimals)
        value_wei = int(amount_decimal * Decimal(10**DEFAULT_DECIMALS))

        tx_hash = await provider.send_transaction(
            chain=params.from_chain,
            to=params.to_address,
            value=value_wei,
            data=params.data,
        )

        # Wait for confirmation
        await provider.wait_for_transaction(params.from_chain, tx_hash)

        logger.info("Transfer confirmed: %s", tx_hash)
        return tx_hash

    # Handle ERC20 transfer
    # Get token decimals
    token_balance = await provider.get_token_balance(params.from_chain, params.token)
    decimals = token_balance.token.decimals

    # Convert amount to token units
    value = int(amount_decimal * Decimal(10**decimals))

    # Check balance
    if token_balance.balance < value:
        raise EVMError.insufficient_funds(
            f"Insufficient token balance: have {token_balance.formatted_balance}, need {params.amount}"
        )

    tx_hash = await provider.send_token(
        chain=params.from_chain,
        token_address=params.token,
        to=params.to_address,
        amount=value,
    )

    # Wait for confirmation
    await provider.wait_for_transaction(params.from_chain, tx_hash)

    logger.info("Token transfer confirmed: %s", tx_hash)
    return tx_hash


# Action definition for elizaOS
transfer_action = {
    "name": "TRANSFER_TOKEN",
    "description": "Transfer native tokens or ERC20 tokens to an address",
    "similes": [
        "send",
        "transfer",
        "pay",
        "move",
        "give",
    ],
    "examples": [
        "Send 0.1 ETH to 0x1234...5678 on mainnet",
        "Transfer 100 USDC to 0xabcd...ef01 on base",
    ],
    "handler": execute_transfer,
}
