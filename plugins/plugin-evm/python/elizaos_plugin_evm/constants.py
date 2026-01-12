EVM_WALLET_DATA_CACHE_KEY = "evm/wallet/data"
EVM_SERVICE_NAME = "evmService"
CACHE_REFRESH_INTERVAL_SECS = 60
GAS_BUFFER_MULTIPLIER = 1.2
GAS_PRICE_MULTIPLIER = 1.1
MAX_SLIPPAGE_PERCENT = 0.05
DEFAULT_SLIPPAGE_PERCENT = 0.01
MAX_PRICE_IMPACT = 0.4
TX_CONFIRMATION_TIMEOUT_SECS = 60
BRIDGE_POLL_INTERVAL_SECS = 5
MAX_BRIDGE_POLL_ATTEMPTS = 60
NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000"  # noqa: S105
LIFI_API_URL = "https://li.quest/v1"
BEBOP_API_URL = "https://api.bebop.xyz/router"
DEFAULT_DECIMALS = 18
DEFAULT_CHAINS = ["mainnet", "base"]

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
