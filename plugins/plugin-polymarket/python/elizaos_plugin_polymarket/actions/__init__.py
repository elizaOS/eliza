"""
Polymarket actions module.

This module provides action functions for interacting with Polymarket,
mirroring the functionality available in the TypeScript and Rust implementations.
"""

from elizaos_plugin_polymarket.actions.account import (
    get_account_access_status,
    handle_authentication,
)
from elizaos_plugin_polymarket.actions.api_keys import (
    create_api_key,
    get_all_api_keys,
    revoke_api_key,
)
from elizaos_plugin_polymarket.actions.markets import (
    get_clob_markets,
    get_market_details,
    get_markets,
    get_open_markets,
    get_sampling_markets,
    get_simplified_markets,
    retrieve_all_markets,
)
from elizaos_plugin_polymarket.actions.orderbook import (
    get_best_price,
    get_midpoint_price,
    get_order_book,
    get_order_book_depth,
    get_order_book_summary,
    get_spread,
)
from elizaos_plugin_polymarket.actions.orders import (
    cancel_order,
    get_open_orders,
    get_order_details,
    place_order,
)
from elizaos_plugin_polymarket.actions.realtime import (
    handle_realtime_updates,
    setup_websocket,
)
from elizaos_plugin_polymarket.actions.trading import (
    check_order_scoring,
    get_active_orders,
    get_price_history,
    get_trade_history,
)

__all__ = [
    # Market actions
    "get_markets",
    "get_simplified_markets",
    "get_market_details",
    "get_sampling_markets",
    "get_open_markets",
    "get_clob_markets",
    "retrieve_all_markets",
    # Order book actions
    "get_order_book",
    "get_order_book_depth",
    "get_order_book_summary",
    "get_best_price",
    "get_midpoint_price",
    "get_spread",
    # Order actions
    "place_order",
    "cancel_order",
    "get_open_orders",
    "get_order_details",
    # Trading actions
    "check_order_scoring",
    "get_active_orders",
    "get_trade_history",
    "get_price_history",
    # API key management
    "create_api_key",
    "get_all_api_keys",
    "revoke_api_key",
    # Account actions
    "get_account_access_status",
    "handle_authentication",
    # Real-time actions
    "setup_websocket",
    "handle_realtime_updates",
]
