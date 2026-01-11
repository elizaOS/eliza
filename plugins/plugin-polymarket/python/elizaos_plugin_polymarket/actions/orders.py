"""
Order placement actions for Polymarket.
"""

from typing import Protocol

from py_clob_client.constants import SELL, BUY

from elizaos_plugin_polymarket.providers import get_authenticated_clob_client
from elizaos_plugin_polymarket.types import (
    OrderParams,
    OrderResponse,
    OrderSide,
    OrderType,
)
from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


async def place_order(
    params: OrderParams,
    runtime: RuntimeProtocol | None = None,
) -> OrderResponse:
    """
    Place an order on Polymarket.

    Args:
        params: Order parameters
        runtime: Optional agent runtime for settings

    Returns:
        Order response from API

    Raises:
        PolymarketError: If order placement fails
    """
    # Validate parameters
    if not params.token_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "Token ID is required",
        )

    if params.price <= 0 or params.price > 1:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "Price must be between 0 and 1",
        )

    if params.size <= 0:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "Size must be positive",
        )

    try:
        client = get_authenticated_clob_client(runtime)

        # Convert side to py_clob_client format
        side = BUY if params.side == OrderSide.BUY else SELL

        # Create order arguments
        order_args = {
            "token_id": params.token_id,
            "price": params.price,
            "size": params.size,
            "side": side,
            "fee_rate_bps": int(params.fee_rate_bps) if params.fee_rate_bps else 0,
        }

        # Create the signed order
        try:
            signed_order = client.create_order(order_args)
        except Exception as e:
            error_msg = str(e)
            if "minimum_tick_size" in error_msg:
                raise PolymarketError(
                    PolymarketErrorCode.INVALID_MARKET,
                    "Invalid market data: The market may not exist or be inactive",
                    cause=e,
                ) from e
            raise PolymarketError(
                PolymarketErrorCode.INVALID_ORDER,
                f"Failed to create order: {e}",
                cause=e,
            ) from e

        # Post the order
        try:
            order_type = params.order_type.value if params.order_type else OrderType.GTC.value
            response = client.post_order(signed_order, order_type=order_type)
        except Exception as e:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                f"Failed to submit order: {e}",
                cause=e,
            ) from e

        return OrderResponse(
            success=response.get("success", False),
            error_msg=response.get("errorMsg"),
            order_id=response.get("orderId"),
            order_hashes=response.get("orderHashes"),
            status=response.get("status"),
        )

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Order placement failed: {e}",
            cause=e,
        ) from e


async def cancel_order(
    order_id: str,
    runtime: RuntimeProtocol | None = None,
) -> bool:
    """
    Cancel an existing order.

    Args:
        order_id: The order ID to cancel
        runtime: Optional agent runtime for settings

    Returns:
        True if cancellation succeeded

    Raises:
        PolymarketError: If cancellation fails
    """
    if not order_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "Order ID is required",
        )

    try:
        client = get_authenticated_clob_client(runtime)
        response = client.cancel(order_id)
        return response.get("success", False)
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to cancel order: {e}",
            cause=e,
        ) from e


async def get_open_orders(
    market_id: str | None = None,
    asset_id: str | None = None,
    runtime: RuntimeProtocol | None = None,
) -> list[dict]:
    """
    Get open orders for the user.

    Args:
        market_id: Optional market condition ID filter
        asset_id: Optional asset ID filter
        runtime: Optional agent runtime for settings

    Returns:
        List of open orders

    Raises:
        PolymarketError: If fetching orders fails
    """
    try:
        client = get_authenticated_clob_client(runtime)

        params = {}
        if market_id:
            params["market"] = market_id
        if asset_id:
            params["asset_id"] = asset_id

        response = client.get_orders(**params) if params else client.get_orders()
        return response.get("data", [])
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch open orders: {e}",
            cause=e,
        ) from e


async def get_order_details(
    order_id: str,
    runtime: RuntimeProtocol | None = None,
) -> dict:
    """
    Get details for a specific order.

    Args:
        order_id: The order ID
        runtime: Optional agent runtime for settings

    Returns:
        Order details

    Raises:
        PolymarketError: If fetching order fails
    """
    if not order_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "Order ID is required",
        )

    try:
        client = get_authenticated_clob_client(runtime)
        response = client.get_order(order_id)
        return response
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch order details: {e}",
            cause=e,
        ) from e


