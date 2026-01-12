"""
API key management actions for Polymarket.
"""

import time
from typing import Protocol

from eth_account import Account
from eth_account.messages import encode_defunct, encode_typed_data

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_authenticated_clob_client
from elizaos_plugin_polymarket.types import ApiKey


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...

    def set_setting(self, key: str, value: str, secret: bool = False) -> None:
        """Set a setting value."""
        ...


async def create_api_key(
    runtime: RuntimeProtocol | None = None,
) -> dict[str, str]:
    """
    Create API key credentials for Polymarket CLOB authentication.

    Args:
        runtime: Optional agent runtime for settings

    Returns:
        Dictionary with api_key, secret, and passphrase

    Raises:
        PolymarketError: If API key creation fails
    """
    import os

    try:
        # Get settings
        clob_api_url = (
            runtime.get_setting("CLOB_API_URL") if runtime else os.environ.get("CLOB_API_URL")
        ) or "https://clob.polymarket.com"

        private_key_setting = (
            runtime.get_setting("POLYMARKET_PRIVATE_KEY")
            if runtime
            else os.environ.get("POLYMARKET_PRIVATE_KEY")
        ) or (
            runtime.get_setting("WALLET_PRIVATE_KEY")
            if runtime
            else os.environ.get("WALLET_PRIVATE_KEY")
        ) or (
            runtime.get_setting("PRIVATE_KEY") if runtime else os.environ.get("PRIVATE_KEY")
        )

        if not private_key_setting:
            raise PolymarketError(
                PolymarketErrorCode.CONFIG_ERROR,
                "No private key found. Please set POLYMARKET_PRIVATE_KEY, "
                "WALLET_PRIVATE_KEY, or PRIVATE_KEY",
            )

        # Ensure 0x prefix
        private_key = (
            private_key_setting if private_key_setting.startswith("0x") else f"0x{private_key_setting}"
        )

        # Get wallet address
        account = Account.from_key(private_key)
        address = account.address

        # Create signature for authentication using EIP-712
        timestamp = str(int(time.time()))
        nonce = 0
        message_text = "This message attests that I control the given wallet"

        # Create typed data signature (EIP-712)
        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                ],
                "ClobAuth": [
                    {"name": "address", "type": "address"},
                    {"name": "timestamp", "type": "string"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "message", "type": "string"},
                ],
            },
            "primaryType": "ClobAuth",
            "domain": {
                "name": "ClobAuthDomain",
                "version": "1",
                "chainId": 137,  # Polygon
            },
            "message": {
                "address": address,
                "timestamp": timestamp,
                "nonce": nonce,
                "message": message_text,
            },
        }

        # Sign typed data using eth_account (EIP-712)
        try:
            structured_msg = encode_typed_data(full_message=typed_data)
            signed_message = account.sign_message(structured_msg)
            signature = signed_message.signature.hex()
        except Exception:
            # Fallback to simple message signing if structured data fails
            # This is a simplified approach - in production, proper EIP-712 should be used
            signed_message = account.sign_message(encode_defunct(text=message_text))
            signature = signed_message.signature.hex()

        # Try to derive existing API key first
        try:
            import httpx

            http_client = httpx
        except ImportError:
            import requests

            http_client = requests

        is_new_key = False
        try:
            if hasattr(http_client, "get"):
                # httpx
                derive_response = http_client.get(
                    f"{clob_api_url}/auth/derive-api-key",
                    headers={
                        "Content-Type": "application/json",
                        "POLY_ADDRESS": address,
                        "POLY_SIGNATURE": signature,
                        "POLY_TIMESTAMP": timestamp,
                        "POLY_NONCE": str(nonce),
                    },
                    timeout=30.0,
                )
                if derive_response.status_code == 200:
                    api_creds = derive_response.json()
                else:
                    is_new_key = True
            else:
                # requests
                derive_response = http_client.get(
                    f"{clob_api_url}/auth/derive-api-key",
                    headers={
                        "Content-Type": "application/json",
                        "POLY_ADDRESS": address,
                        "POLY_SIGNATURE": signature,
                        "POLY_TIMESTAMP": timestamp,
                        "POLY_NONCE": str(nonce),
                    },
                    timeout=30.0,
                )
                if derive_response.status_code == 200:
                    api_creds = derive_response.json()
                else:
                    is_new_key = True
        except Exception:
            is_new_key = True

        if is_new_key:
            # Create new API key
            if hasattr(http_client, "post"):
                # httpx
                create_response = http_client.post(
                    f"{clob_api_url}/auth/api-key",
                    headers={
                        "Content-Type": "application/json",
                        "POLY_ADDRESS": address,
                        "POLY_SIGNATURE": signature,
                        "POLY_TIMESTAMP": timestamp,
                        "POLY_NONCE": str(nonce),
                    },
                    json={},
                    timeout=30.0,
                )
            else:
                # requests
                create_response = http_client.post(
                    f"{clob_api_url}/auth/api-key",
                    headers={
                        "Content-Type": "application/json",
                        "POLY_ADDRESS": address,
                        "POLY_SIGNATURE": signature,
                        "POLY_TIMESTAMP": timestamp,
                        "POLY_NONCE": str(nonce),
                    },
                    json={},
                    timeout=30.0,
                )

            if create_response.status_code != 200:
                error_text = getattr(create_response, "text", str(create_response.content))
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    f"API key creation failed: {create_response.status_code}. {error_text}",
                )

            api_creds = create_response.json()

        # Extract credentials from response (handle various response formats)
        api_key_id = (
            api_creds.get("api_key")
            or api_creds.get("key")
            or api_creds.get("id")
            or api_creds.get("apiKey")
            or api_creds.get("API_KEY")
            or ""
        )
        api_secret = (
            api_creds.get("api_secret")
            or api_creds.get("secret")
            or api_creds.get("apiSecret")
            or api_creds.get("API_SECRET")
            or ""
        )
        api_passphrase = (
            api_creds.get("api_passphrase")
            or api_creds.get("passphrase")
            or api_creds.get("apiPassphrase")
            or api_creds.get("API_PASSPHRASE")
            or ""
        )

        if not api_key_id or not api_secret or not api_passphrase:
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "Failed to obtain complete API credentials from response",
            )

        # Store credentials in runtime settings if available
        if runtime:
            runtime.set_setting("CLOB_API_KEY", api_key_id, secret=False)
            runtime.set_setting("CLOB_API_SECRET", api_secret, secret=True)
            runtime.set_setting("CLOB_API_PASSPHRASE", api_passphrase, secret=True)

        return {
            "api_key": api_key_id,
            "secret": api_secret,
            "passphrase": api_passphrase,
            "created_at": api_creds.get("created_at", ""),
            "is_new": is_new_key,
        }

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to create API key: {e}",
            cause=e,
        ) from e


