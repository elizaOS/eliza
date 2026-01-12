__version__ = "0.1.0"

from elizaos_plugin_evm.actions import (
    bridge_action,
    evm_bridge_tokens_action,
    evm_swap_tokens_action,
    evm_transfer_tokens_action,
    execute_action,
    execute_bridge,
    execute_governance,
    execute_propose,
    execute_queue,
    execute_swap,
    execute_transfer,
    execute_vote,
    propose_action,
    queue_action,
    swap_action,
    transfer_action,
    vote_action,
)
from elizaos_plugin_evm.constants import (
    CACHE_REFRESH_INTERVAL_SECS,
    EVM_SERVICE_NAME,
    EVM_WALLET_DATA_CACHE_KEY,
    LIFI_API_URL,
    NATIVE_TOKEN_ADDRESS,
)
from elizaos_plugin_evm.error import EVMError, EVMErrorCode
from elizaos_plugin_evm.providers import EVMWalletProvider
from elizaos_plugin_evm.providers.wallet import GeneratedKey, generate_private_key
from elizaos_plugin_evm.service import EVMService, EvmWalletChainData, EvmWalletData
from elizaos_plugin_evm.types import (
    BridgeParams,
    BridgeStatus,
    BridgeStatusType,
    SupportedChain,
    SwapParams,
    SwapQuote,
    TokenInfo,
    TokenWithBalance,
    TransferParams,
    VoteParams,
    VoteType,
    WalletBalance,
)

__all__ = [
    # Version
    "__version__",
    # Provider
    "EVMWalletProvider",
    # Service
    "EVMService",
    "EvmWalletData",
    "EvmWalletChainData",
    # Key generation
    "GeneratedKey",
    "generate_private_key",
    # Types
    "SupportedChain",
    "TokenInfo",
    "TokenWithBalance",
    "WalletBalance",
    "TransferParams",
    "SwapParams",
    "SwapQuote",
    "BridgeParams",
    "BridgeStatus",
    "BridgeStatusType",
    "VoteParams",
    "VoteType",
    # Error handling
    "EVMError",
    "EVMErrorCode",
    # Actions
    "execute_transfer",
    "transfer_action",
    "evm_transfer_tokens_action",
    "execute_swap",
    "swap_action",
    "evm_swap_tokens_action",
    "execute_bridge",
    "bridge_action",
    "evm_bridge_tokens_action",
    "execute_propose",
    "propose_action",
    "execute_vote",
    "vote_action",
    "execute_queue",
    "queue_action",
    "execute_governance",
    "execute_action",
    # Constants
    "EVM_SERVICE_NAME",
    "EVM_WALLET_DATA_CACHE_KEY",
    "CACHE_REFRESH_INTERVAL_SECS",
    "NATIVE_TOKEN_ADDRESS",
    "LIFI_API_URL",
]


def get_plugin():
    return {
        "name": "@elizaos/plugin-evm",
        "description": "EVM blockchain plugin for elizaOS with Python support",
        "version": __version__,
        "actions": [
            # TS parity action names
            evm_transfer_tokens_action,
            evm_swap_tokens_action,
            evm_bridge_tokens_action,
            # Legacy action names
            transfer_action,
            swap_action,
            bridge_action,
            propose_action,
            vote_action,
            queue_action,
            execute_action,
        ],
        "providers": [
            EVMWalletProvider,
        ],
    }
