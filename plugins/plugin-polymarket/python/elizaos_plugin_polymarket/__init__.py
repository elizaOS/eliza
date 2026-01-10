"""
elizaOS Polymarket Plugin - Prediction markets integration for elizaOS.

This package provides Polymarket CLOB API adapters for elizaOS agents.

Features:
- Market data retrieval and browsing
- Order book access and pricing
- Order placement and management
- Integration with plugin-evm for Polygon wallet operations
"""

__version__ = "2.0.0"

from elizaos_plugin_polymarket.actions import (
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
)
from elizaos_plugin_polymarket.constants import (
    POLYGON_CHAIN_ID,
    POLYGON_CHAIN_NAME,
    DEFAULT_CLOB_API_URL,
    DEFAULT_CLOB_WS_URL,
    POLYMARKET_SERVICE_NAME,
)
from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import (
    ClobClientProvider,
    get_clob_client,
    get_authenticated_clob_client,
)
from elizaos_plugin_polymarket.types import (
    # Market types
    Token,
    Rewards,
    Market,
    SimplifiedMarket,
    MarketFilters,
    MarketsResponse,
    SimplifiedMarketsResponse,
    # Order types
    OrderSide,
    OrderType,
    OrderStatus,
    OrderParams,
    OrderResponse,
    OpenOrder,
    # Order book types
    BookEntry,
    OrderBook,
    # Trade types
    TradeStatus,
    Trade,
    TradeEntry,
    TradesResponse,
    # Position types
    Position,
    Balance,
    # API key types
    ApiKeyCreds,
    ApiKey,
    ApiKeyType,
    ApiKeyStatus,
    # Price types
    TokenPrice,
    PriceHistoryEntry,
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
    # Constants
    "POLYGON_CHAIN_ID",
    "POLYGON_CHAIN_NAME",
    "DEFAULT_CLOB_API_URL",
    "DEFAULT_CLOB_WS_URL",
    "POLYMARKET_SERVICE_NAME",
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
        ],
        "providers": [
            ClobClientProvider,
        ],
    }

