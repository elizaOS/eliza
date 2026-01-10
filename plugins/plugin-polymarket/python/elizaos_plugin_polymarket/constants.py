"""
Constants for the Polymarket plugin.
"""

# =============================================================================
# Chain Configuration
# =============================================================================

# Polymarket operates on Polygon Mainnet
POLYGON_CHAIN_ID = 137
POLYGON_CHAIN_NAME = "polygon"

# =============================================================================
# API Configuration
# =============================================================================

DEFAULT_CLOB_API_URL = "https://clob.polymarket.com"
DEFAULT_CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/"
GAMMA_API_URL = "https://gamma-api.polymarket.com"

# =============================================================================
# Service Configuration
# =============================================================================

POLYMARKET_SERVICE_NAME = "polymarket"
POLYMARKET_WALLET_DATA_CACHE_KEY = "polymarket_wallet_data"
CACHE_REFRESH_INTERVAL_SECS = 5 * 60  # 5 minutes
DEFAULT_REQUEST_TIMEOUT_SECS = 30
LLM_CALL_TIMEOUT_SECS = 60

# =============================================================================
# Order Configuration
# =============================================================================

DEFAULT_FEE_RATE_BPS = "0"
DEFAULT_MIN_ORDER_SIZE = "5"
MAX_PRICE = 1.0
MIN_PRICE = 0.0

# =============================================================================
# USDC Configuration
# =============================================================================

USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
USDC_DECIMALS = 6

# =============================================================================
# CTF Configuration
# =============================================================================

CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a"
NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"

# =============================================================================
# WebSocket Configuration
# =============================================================================

WS_PING_INTERVAL_SECS = 30
WS_RECONNECT_DELAY_SECS = 5
WS_MAX_RECONNECT_ATTEMPTS = 5

# =============================================================================
# Pagination Defaults
# =============================================================================

DEFAULT_PAGE_LIMIT = 100
MAX_PAGE_LIMIT = 500
END_CURSOR = "LTE="

