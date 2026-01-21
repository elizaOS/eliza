"""
Order placement actions for Polymarket.
"""

from collections.abc import Callable
from typing import Protocol, cast

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_authenticated_clob_client
from elizaos_plugin_polymarket.types import (
    OrderParams,
    OrderResponse,
    OrderType,
)


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

        # Use the side value expected by the CLOB client ("BUY" / "SELL")
        side = params.side.value

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
            create_order = cast(object, getattr(client, "create_order", None))
            if not callable(create_order):
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    "CLOB client missing create_order method",
                )
            signed_order = cast(Callable[[dict[str, object]], object], create_order)(order_args)
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
            post_order = cast(object, getattr(client, "post_order", None))
            if not callable(post_order):
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    "CLOB client missing post_order method",
                )
            response_obj = cast(Callable[..., object], post_order)(
                signed_order,
                order_type=order_type,
            )
            response: dict[str, object] = response_obj if isinstance(response_obj, dict) else {}
        except Exception as e:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                f"Failed to submit order: {e}",
                cause=e,
            ) from e

        return OrderResponse(
            success=bool(response.get("success", False)),
            error_msg=str(response.get("errorMsg")) if response.get("errorMsg") else None,
            order_id=str(response.get("orderId")) if response.get("orderId") else None,
            order_hashes=(
                [str(x) for x in order_hashes_obj]
                if isinstance((order_hashes_obj := response.get("orderHashes")), list)
                else None
            ),
            status=str(response.get("status")) if response.get("status") else None,
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
        cancel_fn = cast(object, getattr(client, "cancel", None))
        if not callable(cancel_fn):
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "CLOB client missing cancel method",
            )
        response_obj = cast(Callable[[str], object], cancel_fn)(order_id)
        if isinstance(response_obj, dict):
            return bool(response_obj.get("success", False))
        return True
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
) -> list[dict[str, object]]:
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

        params: dict[str, str] = {}
        if market_id:
            params["market"] = market_id
        if asset_id:
            params["asset_id"] = asset_id

        get_orders = cast(object, getattr(client, "get_orders", None))
        if not callable(get_orders):
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "CLOB client missing get_orders method",
            )

        response_obj = (
            cast(Callable[..., object], get_orders)(**params)
            if params
            else cast(Callable[..., object], get_orders)()
        )

        if not isinstance(response_obj, dict):
            return []
        data_obj = response_obj.get("data", [])
        if not isinstance(data_obj, list):
            return []
        return [item for item in data_obj if isinstance(item, dict)]
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
) -> dict[str, object]:
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
        get_order = cast(object, getattr(client, "get_order", None))
        if not callable(get_order):
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "CLOB client missing get_order method",
            )
        response_obj = cast(Callable[[str], object], get_order)(order_id)
        return response_obj if isinstance(response_obj, dict) else {}
    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch order details: {e}",
            cause=e,
        ) from e