async def get_all_api_keys(
    runtime: RuntimeProtocol | None = None,
) -> list[ApiKey]:
    """
    Get all API keys associated with the authenticated user's account.

    Args:
        runtime: Optional agent runtime for settings

    Returns:
        List of API keys

    Raises:
        PolymarketError: If fetching API keys fails
    """
    try:
        client = get_authenticated_clob_client(runtime)

        # Use the client's getApiKeys method if available
        # Note: py-clob-client may not have this method, so we'll need to check
        if hasattr(client, "getApiKeys"):
            response = client.getApiKeys()
            creds = response.get("apiKeys", []) if isinstance(response, dict) else response

            keys = []
            for idx, cred in enumerate(creds):
                if isinstance(cred, dict):
                    key_id = cred.get("key") or cred.get("api_key") or cred.get("id") or ""
                else:
                    key_id = str(cred)

                keys.append(
                    ApiKey(
                        key_id=key_id,
                        label=f"API Key {idx + 1}",
                        type="read_write",
                        status="active",
                        created_at="",
                        last_used_at=None,
                        is_cert_whitelisted=False,
                    )
                )

            return keys
        else:
            # Fallback: return empty list if method not available
            # In a real implementation, you might want to call the API directly
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                "getApiKeys method not available in CLOB client. "
                "Please use the Polymarket API directly or update py-clob-client.",
            )

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to fetch API keys: {e}",
            cause=e,
        ) from e


async def revoke_api_key(
    key_id: str,
    runtime: RuntimeProtocol | None = None,
) -> bool:
    """
    Revoke an existing API key from the user's account.

    Args:
        key_id: The API key ID to revoke
        runtime: Optional agent runtime for settings

    Returns:
        True if revocation succeeded

    Raises:
        PolymarketError: If revocation fails
    """
    if not key_id:
        raise PolymarketError(
            PolymarketErrorCode.INVALID_ORDER,
            "API Key ID is required",
        )

    try:
        client = get_authenticated_clob_client(runtime)

        # Check if the client has a deleteApiKey method
        if hasattr(client, "deleteApiKey"):
            result = client.deleteApiKey()
            return result.get("success", False) if isinstance(result, dict) else True
        else:
            # Fallback: provide guidance
            raise PolymarketError(
                PolymarketErrorCode.API_ERROR,
                f"deleteApiKey method not available in CLOB client. "
                f"To revoke API key {key_id}, please visit the Polymarket website "
                "or use the CLOB API directly: DELETE /auth/api-key",
            )

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to revoke API key: {e}",
            cause=e,
        ) from e
