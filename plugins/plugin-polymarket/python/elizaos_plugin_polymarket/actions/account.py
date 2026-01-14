"""
Account and authentication actions for Polymarket.
"""

import os
from typing import Protocol

from eth_account import Account

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.types import ApiKey


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...

    def set_setting(self, key: str, value: str, secret: bool = False) -> None:
        """Set a setting value."""
        ...


async def get_account_access_status(
    runtime: RuntimeProtocol | None = None,
) -> dict[str, object]:
    """
    Get account access status, including U.S. certification requirements and API key details.

    Args:
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary with account access status information

    Raises:
        PolymarketError: If fetching status fails
    """
    try:
        api_keys_list: list[ApiKey] = []
        api_keys_error: str | None = None
        cert_required: bool | None = None

        # Check if API credentials are configured
        clob_api_key = (
            runtime.get_setting("CLOB_API_KEY") if runtime else os.environ.get("CLOB_API_KEY")
        )
        clob_api_secret = (
            runtime.get_setting("CLOB_API_SECRET") if runtime else os.environ.get("CLOB_API_SECRET")
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

        has_configured_credentials = bool(clob_api_key and clob_api_secret and clob_api_passphrase)

        if has_configured_credentials:
            try:
                # Import here to avoid circular dependency
                from elizaos_plugin_polymarket.actions import api_keys

                api_keys_list = await api_keys.get_all_api_keys(runtime)
            except Exception as e:
                api_keys_error = str(e)

        # Get session API key info if available
        session_api_key_id = (
            runtime.get_setting("POLYMARKET_SESSION_API_KEY_ID")
            if runtime
            else os.environ.get("POLYMARKET_SESSION_API_KEY_ID")
        )
        session_api_label = (
            runtime.get_setting("POLYMARKET_SESSION_API_LABEL")
            if runtime
            else os.environ.get("POLYMARKET_SESSION_API_LABEL")
        )

        return {
            "cert_required": cert_required,
            "managed_api_keys": api_keys_list,
            "managed_api_keys_count": len(api_keys_list),
            "api_keys_error": api_keys_error,
            "has_configured_credentials": has_configured_credentials,
            "active_session_key_id": session_api_key_id,
            "active_session_label": session_api_label,
        }

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch account access status: {e}",
            cause=e,
        ) from e


async def handle_authentication(
    runtime: RuntimeProtocol | None = None,
) -> dict[str, object]:
    """
    Check and display the current authentication status for Polymarket CLOB operations.

    Args:
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary with authentication status information

    Raises:
        PolymarketError: If checking authentication fails
    """
    try:
        import os

        private_key_setting = (
            (
                runtime.get_setting("POLYMARKET_PRIVATE_KEY")
                if runtime
                else os.environ.get("POLYMARKET_PRIVATE_KEY")
            )
            or (
                runtime.get_setting("WALLET_PRIVATE_KEY")
                if runtime
                else os.environ.get("WALLET_PRIVATE_KEY")
            )
            or (runtime.get_setting("PRIVATE_KEY") if runtime else os.environ.get("PRIVATE_KEY"))
        )

        clob_api_key = (
            runtime.get_setting("CLOB_API_KEY") if runtime else os.environ.get("CLOB_API_KEY")
        )
        clob_api_secret = (
            runtime.get_setting("CLOB_API_SECRET") if runtime else os.environ.get("CLOB_API_SECRET")
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
        clob_api_url = (
            runtime.get_setting("CLOB_API_URL") if runtime else os.environ.get("CLOB_API_URL")
        )

        wallet_address: str | None = None
        if private_key_setting:
            private_key = (
                private_key_setting
                if private_key_setting.startswith("0x")
                else f"0x{private_key_setting}"
            )
            account = Account.from_key(private_key)
            wallet_address = account.address

        has_private_key = bool(private_key_setting)
        has_api_key = bool(clob_api_key)
        has_api_secret = bool(clob_api_secret)
        has_api_passphrase = bool(clob_api_passphrase)
        is_fully_authenticated = bool(
            has_private_key and has_api_key and has_api_secret and has_api_passphrase
        )
        can_read_markets = bool(clob_api_url)
        can_trade = is_fully_authenticated

        return {
            "has_private_key": has_private_key,
            "has_api_key": has_api_key,
            "has_api_secret": has_api_secret,
            "has_api_passphrase": has_api_passphrase,
            "wallet_address": wallet_address,
            "is_fully_authenticated": is_fully_authenticated,
            "can_read_markets": can_read_markets,
            "can_trade": can_trade,
        }

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to check authentication status: {e}",
            cause=e,
        ) from e
