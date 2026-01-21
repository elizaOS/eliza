"""
API key management actions for Polymarket.
"""

import base64
import hashlib
import hmac
import time
from typing import Protocol, cast

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data

from elizaos_plugin_polymarket.error import PolymarketError, PolymarketErrorCode
from elizaos_plugin_polymarket.types import ApiKey, ApiKeyStatus, ApiKeyType


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime."""

    def get_setting(self, key: str) -> str | None:
        """Get a setting value."""
        ...

    def set_setting(self, key: str, value: str, secret: bool = False) -> None:
        """Set a setting value."""
        ...


def _hmac_signature(
    *,
    secret: str,
    method: str,
    path: str,
    body: str,
    timestamp_ms: int,
) -> str:
    """
    L2 signature: base64(HMAC_SHA256(secret, f"{METHOD} {path} {body} {timestamp_ms}")).
    """
    to_sign = f"{method.upper()} {path} {body} {timestamp_ms}".encode()
    mac = hmac.new(secret.encode("utf-8"), to_sign, hashlib.sha256).digest()
    return base64.b64encode(mac).decode("utf-8")


def _get_setting(runtime: RuntimeProtocol | None, key: str) -> str | None:
    import os

    if runtime is not None:
        return runtime.get_setting(key)
    return os.environ.get(key)


def _require_private_key(runtime: RuntimeProtocol | None) -> str:
    private_key_setting = (
        _get_setting(runtime, "POLYMARKET_PRIVATE_KEY")
        or _get_setting(runtime, "WALLET_PRIVATE_KEY")
        or _get_setting(runtime, "PRIVATE_KEY")
    )
    if not private_key_setting:
        raise PolymarketError(
            PolymarketErrorCode.CONFIG_ERROR,
            "No private key found. Please set POLYMARKET_PRIVATE_KEY, WALLET_PRIVATE_KEY, or PRIVATE_KEY",
        )
    return (
        private_key_setting if private_key_setting.startswith("0x") else f"0x{private_key_setting}"
    )


def _extract_api_creds(api_creds: dict[str, object]) -> tuple[str, str, str]:
    api_key_id_obj = (
        api_creds.get("api_key")
        or api_creds.get("key")
        or api_creds.get("id")
        or api_creds.get("apiKey")
        or api_creds.get("API_KEY")
    )
    api_secret_obj = (
        api_creds.get("api_secret")
        or api_creds.get("secret")
        or api_creds.get("apiSecret")
        or api_creds.get("API_SECRET")
    )
    api_passphrase_obj = (
        api_creds.get("api_passphrase")
        or api_creds.get("passphrase")
        or api_creds.get("apiPassphrase")
        or api_creds.get("API_PASSPHRASE")
    )

    api_key_id = str(api_key_id_obj) if api_key_id_obj else ""
    api_secret = str(api_secret_obj) if api_secret_obj else ""
    api_passphrase = str(api_passphrase_obj) if api_passphrase_obj else ""
    if not api_key_id or not api_secret or not api_passphrase:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            "Failed to obtain complete API credentials from response",
        )
    return api_key_id, api_secret, api_passphrase


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

    try:
        clob_api_url = _get_setting(runtime, "CLOB_API_URL") or "https://clob.polymarket.com"
        private_key = _require_private_key(runtime)

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

        structured_msg = encode_typed_data(full_message=typed_data)
        signed_message = account.sign_message(structured_msg)
        signature = signed_message.signature.hex()

        headers = {
            "Content-Type": "application/json",
            "POLY_ADDRESS": address,
            "POLY_SIGNATURE": signature,
            "POLY_TIMESTAMP": timestamp,
            "POLY_NONCE": str(nonce),
        }

        api_creds: dict[str, object]
        is_new_key = False

        async with httpx.AsyncClient(timeout=30.0) as client:
            derive = await client.get(f"{clob_api_url}/auth/derive-api-key", headers=headers)
            if derive.status_code == 200:
                api_creds = cast(dict[str, object], derive.json())
            elif derive.status_code in (400, 401, 403, 404):
                is_new_key = True
                create = await client.post(f"{clob_api_url}/auth/api-key", headers=headers, json={})
                if create.status_code != 200:
                    raise PolymarketError(
                        PolymarketErrorCode.API_ERROR,
                        f"API key creation failed: {create.status_code}. {create.text}",
                    )
                api_creds = cast(dict[str, object], create.json())
            else:
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    f"API key derivation failed: {derive.status_code}. {derive.text}",
                )

        api_key_id, api_secret, api_passphrase = _extract_api_creds(api_creds)

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
        clob_api_url = _get_setting(runtime, "CLOB_API_URL") or "https://clob.polymarket.com"
        private_key = _require_private_key(runtime)
        address = Account.from_key(private_key).address

        api_key = _get_setting(runtime, "CLOB_API_KEY")
        api_secret = _get_setting(runtime, "CLOB_API_SECRET") or _get_setting(
            runtime, "CLOB_SECRET"
        )
        api_passphrase = _get_setting(runtime, "CLOB_API_PASSPHRASE") or _get_setting(
            runtime, "CLOB_PASS_PHRASE"
        )
        if not api_key or not api_secret or not api_passphrase:
            raise PolymarketError(
                PolymarketErrorCode.AUTH_ERROR,
                "API credentials required for listing API keys",
            )

        path = "/auth/api-keys"
        timestamp_ms = int(time.time() * 1000)
        signature = _hmac_signature(
            secret=api_secret, method="GET", path=path, body="", timestamp_ms=timestamp_ms
        )

        headers = {
            "Content-Type": "application/json",
            "POLY_ADDRESS": address,
            "POLY_SIGNATURE": signature,
            "POLY_TIMESTAMP": str(timestamp_ms),
            "POLY_API_KEY": api_key,
            "POLY_PASSPHRASE": api_passphrase,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{clob_api_url}{path}", headers=headers)
            if resp.status_code != 200:
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    f"Failed to fetch API keys: {resp.status_code}. {resp.text}",
                )
            obj = resp.json()
            api_keys_obj = obj.get("apiKeys") if isinstance(obj, dict) else None
            api_keys_list = api_keys_obj if isinstance(api_keys_obj, list) else []

        keys: list[ApiKey] = []
        for idx, cred in enumerate(api_keys_list):
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
        clob_api_url = _get_setting(runtime, "CLOB_API_URL") or "https://clob.polymarket.com"
        private_key = _require_private_key(runtime)
        address = Account.from_key(private_key).address

        api_key = _get_setting(runtime, "CLOB_API_KEY")
        api_secret = _get_setting(runtime, "CLOB_API_SECRET") or _get_setting(
            runtime, "CLOB_SECRET"
        )
        api_passphrase = _get_setting(runtime, "CLOB_API_PASSPHRASE") or _get_setting(
            runtime, "CLOB_PASS_PHRASE"
        )
        if not api_key or not api_secret or not api_passphrase:
            raise PolymarketError(
                PolymarketErrorCode.AUTH_ERROR,
                "API credentials required for revoking API keys",
            )

        path = "/auth/api-key"
        query = f"apiKeyId={key_id}"
        full_path = f"{path}?{query}"
        timestamp_ms = int(time.time() * 1000)
        signature = _hmac_signature(
            secret=api_secret, method="DELETE", path=full_path, body="", timestamp_ms=timestamp_ms
        )

        headers = {
            "Content-Type": "application/json",
            "POLY_ADDRESS": address,
            "POLY_SIGNATURE": signature,
            "POLY_TIMESTAMP": str(timestamp_ms),
            "POLY_API_KEY": api_key,
            "POLY_PASSPHRASE": api_passphrase,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.delete(
                f"{clob_api_url}{path}", params={"apiKeyId": key_id}, headers=headers
            )
            if resp.status_code != 200:
                raise PolymarketError(
                    PolymarketErrorCode.API_ERROR,
                    f"Failed to revoke API key: {resp.status_code}. {resp.text}",
                )
        return True

    except PolymarketError:
        raise
    except Exception as e:
        raise PolymarketError(
            PolymarketErrorCode.API_ERROR,
            f"Failed to revoke API key: {e}",
            cause=e,
        ) from e
