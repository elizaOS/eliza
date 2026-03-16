import logging

from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import ProposeParams

logger = logging.getLogger(__name__)


async def execute_propose(
    provider: EVMWalletProvider,
    params: ProposeParams,
) -> str:
    logger.info(
        "Executing governance proposal on governor %s on %s",
        params.governor,
        params.chain.value,
    )

    if not params.targets or len(params.targets) == 0:
        raise EVMError.invalid_params("Targets array cannot be empty")

    if len(params.targets) != len(params.values):
        raise EVMError.invalid_params("Targets and values arrays must have same length")

    if len(params.targets) != len(params.calldatas):
        raise EVMError.invalid_params("Targets and calldatas arrays must have same length")

    if not params.description:
        raise EVMError.invalid_params("Description cannot be empty")

    from web3 import Web3

    w3 = Web3()
    propose_selector = w3.keccak(text="propose(address[],uint256[],bytes[],string)")[:4]
    encoded_params = w3.codec.encode(
        ["address[]", "uint256[]", "bytes[]", "string"],
        [params.targets, params.values, params.calldatas, params.description],
    )

    data = propose_selector.hex() + encoded_params.hex()

    tx_hash = await provider.send_transaction(
        chain=params.chain,
        to=params.governor,
        value=0,
        data=data,
    )

    await provider.wait_for_transaction(params.chain, tx_hash)

    logger.info("Proposal submitted: %s", tx_hash)
    return tx_hash


propose_action = {
    "name": "PROPOSE",
    "description": "Execute a DAO governance proposal",
    "similes": [
        "GOVERNANCE_PROPOSE",
        "create_proposal",
        "submit_proposal",
    ],
    "examples": [
        "Propose transferring tokens on the governor at 0x1234 on Ethereum",
        "Create a new proposal to update the fee structure on Base",
    ],
    "handler": execute_propose,
}
