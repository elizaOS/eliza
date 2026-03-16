import logging

from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import VoteParams

logger = logging.getLogger(__name__)


async def execute_vote(
    provider: EVMWalletProvider,
    params: VoteParams,
) -> str:
    logger.info(
        "Executing governance vote on proposal %s on governor %s on %s",
        params.proposal_id,
        params.governor,
        params.chain.value,
    )

    if params.support not in [0, 1, 2]:
        raise EVMError.invalid_params("Support must be 0 (Against), 1 (For), or 2 (Abstain)")

    from web3 import Web3

    w3 = Web3()
    vote_selector = w3.keccak(text="castVote(uint256,uint8)")[:4]
    encoded_params = w3.codec.encode(
        ["uint256", "uint8"],
        [int(params.proposal_id), params.support],
    )

    data = vote_selector.hex() + encoded_params.hex()

    tx_hash = await provider.send_transaction(
        chain=params.chain,
        to=params.governor,
        value=0,
        data=data,
    )

    await provider.wait_for_transaction(params.chain, tx_hash)

    vote_type = {0: "Against", 1: "For", 2: "Abstain"}[params.support]
    logger.info("Vote cast (%s): %s", vote_type, tx_hash)
    return tx_hash


vote_action = {
    "name": "VOTE",
    "description": "Cast a vote on a DAO governance proposal",
    "similes": [
        "GOVERNANCE_VOTE",
        "cast_vote",
        "vote_proposal",
    ],
    "examples": [
        "Vote for proposal 1 on governor 0x1234 on Ethereum",
        "Vote against proposal 42 on the DAO at 0xabcd on Base",
    ],
    "handler": execute_vote,
}
