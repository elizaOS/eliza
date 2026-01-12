import logging

from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import QueueParams

logger = logging.getLogger(__name__)


async def execute_queue(
    provider: EVMWalletProvider,
    params: QueueParams,
) -> str:
    logger.info(
        "Queueing governance proposal on governor %s on %s",
        params.governor,
        params.chain.value,
    )

    if not params.targets or len(params.targets) == 0:
        raise EVMError.invalid_params("Targets array cannot be empty")

    from web3 import Web3

    w3 = Web3()
    queue_selector = w3.keccak(text="queue(address[],uint256[],bytes[],bytes32)")[:4]
    encoded_params = w3.codec.encode(
        ["address[]", "uint256[]", "bytes[]", "bytes32"],
        [params.targets, params.values, params.calldatas, params.description_hash],
    )

    data = queue_selector.hex() + encoded_params.hex()

    tx_hash = await provider.send_transaction(
        chain=params.chain,
        to=params.governor,
        value=0,
        data=data,
    )

    await provider.wait_for_transaction(params.chain, tx_hash)

    logger.info("Proposal queued: %s", tx_hash)
    return tx_hash


queue_action = {
    "name": "QUEUE",
    "description": "Queue a passed DAO governance proposal for execution",
    "similes": [
        "GOVERNANCE_QUEUE",
        "queue_proposal",
    ],
    "examples": [
        "Queue proposal on governor 0x1234 on Ethereum",
        "Queue the passed proposal for execution on Base",
    ],
    "handler": execute_queue,
}
