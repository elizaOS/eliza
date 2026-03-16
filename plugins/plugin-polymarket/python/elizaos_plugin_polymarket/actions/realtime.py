"""
Real-time WebSocket actions for Polymarket.
"""

import os
from typing import Protocol

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


async def setup_websocket(
    channels: list[str] | None = None,
    asset_ids: list[str] | None = None,
    authenticated: bool = False,
    runtime: RuntimeProtocol | None = None,
) -> dict[str, object]:
    """
    Setup and configure WebSocket connections for real-time data.

    Args:
        channels: List of channels to subscribe to (e.g., ['book', 'price', 'trade'])
        asset_ids: List of asset IDs to subscribe to
        authenticated: Whether to use authenticated WebSocket connection
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary with WebSocket configuration

    Raises:
        PolymarketError: If WebSocket setup fails
    """
    try:
        clob_ws_url = (
            runtime.get_setting("CLOB_WS_URL") if runtime else os.environ.get("CLOB_WS_URL")
        ) or (runtime.get_setting("CLOB_API_URL") if runtime else os.environ.get("CLOB_API_URL"))

        if not clob_ws_url:
            raise PolymarketError(
                PolymarketErrorCode.CONFIG_ERROR,
                "CLOB_WS_URL or CLOB_API_URL is required for WebSocket connections",
            )

        # Convert HTTP URL to WebSocket URL if needed
        if clob_ws_url.startswith("http://"):
            ws_url = clob_ws_url.replace("http://", "ws://")
        elif clob_ws_url.startswith("https://"):
            ws_url = clob_ws_url.replace("https://", "wss://")
        elif not clob_ws_url.startswith(("ws://", "wss://")):
            ws_url = f"wss://{clob_ws_url}"
        else:
            ws_url = clob_ws_url

        default_channels = channels or ["book", "price"]
        asset_ids_list = asset_ids or []

        # Check if authenticated credentials are available
        has_credentials = False
        if authenticated:
            clob_api_key = (
                runtime.get_setting("CLOB_API_KEY") if runtime else os.environ.get("CLOB_API_KEY")
            )
            clob_api_secret = (
                runtime.get_setting("CLOB_API_SECRET")
                if runtime
                else os.environ.get("CLOB_API_SECRET")
            ) or (runtime.get_setting("CLOB_SECRET") if runtime else os.environ.get("CLOB_SECRET"))
            clob_api_passphrase = (
                runtime.get_setting("CLOB_API_PASSPHRASE")
                if runtime
                else os.environ.get("CLOB_API_PASSPHRASE")
            ) or (
                runtime.get_setting("CLOB_PASS_PHRASE")
                if runtime
                else os.environ.get("CLOB_PASS_PHRASE")
            )
            has_credentials = bool(clob_api_key and clob_api_secret and clob_api_passphrase)

        return {
            "url": ws_url,
            "channels": default_channels,
            "asset_ids": asset_ids_list,
            "authenticated": authenticated and has_credentials,
            "status": "disconnected",  # Would be 'connected' if service is running
            "has_credentials": has_credentials,
        }

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.WEBSOCKET_ERROR,
            f"Failed to setup WebSocket: {e}",
            cause=e,
        ) from e


async def handle_realtime_updates(
    action: str = "status",
    channel: str | None = None,
    asset_ids: list[str] | None = None,
    runtime: RuntimeProtocol | None = None,
) -> dict[str, object]:
    """
    Handle real-time WebSocket updates (subscribe/unsubscribe/status).

    Args:
        action: Action to perform ('subscribe', 'unsubscribe', or 'status')
        channel: Channel name (e.g., 'price', 'book', 'trade')
        asset_ids: List of asset IDs for subscription
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary with subscription status

    Raises:
        PolymarketError: If handling updates fails
    """
    try:
        clob_ws_url = (
            runtime.get_setting("CLOB_WS_URL") if runtime else os.environ.get("CLOB_WS_URL")
        ) or (runtime.get_setting("CLOB_API_URL") if runtime else os.environ.get("CLOB_API_URL"))

        if not clob_ws_url:
            raise PolymarketError(
                PolymarketErrorCode.CONFIG_ERROR,
                "CLOB_WS_URL or CLOB_API_URL is required for WebSocket connections",
            )

        # Available channels
        available_channels = {
            "price": "Real-time price updates",
            "book": "Order book changes",
            "trade": "Trade executions",
            "ticker": "Market ticker updates",
            "user": "Authenticated user updates (orders, fills)",
        }

        if action == "status":
            return {
                "ws_url": clob_ws_url,
                "available_channels": available_channels,
                "subscriptions": [],  # Would contain active subscriptions if service is running
                "status": "disconnected",  # Would be 'connected' if service is running
            }
        elif action == "subscribe":
            if not channel:
                raise PolymarketError(
                    PolymarketErrorCode.WEBSOCKET_ERROR,
                    "Channel is required for subscription",
                )
            if channel not in available_channels:
                raise PolymarketError(
                    PolymarketErrorCode.WEBSOCKET_ERROR,
                    f"Invalid channel: {channel}. Available: {', '.join(available_channels.keys())}",
                )
            if not asset_ids:
                raise PolymarketError(
                    PolymarketErrorCode.WEBSOCKET_ERROR,
                    "At least one asset ID is required for subscription",
                )

            return {
                "action": "subscribe",
                "channel": channel,
                "asset_ids": asset_ids,
                "status": "pending",  # Would be 'active' if service is running
            }
        elif action == "unsubscribe":
            if not channel:
                raise PolymarketError(
                    PolymarketErrorCode.WEBSOCKET_ERROR,
                    "Channel is required for unsubscription",
                )

            return {
                "action": "unsubscribe",
                "channel": channel,
                "asset_ids": asset_ids,
                "status": "pending",  # Would be 'unsubscribed' if service is running
            }
        else:
            raise PolymarketError(
                PolymarketErrorCode.WEBSOCKET_ERROR,
                f"Invalid action: {action}. Must be 'subscribe', 'unsubscribe', or 'status'",
            )

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.WEBSOCKET_ERROR,
            f"Failed to handle realtime updates: {e}",
            cause=e,
        ) from e
