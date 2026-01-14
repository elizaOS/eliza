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
    logger.info(
        "Executing transfer: %s %s -> %s on %s",
        params.amount,
        params.token or "native",
        params.to_address,
        params.from_chain.value,
    )

    amount_decimal = Decimal(params.amount)

    if params.token is None or params.token.lower() == NATIVE_TOKEN_ADDRESS.lower():
        value_wei = int(amount_decimal * Decimal(10**DEFAULT_DECIMALS))

        tx_hash = await provider.send_transaction(
            chain=params.from_chain,
            to=params.to_address,
            value=value_wei,
            data=params.data,
        )

        await provider.wait_for_transaction(params.from_chain, tx_hash)

        logger.info("Transfer confirmed: %s", tx_hash)
        return tx_hash

    token_balance = await provider.get_token_balance(params.from_chain, params.token)
    decimals = token_balance.token.decimals
    value = int(amount_decimal * Decimal(10**decimals))

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

    await provider.wait_for_transaction(params.from_chain, tx_hash)

    logger.info("Token transfer confirmed: %s", tx_hash)
    return tx_hash


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

# TS parity aliases (keep legacy names too)
evm_transfer_tokens_action = {
    **transfer_action,
    "name": "EVM_TRANSFER_TOKENS",
}
