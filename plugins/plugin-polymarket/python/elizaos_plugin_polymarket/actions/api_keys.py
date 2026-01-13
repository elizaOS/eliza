"""
API key management actions for Polymarket.
"""

import time
from collections.abc import Callable
from typing import Protocol, cast

from eth_account import Account
from eth_account.messages import encode_defunct, encode_typed_data

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.providers import get_authenticated_clob_client
from elizaos_plugin_polymarket.types import ApiKey, ApiKeyStatus, ApiKeyType


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
) -> dict[str, object]:
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

        if not private_key_setting:
            raise PolymarketError(
                PolymarketErrorCode.CONFIG_ERROR,
                "No private key found. Please set POLYMARKET_PRIVATE_KEY, "
                "WALLET_PRIVATE_KEY, or PRIVATE_KEY",
            )

        # Ensure 0x prefix
        private_key = (
            private_key_setting
            if private_key_setting.startswith("0x")
            else f"0x{private_key_setting}"
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
            import types

            import httpx

            http_client: types.ModuleType = httpx
        except ImportError:
            import types

            import requests

            http_client = requests

        is_new_key = False
        api_creds: dict[str, object] = {}
        try:
            get_fn = getattr(http_client, "get", None)
            if not callable(get_fn):
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    "HTTP client missing get()",
                )

            derive_response = cast(Callable[..., object], get_fn)(
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

            status_code_obj = getattr(derive_response, "status_code", None)
            if status_code_obj == 200:
                json_fn = getattr(derive_response, "json", None)
                if callable(json_fn):
                    json_obj = cast(Callable[[], object], json_fn)()
                    if isinstance(json_obj, dict):
                        api_creds = json_obj
                    else:
                        is_new_key = True
                else:
                    is_new_key = True
            else:
                is_new_key = True
        except Exception:
            is_new_key = True

        if is_new_key:
            # Create new API key
            post_fn = getattr(http_client, "post", None)
            if not callable(post_fn):
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    "HTTP client missing post()",
                )

            create_response = cast(Callable[..., object], post_fn)(
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

            status_code_obj = getattr(create_response, "status_code", None)
            if status_code_obj != 200:
                error_text_obj = getattr(create_response, "text", None)
                error_text = str(error_text_obj) if error_text_obj else ""
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    f"API key creation failed: {status_code_obj}. {error_text}",
                )

            json_fn = getattr(create_response, "json", None)
            if callable(json_fn):
                json_obj = cast(Callable[[], object], json_fn)()
                if isinstance(json_obj, dict):
                    api_creds = json_obj

        # Extract credentials from response (handle various response formats)
        api_key_id_obj = (
            api_creds.get("api_key")
            or api_creds.get("key")
            or api_creds.get("id")
            or api_creds.get("apiKey")
            or api_creds.get("API_KEY")
        )
        api_key_id = str(api_key_id_obj) if api_key_id_obj else ""

        api_secret_obj = (
            api_creds.get("api_secret")
            or api_creds.get("secret")
            or api_creds.get("apiSecret")
            or api_creds.get("API_SECRET")
        )
        api_secret = str(api_secret_obj) if api_secret_obj else ""

        api_passphrase_obj = (
            api_creds.get("api_passphrase")
            or api_creds.get("passphrase")
            or api_creds.get("apiPassphrase")
            or api_creds.get("API_PASSPHRASE")
        )
        api_passphrase = str(api_passphrase_obj) if api_passphrase_obj else ""

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

        created_at_obj = api_creds.get("created_at", "")
        return {
            "api_key": api_key_id,
            "secret": api_secret,
            "passphrase": api_passphrase,
            "created_at": str(created_at_obj) if created_at_obj else "",
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
        get_api_keys_fn = getattr(client, "getApiKeys", None)
        if callable(get_api_keys_fn):
            response_obj = cast(Callable[[], object], get_api_keys_fn)()
            creds_obj: object = (
                response_obj.get("apiKeys", [])
                if isinstance(response_obj, dict)
                else response_obj
            )
            creds = creds_obj if isinstance(creds_obj, list) else []

            keys = []
            for idx, cred in enumerate(creds):
                if isinstance(cred, dict):
                    key_id = cred.get("key") or cred.get("api_key") or cred.get("id") or ""
                else:
                    key_id = str(cred)

                keys.append(
                    ApiKey(
                        key_id=str(key_id) if key_id else "",
                        label=f"API Key {idx + 1}",
                        type=ApiKeyType.READ_WRITE,
                        status=ApiKeyStatus.ACTIVE,
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
        delete_api_key_fn = getattr(client, "deleteApiKey", None)
        if callable(delete_api_key_fn):
            fn = cast(Callable[..., object], delete_api_key_fn)
            try:
                result_obj = fn(key_id)
            except TypeError:
                result_obj = fn()

            if isinstance(result_obj, dict):
                return bool(result_obj.get("success", False))
            return True
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
