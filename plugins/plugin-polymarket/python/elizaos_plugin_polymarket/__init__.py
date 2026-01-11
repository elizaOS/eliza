"""
elizaOS Polymarket Plugin - Prediction markets integration for elizaOS.

This package provides Polymarket CLOB API adapters for elizaOS agents.

Features:
- Market data retrieval and browsing
- Order book access and pricing
- Order placement and management
- Integration with plugin-evm for Polygon wallet operations

This Python implementation mirrors the functionality of the TypeScript
and Rust implementations for cross-language consistency.
"""

__version__ = "2.0.0"

from elizaos_plugin_polymarket.actions import (
    cancel_order,
    get_best_price,
    get_market_details,
    get_markets,
    get_midpoint_price,
    get_open_orders,
    get_order_book,
    get_order_book_depth,
    get_order_details,
    get_sampling_markets,
    get_simplified_markets,
    get_spread,
    place_order,
)
from elizaos_plugin_polymarket.constants import (
    CACHE_REFRESH_INTERVAL_SECS,
    CTF_EXCHANGE_ADDRESS,
    DEFAULT_CLOB_API_URL,
    DEFAULT_CLOB_WS_URL,
    DEFAULT_FEE_RATE_BPS,
    DEFAULT_MIN_ORDER_SIZE,
    DEFAULT_PAGE_LIMIT,
    DEFAULT_REQUEST_TIMEOUT_SECS,
    END_CURSOR,
    GAMMA_API_URL,
    LLM_CALL_TIMEOUT_SECS,
    MAX_PAGE_LIMIT,
    MAX_PRICE,
    MIN_PRICE,
    NEG_RISK_ADAPTER_ADDRESS,
    NEG_RISK_CTF_EXCHANGE_ADDRESS,
    POLYGON_CHAIN_ID,
    POLYGON_CHAIN_NAME,
    POLYMARKET_SERVICE_NAME,
    POLYMARKET_WALLET_DATA_CACHE_KEY,
    USDC_ADDRESS,
    USDC_DECIMALS,
    WS_MAX_RECONNECT_ATTEMPTS,
    WS_PING_INTERVAL_SECS,
    WS_RECONNECT_DELAY_SECS,
)
from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import (
    ClobClientProvider,
    get_authenticated_clob_client,
    get_clob_client,
)
from elizaos_plugin_polymarket.types import (
    ApiKey,
    # API key types
    ApiKeyCreds,
    ApiKeyStatus,
    ApiKeyType,
    Balance,
    # Order book types
    BookEntry,
    GetTradesParams,
    Market,
    MarketFilters,
    MarketsResponse,
    OpenOrder,
    OrderBook,
    OrderParams,
    OrderResponse,
    # Order types
    OrderSide,
    OrderStatus,
    OrderType,
    # Position types
    Position,
    PriceHistoryEntry,
    Rewards,
    SimplifiedMarket,
    SimplifiedMarketsResponse,
    # Market types
    Token,
    # Price types
    TokenPrice,
    Trade,
    TradeEntry,
    TradesResponse,
    # Trade types
    TradeStatus,
)

__all__ = [
    # Version
    "__version__",
    # Providers
    "ClobClientProvider",
    "get_clob_client",
    "get_authenticated_clob_client",
    # Market actions
    "get_markets",
    "get_simplified_markets",
    "get_market_details",
    "get_sampling_markets",
    # Order book actions
    "get_order_book",
    "get_order_book_depth",
    "get_best_price",
    "get_midpoint_price",
    "get_spread",
    # Order actions
    "place_order",
    "cancel_order",
    "get_open_orders",
    "get_order_details",
    # Types - Market
    "Token",
    "Rewards",
    "Market",
    "SimplifiedMarket",
    "MarketFilters",
    "MarketsResponse",
    "SimplifiedMarketsResponse",
    # Types - Order
    "OrderSide",
    "OrderType",
    "OrderStatus",
    "OrderParams",
    "OrderResponse",
    "OpenOrder",
    # Types - Order Book
    "BookEntry",
    "OrderBook",
    # Types - Trade
    "TradeStatus",
    "Trade",
    "TradeEntry",
    "TradesResponse",
    "GetTradesParams",
    # Types - Position
    "Position",
    "Balance",
    # Types - API Key
    "ApiKeyCreds",
    "ApiKey",
    "ApiKeyType",
    "ApiKeyStatus",
    # Types - Price
    "TokenPrice",
    "PriceHistoryEntry",
    # Error handling
    "PolymarketError",
    "PolymarketErrorCode",
    # Constants - Chain
    "POLYGON_CHAIN_ID",
    "POLYGON_CHAIN_NAME",
    # Constants - API
    "DEFAULT_CLOB_API_URL",
    "DEFAULT_CLOB_WS_URL",
    "GAMMA_API_URL",
    # Constants - Service
    "POLYMARKET_SERVICE_NAME",
    "POLYMARKET_WALLET_DATA_CACHE_KEY",
    "CACHE_REFRESH_INTERVAL_SECS",
    "DEFAULT_REQUEST_TIMEOUT_SECS",
    "LLM_CALL_TIMEOUT_SECS",
    # Constants - Order
    "DEFAULT_FEE_RATE_BPS",
    "DEFAULT_MIN_ORDER_SIZE",
    "MAX_PRICE",
    "MIN_PRICE",
    # Constants - USDC
    "USDC_ADDRESS",
    "USDC_DECIMALS",
    # Constants - CTF
    "CTF_EXCHANGE_ADDRESS",
    "NEG_RISK_CTF_EXCHANGE_ADDRESS",
    "NEG_RISK_ADAPTER_ADDRESS",
    # Constants - WebSocket
    "WS_PING_INTERVAL_SECS",
    "WS_RECONNECT_DELAY_SECS",
    "WS_MAX_RECONNECT_ATTEMPTS",
    # Constants - Pagination
    "DEFAULT_PAGE_LIMIT",
    "MAX_PAGE_LIMIT",
    "END_CURSOR",
]


def get_plugin() -> dict:
    """Get the Polymarket plugin definition for elizaOS."""
    return {
        "name": "@elizaos/plugin-polymarket",
        "description": "Polymarket prediction markets plugin for elizaOS with Python support",
        "version": __version__,
        "actions": [
            get_markets,
            get_simplified_markets,
            get_market_details,
            get_sampling_markets,
            get_order_book,
            get_order_book_depth,
            get_best_price,
            get_midpoint_price,
            get_spread,
            place_order,
            cancel_order,
            get_open_orders,
            get_order_details,
        ],
        "providers": [
            ClobClientProvider,
        ],
    }
