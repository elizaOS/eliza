"""
CLOB Client provider for Polymarket.

Provides CLOB client initialization and management using the official
py-clob-client library.
"""

import os
from typing import Protocol

from eth_account import Account
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

from elizaos_plugin_polymarket.constants import (
    DEFAULT_CLOB_API_URL,
    POLYGON_CHAIN_ID,
)
from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...


class ClobClientProvider:
    """Provider for CLOB client instances."""

    def __init__(self, runtime: RuntimeProtocol | None = None) -> None:
        """
        Initialize the CLOB client provider.

        Args:
            runtime: Optional agent runtime for settings
        """
        self._runtime = runtime
        self._client: ClobClient | None = None
        self._authenticated_client: ClobClient | None = None
        self._wallet_address: str | None = None

    def _get_setting(self, key: str) -> str | None:
        """Get a setting from runtime or environment."""
        if self._runtime:
            value = self._runtime.get_setting(key)
            if value:
                return value
        return os.environ.get(key)

    def _get_private_key(self) -> str:
        """Get the private key from settings."""
        private_key = (
            self._get_setting("POLYMARKET_PRIVATE_KEY")
            or self._get_setting("EVM_PRIVATE_KEY")
            or self._get_setting("WALLET_PRIVATE_KEY")
            or self._get_setting("PRIVATE_KEY")
        )

        if not private_key:
            raise PolymarketError(
                PolymarketErrorCode.CONFIG_ERROR,
                "No private key found. Please set POLYMARKET_PRIVATE_KEY, "
                "EVM_PRIVATE_KEY, or WALLET_PRIVATE_KEY",
            )

        # Ensure it has 0x prefix
        if not private_key.startswith("0x"):
            private_key = f"0x{private_key}"

        return private_key

    def get_wallet_address(self) -> str:
        """Get the wallet address derived from private key."""
        if self._wallet_address:
            return self._wallet_address

        private_key = self._get_private_key()
        account = Account.from_key(private_key)
        self._wallet_address = account.address
        return self._wallet_address

    def get_client(self) -> ClobClient:
        """
        Get or create a basic CLOB client for read operations.

        Returns:
            Configured ClobClient instance

        Raises:
            PolymarketError: If client initialization fails
        """
        if self._client:
            return self._client

        clob_api_url = self._get_setting("CLOB_API_URL") or DEFAULT_CLOB_API_URL
        private_key = self._get_private_key()

        try:
            self._client = ClobClient(
                host=clob_api_url,
                chain_id=POLYGON_CHAIN_ID,
                key=private_key,
            )
            return self._client
        except Exception as e:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                f"Failed to initialize CLOB client: {e}",
                cause=e,
            ) from e

    def get_authenticated_client(self) -> ClobClient:
        """
        Get or create an authenticated CLOB client for trading operations.

        Returns:
            Configured ClobClient instance with API credentials

        Raises:
            PolymarketError: If client initialization fails or credentials missing
        """
        if self._authenticated_client:
            return self._authenticated_client

        clob_api_url = self._get_setting("CLOB_API_URL") or DEFAULT_CLOB_API_URL
        private_key = self._get_private_key()

        api_key = self._get_setting("CLOB_API_KEY")
        api_secret = self._get_setting("CLOB_API_SECRET") or self._get_setting("CLOB_SECRET")
        api_passphrase = self._get_setting("CLOB_API_PASSPHRASE") or self._get_setting(
            "CLOB_PASS_PHRASE"
        )

        if not api_key or not api_secret or not api_passphrase:
            missing = []
            if not api_key:
                missing.append("CLOB_API_KEY")
            if not api_secret:
                missing.append("CLOB_API_SECRET")
            if not api_passphrase:
                missing.append("CLOB_API_PASSPHRASE")

            raise PolymarketError(
                PolymarketErrorCode.AUTH_ERROR,
                f"Missing required API credentials: {', '.join(missing)}",
            )

        try:
            creds = ApiCreds(
                api_key=api_key,
                api_secret=api_secret,
                api_passphrase=api_passphrase,
            )

            self._authenticated_client = ClobClient(
                host=clob_api_url,
                chain_id=POLYGON_CHAIN_ID,
                key=private_key,
                creds=creds,
            )
            return self._authenticated_client
        except Exception as e:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                f"Failed to initialize authenticated CLOB client: {e}",
                cause=e,
            ) from e

    def has_credentials(self) -> bool:
        """Check if API credentials are available."""
        api_key = self._get_setting("CLOB_API_KEY")
        api_secret = self._get_setting("CLOB_API_SECRET") or self._get_setting("CLOB_SECRET")
        api_passphrase = self._get_setting("CLOB_API_PASSPHRASE") or self._get_setting(
            "CLOB_PASS_PHRASE"
        )
        return bool(api_key and api_secret and api_passphrase)


# Module-level convenience functions
_default_provider: ClobClientProvider | None = None


def get_clob_client(runtime: RuntimeProtocol | None = None) -> ClobClient:
    """
    Get a CLOB client instance.

    Args:
        runtime: Optional agent runtime for settings

    Returns:
        Configured ClobClient instance
    """
    global _default_provider
    if runtime or _default_provider is None:
        _default_provider = ClobClientProvider(runtime)
    return _default_provider.get_client()


def get_authenticated_clob_client(runtime: RuntimeProtocol | None = None) -> ClobClient:
    """
    Get an authenticated CLOB client instance.

    Args:
        runtime: Optional agent runtime for settings

    Returns:
        Configured ClobClient instance with API credentials
    """
    global _default_provider
    if runtime or _default_provider is None:
        _default_provider = ClobClientProvider(runtime)
    return _default_provider.get_authenticated_client()





