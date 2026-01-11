"""
Constants for the EVM plugin.
"""

# Cache key for wallet data storage
EVM_WALLET_DATA_CACHE_KEY = "evm/wallet/data"

# Service name for the EVM service registration
EVM_SERVICE_NAME = "evmService"

# Cache refresh interval in seconds
CACHE_REFRESH_INTERVAL_SECS = 60

# Default gas buffer multiplier (20% extra)
GAS_BUFFER_MULTIPLIER = 1.2

# Default gas price multiplier for MEV protection (10% extra)
GAS_PRICE_MULTIPLIER = 1.1

# Maximum slippage percentage for swaps (5%)
MAX_SLIPPAGE_PERCENT = 0.05

# Default slippage for swaps (1%)
DEFAULT_SLIPPAGE_PERCENT = 0.01

# Maximum price impact for bridges (40%)
MAX_PRICE_IMPACT = 0.4

# Transaction confirmation timeout in seconds
TX_CONFIRMATION_TIMEOUT_SECS = 60

# Bridge status polling interval in seconds
BRIDGE_POLL_INTERVAL_SECS = 5

# Maximum bridge status polling attempts
MAX_BRIDGE_POLL_ATTEMPTS = 60

# Native token address (zero address)
NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000"

# LiFi API base URL
LIFI_API_URL = "https://li.quest/v1"

# Bebop API base URL
BEBOP_API_URL = "https://api.bebop.xyz/router"

# Standard ERC20 decimals
DEFAULT_DECIMALS = 18

# Default chains if none are configured
DEFAULT_CHAINS = ["mainnet", "base"]

# ERC20 ABI for common operations
ERC20_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [],
        "name": "symbol",
        "outputs": [{"name": "", "type": "string"}],
        "type": "function",
    },
    {
        "constant": False,
        "inputs": [
            {"name": "_to", "type": "address"},
            {"name": "_value", "type": "uint256"},
        ],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function",
    },
    {
        "constant": False,
        "inputs": [
            {"name": "_spender", "type": "address"},
            {"name": "_value", "type": "uint256"},
        ],
        "name": "approve",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [
            {"name": "_owner", "type": "address"},
            {"name": "_spender", "type": "address"},
        ],
        "name": "allowance",
        "outputs": [{"name": "", "type": "uint256"}],
        "type": "function",
    },
]
