import logging

from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import ExecuteParams

logger = logging.getLogger(__name__)


async def execute_governance(
    provider: EVMWalletProvider,
    params: ExecuteParams,
) -> str:
    logger.info(
        "Executing governance proposal on governor %s on %s",
        params.governor,
        params.chain.value,
    )

    if not params.targets or len(params.targets) == 0:
        raise EVMError.invalid_params("Targets array cannot be empty")

    from web3 import Web3

    w3 = Web3()
    execute_selector = w3.keccak(text="execute(address[],uint256[],bytes[],bytes32)")[:4]
    encoded_params = w3.codec.encode(
        ["address[]", "uint256[]", "bytes[]", "bytes32"],
        [params.targets, params.values, params.calldatas, params.description_hash],
    )

    data = execute_selector.hex() + encoded_params.hex()

    tx_hash = await provider.send_transaction(
        chain=params.chain,
        to=params.governor,
        value=0,
        data=data,
    )

    await provider.wait_for_transaction(params.chain, tx_hash)

    logger.info("Proposal executed: %s", tx_hash)
    return tx_hash


execute_action = {
    "name": "EXECUTE",
    "description": "Execute a queued DAO governance proposal",
    "similes": [
        "GOVERNANCE_EXECUTE",
        "execute_proposal",
        "run_proposal",
    ],
    "examples": [
        "Execute proposal on governor 0x1234 on Ethereum",
        "Execute the queued proposal on Base",
    ],
    "handler": execute_governance,
}
